// audience: internal
// # comment-test-probe-hook
// 阻塞型 Stop hook：验证本回合改动的代码与其注释是否一致。
// 把注释当规格，起一个独立 claude 进程设计并执行一次性单元测试；测后即弃，不污染项目测试套件。
// 运行前提：PATH 上有 claude CLI；被测项目可在 cwd 下正常调用。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量二：验证器报错/超时/无法解析一律放行（fail-open），绝不因验证器自身故障卡死会话。
// 不变量三：同一回合最多打断 MAX_BLOCKS 次，超出就放行，防止 block 死循环。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_BLOCKS = 1;    // 每条回复最多 block 一次

// 输出 hook JSON 并放行退出。
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

// //// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-15] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
// //// /防递归：嵌套 claude 进程直接放行 ////

// //// 读取 Stop hook 输入 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
const cwd = input.cwd || process.cwd();
// //// /读取 Stop hook 输入 ////

// //// 定义合法源码扩展名集合 [@380kkm 2026-06-15] ////
const SRC_EXTS = new Set([
  ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx",
  ".py", ".go", ".rs",
  ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
]);

function isSrcFile(f) {
  return SRC_EXTS.has(path.extname(f).toLowerCase());
}
// //// /定义合法源码扩展名集合 ////

// //// 用 git 取本回合改动的源码文件列表 [@380kkm 2026-06-15] ////
function runGit(args) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  if (res.status !== 0 || res.error) return null;
  return res.stdout || "";
}

const diffOut = runGit(["diff", "--name-only", "HEAD"]);
// git 命令失败视为非 git 仓库，直接放行
if (diffOut === null) allow();

const statusOut = runGit(["status", "--porcelain"]) || "";

const diffFiles = diffOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// 取未跟踪文件（?? 行）
const untrackedFiles = statusOut
  .split(/\r?\n/)
  .filter(l => l.startsWith("??"))
  .map(l => l.slice(3).trim());

const allChanged = [...new Set([...diffFiles, ...untrackedFiles])];
const srcFiles = allChanged.filter(isSrcFile);

// 筛完没有源码改动直接放行，不起 claude
if (srcFiles.length === 0) allow();
// //// /用 git 取本回合改动的源码文件列表 ////

// //// 取 git diff 文本作为验证上下文 [@380kkm 2026-06-15] ////
const diffTextRes = spawnSync("git", ["diff", "HEAD", "--", ...srcFiles], {
  cwd,
  encoding: "utf8",
  timeout: 15000,
  maxBuffer: 8 * 1024 * 1024,
});
const diffText = (diffTextRes.status === 0 && !diffTextRes.error)
  ? (diffTextRes.stdout || "")
  : "";
// //// /取 git diff 文本作为验证上下文 ////

// //// 重试计数（防 block 死循环） [@380kkm 2026-06-15] ////
const countFile = path.join(os.tmpdir(), `claude-cmt-probe-${sessionId}.count`);
const getCount = () => {
  try { return parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { return 0; }
};
const setCount = (n) => {
  try { fs.writeFileSync(countFile, String(n)); } catch { /* 忽略 */ }
};
// //// /重试计数（防 block 死循环） ////

// //// 组装 rubric 与验证上下文 [@380kkm 2026-06-15] ////
const RUBRIC = `你是独立的代码-注释一致性验证器。

工作规程：
1. 阅读下方改动文件列表与 git diff，找出所有已注释的代码单元（函数、方法、类、模块）。
2. 对每个能被单独执行、副作用可控的单元，把其注释当作规格，设计最小单元测试；测试当且仅当代码确实做到注释所说时通过。
3. 把测试文件写到项目根目录下的 archive/ 子目录（若不存在则创建），文件名任意；跑完立即视为一次性产物，不将其纳入项目正式测试套件，不修改任何项目源码。
4. 运行测试，收集结果。
5. 只报告可复现的代码与注释矛盾；无法安全测试（副作用不可控、外部依赖缺失等）的单元跳过，不算矛盾。

只输出一个 JSON 对象，不要任何其它文字、不要代码块围栏：
{"pass":true,"mismatches":[]}
或
{"pass":false,"mismatches":["单元名：注释说…，实测…"]}

====== 改动源码文件列表 ======
${srcFiles.join("\n")}

====== git diff ======
${diffText || "（diff 为空或无法获取）"}`;
// //// /组装 rubric 与验证上下文 ////

// //// 起独立 claude 验证，解析裁决 [@380kkm 2026-06-15] ////
let verdict = null;
const res = spawnSync("claude -p", {
  input: RUBRIC,
  shell: true,
  cwd,
  env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },
  encoding: "utf8",
  timeout: 170000,
  maxBuffer: 16 * 1024 * 1024,
});

if (res.status === 0 && !res.error && res.stdout) {
  const m = res.stdout.match(/\{[\s\S]*\}/);
  if (m) {
    try { verdict = JSON.parse(m[0]); } catch { verdict = null; }
  }
}
// //// /起独立 claude 验证，解析裁决 ////

// //// 留痕：把裁决写到 archive/comment-test-probe.md [@380kkm 2026-06-15] ////
try {
  const archiveDir = path.join(cwd, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const ts = new Date().toISOString();
  const passLabel = !verdict
    ? "未能解析"
    : verdict.pass === true ? "通过" : "未通过";
  const mismatches = verdict && Array.isArray(verdict.mismatches) && verdict.mismatches.length
    ? verdict.mismatches.map(s => `- ${s}`).join("\n")
    : "（无）";
  const record = [
    `# comment-test-probe 裁决留痕`,
    ``,
    `时间：${ts}`,
    `会话：${sessionId}`,
    `改动文件：${srcFiles.join(", ")}`,
    `裁决：${passLabel}`,
    ``,
    `## 矛盾点`,
    mismatches,
  ].join("\n");
  fs.writeFileSync(path.join(archiveDir, "comment-test-probe.md"), record, "utf8");
} catch { /* 留痕失败不阻断主流程 */ }
// //// /留痕：把裁决写到 archive/comment-test-probe.md ////

// //// 据裁决决定放行或打断 [@380kkm 2026-06-15] ////
// 解析失败、claude 报错、超时、pass 非布尔一律 fail-open
if (!verdict || typeof verdict.pass !== "boolean") {
  setCount(0);
  allow({ systemMessage: "代码-注释一致性验证未能运行或返回无法解析，本次已放行。" });
}

if (verdict.pass === true) {
  setCount(0);
  allow();
}

// pass===false 且 mismatches 非空才打断
const mismatches = Array.isArray(verdict.mismatches) && verdict.mismatches.length
  ? verdict.mismatches
  : null;

if (!mismatches) {
  setCount(0);
  allow({ systemMessage: "代码-注释一致性验证返回 pass:false 但未给出矛盾详情，本次已放行。" });
}

const n = getCount() + 1;
if (n > MAX_BLOCKS) {
  setCount(0);
  allow({ systemMessage: `代码-注释一致性验证已打断 ${MAX_BLOCKS} 次，已放行，请人工复核矛盾点（见 archive/comment-test-probe.md）。` });
}
setCount(n);

const mismatchLines = mismatches.map(s => `- ${s}`).join("\n");
process.stdout.write(JSON.stringify({
  decision: "block",
  reason: `代码与注释存在矛盾（第 ${n}/${MAX_BLOCKS} 次打断），请修正代码或注释使二者一致后重新提交：\n${mismatchLines}`,
}));
process.exit(0);
// //// /据裁决决定放行或打断 ////
