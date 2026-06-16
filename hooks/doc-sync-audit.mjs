// audience: internal
// # doc-sync-audit-hook
// 阻塞型 Stop hook：检查本回合是否存在"改了代码、但对应文件头块或相关文档未同步"的情况，
// 对应 CLAUDE.md 中"改动与其触发的文档更新进同一提交"这条规则。
// 取本回合完整 diff（含未跟踪文件内容）传给独立 claude，只判断文档与代码是否矛盾，
// 不评判正确性、风格或其它——只有存在矛盾时才阻断。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量二：git 失败或本回合无源码改动则直接放行，不启动 claude。
// 不变量三：审计器报错、超时或无法解析一律放行（fail-open），绝不因审计器坏掉而卡死会话。
// 不变量四：同一回合最多打断 MAX_BLOCKS 次，超出则放行并告警，防止阻断死循环。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planDimension } from "./lib/cleanaudit-bridge.mjs";

const MAX_BLOCKS = 1;    // 每个回合最多打断一次

// //// 输出 hook JSON 并按放行退出 [@380kkm 2026-06-15] ////
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}
// //// /输出 hook JSON 并按放行退出 ////

// //// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-15] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
// //// /防递归：嵌套 claude 进程直接放行 ////

// //// 读取 Stop hook 输入 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
const cwd = input.cwd || process.cwd();
// //// /读取 Stop hook 输入 ////

// //// 用 git 取本回合改动文件列表，无源码改动则放行 [@380kkm 2026-06-15] ////
// 源码扩展名白名单：排除纯文档、图片等，只关心代码改动
const SRC_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".json", ".yaml", ".yml", ".toml",
  ".html", ".css", ".scss", ".vue", ".svelte",
]);

function isSrcFile(p) {
  return SRC_EXTS.has(path.extname(p).toLowerCase());
}

// git diff --name-only HEAD 取已跟踪的改动文件
const diffNames = spawnSync("git", ["diff", "--name-only", "HEAD"], {
  cwd,
  encoding: "utf8",
  timeout: 10000,
});
// git 本身失败（非 git 仓库等）直接放行
if (diffNames.error || (diffNames.status !== 0 && diffNames.status !== 1)) allow();

const trackedChanged = (diffNames.stdout || "")
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

// git ls-files --others --exclude-standard 取未跟踪文件
const untrackedRes = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
  cwd,
  encoding: "utf8",
  timeout: 10000,
});
const untrackedFiles = (untrackedRes.status === 0 ? untrackedRes.stdout || "" : "")
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

const allChanged = [...new Set([...trackedChanged, ...untrackedFiles])];

// 只要有至少一个源码文件改动才继续；否则放行
const hasSrc = allChanged.some(isSrcFile);
if (!hasSrc) allow();

// //// cleanaudit 预过滤：源码与文档在同一回合均已改动则跳过，省去模型审核 [@380kkm 2026-06-16] ////
if (planDimension("doc-sync", cwd) === "skip") allow();
// //// /cleanaudit 预过滤 ////
// //// /用 git 取本回合改动文件列表，无源码改动则放行 ////

// //// 组装传给审计器的完整 diff [@380kkm 2026-06-15] ////
// 已跟踪文件用 git diff HEAD
const trackedDiffRes = spawnSync("git", ["diff", "HEAD"], {
  cwd,
  encoding: "utf8",
  timeout: 15000,
  maxBuffer: 8 * 1024 * 1024,
});
let diffContent = (trackedDiffRes.status === 0 ? trackedDiffRes.stdout || "" : "");

// 未跟踪文件直接读内容附在后面
const MAX_UNTRACKED_BYTES = 256 * 1024;   // 单文件上限，防止超大文件超出 buffer 上限
let untrackedContent = "";
for (const rel of untrackedFiles) {
  const abs = path.join(cwd, rel);
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_UNTRACKED_BYTES) continue;
    const body = fs.readFileSync(abs, "utf8");
    untrackedContent += `\n=== 未跟踪新文件: ${rel} ===\n${body}\n`;
  } catch { /* 读不到就跳过 */ }
}
const fullDiff = diffContent + untrackedContent;

// diff 为空则无需审计
if (!fullDiff.trim()) allow();
// //// /组装传给审计器的完整 diff ////

// //// 重试计数（防止阻断死循环） [@380kkm 2026-06-15] ////
const countFile = path.join(os.tmpdir(), `claude-doc-sync-${sessionId}.count`);
const getCount = () => { try { return parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { return 0; } };
const setCount = (n) => { try { fs.writeFileSync(countFile, String(n)); } catch { /* 忽略 */ } };
// //// /重试计数 ////

// //// 构造审计评判提示词 [@380kkm 2026-06-15] ////
const RUBRIC = `你是一个独立的文档同步审计器。你会收到一次代码改动的完整 diff（含未跟踪新文件内容）。
你的唯一任务：判断这次改动里有没有"代码改了，但对应文件的头块注释（file-head block）或相关文档未同步，导致文档与代码矛盾"的情况。

判定标准（只看这一点，不评判其它）：
- 若某个源码文件的内容（函数签名、行为、模块名、接口、端口、路径、常量、依赖等）在 diff 中发生了变化，
  而该文件头部注释中对应的陈述仍是旧的、与新代码矛盾，算不通过。
- 若相关 .md 文档（如 api.md、architecture.md、README 等）在 diff 中出现，但其内容与同次 diff 里的代码改动矛盾，也算不通过。
- 若代码改动了但其文件根本没有头块，或头块里没有提到该事实，则视为"无矛盾"，不算不通过。
- 只要文档和代码之间没有矛盾（即使文档不完整），就算通过。
- 不评判代码正确性、风格、遗漏功能或其它，只看文档与代码的矛盾。

只输出一个 JSON 对象，不要任何其它文字、不要代码块围栏：
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["文件X的头块说端口是6000但代码改为6080", "..."]}`;
// //// /构造审计评判提示词 ////

// //// 启动独立 claude 进程进行审计并解析裁决 [@380kkm 2026-06-15] ////
let verdict = null;
const res = spawnSync("claude -p", {
  input: `${RUBRIC}\n\n====== 本次改动 diff ======\n${fullDiff}`,
  shell: true,
  cwd: os.tmpdir(),                                        // 隔离：临时目录，无项目上下文
  env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },        // 标记嵌套，避免递归审计
  encoding: "utf8",
  timeout: 100000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status === 0 && !res.error && res.stdout) {
  const m = res.stdout.match(/\{[\s\S]*\}/);
  if (m) { try { verdict = JSON.parse(m[0]); } catch { verdict = null; } }
}
// 解析失败、报错、超时或 pass 非布尔一律放行
if (!verdict || typeof verdict.pass !== "boolean") {
  setCount(0);
  allow({ systemMessage: "文档同步审计未能运行或返回无法解析，本次已放行。" });
}
// //// /启动独立 claude 进程进行审计并解析裁决 ////

// //// 追加审计记录到 archive/doc-sync-audit.md [@380kkm 2026-06-15] ////
try {
  const archiveDir = path.join(cwd, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString();
  const issueLines = Array.isArray(verdict.issues) && verdict.issues.length
    ? verdict.issues.map(s => `- ${s}`).join("\n")
    : "（无）";
  const entry = `\n## ${stamp}  session=${sessionId}\npass=${verdict.pass}\n${issueLines}\n`;
  fs.appendFileSync(path.join(archiveDir, "doc-sync-audit.md"), entry, "utf8");
} catch { /* 追加记录失败不阻断裁决 */ }
// //// /追加审计记录到 archive/doc-sync-audit.md ////

// //// 据裁决决定放行或打断 [@380kkm 2026-06-15] ////
if (verdict.pass) {
  setCount(0);
  allow();
}
// pass===false 且 issues 非空才 block
const issues = Array.isArray(verdict.issues) && verdict.issues.length ? verdict.issues : null;
if (!issues) {
  setCount(0);
  allow({ systemMessage: "文档同步审计返回 pass=false 但未给出具体问题，已放行。" });
}
const n = getCount() + 1;
if (n > MAX_BLOCKS) {
  setCount(0);
  allow({ systemMessage: `文档同步审计连续 ${MAX_BLOCKS} 次发现脱节，已放行，请人工补齐对应头块或文档。` });
}
setCount(n);
const issueText = issues.map(s => `- ${s}`).join("\n");
allow({
  decision: "block",
  reason: `文档同步审计发现代码与文档矛盾（第 ${n}/${MAX_BLOCKS} 次）。请在本次改动中同步更新对应文件的头块注释或相关文档，使文档与代码保持一致，再结束本回合：\n${issueText}`,
});
// //// /据裁决决定放行或打断 ////
