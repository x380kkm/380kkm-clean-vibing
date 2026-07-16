// audience: internal
// # jargon-audit-hook
// 阻塞型 Stop hook:检查本回合改动源码里新增的注释与命名有没有"黑话" - 生造代号,
// 未解释缩写,内部暗语,且首次出现没有半句解释.只判这一件事,不评判正确性,风格,
// 阶梯标记或其它任何东西.
// 运行前提:PATH 上有 codex CLI 和 git.
// 不变量一:审计器报错/超时/无法解析一律放行(fail-open),不因审计器坏掉而卡死会话.
// 不变量二:嵌套 codex 子进程(CODEX_HOOK_NESTED=1)直接放行,断开递归.
// 不变量三:stop_hook_active 为真表示本次停止由 hook 续写引发,直接放行,断开续写循环.
// 不变量四:同一回合最多打断 MAX_BLOCKS 次,超出则放行并告警,防 block 死循环.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planDimension } from "./lib/cleanaudit-bridge.mjs";
import { scanJargon, KEEP } from "./lib/jargon-lexicon.mjs";
import { runReadOnlyAuditCodex, truncateModelInput } from "./lib/nested-codex.mjs";

const MAX_BLOCKS = 1;
const MAX_MODEL_INPUT_CHARS = 64_000;

// 源码文件扩展名白名单
const SOURCE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".swift", ".kt", ".scala", ".sh", ".bash",
]);

// 向 stdout 输出 hook JSON 并以放行状态退出.
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

// //// 防递归:嵌套 codex 子进程直接放行 [@380kkm 2026-06-15] ////
if (process.env.CODEX_HOOK_NESTED === "1") allow();
// //// /防递归:嵌套 codex 子进程直接放行 ////

// //// 读取 Stop hook stdin 输入 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse((fs.readFileSync(0, "utf8") || "{}").replace(/^\uFEFF+/, "")); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
const cwd = input.cwd || process.cwd();
// //// /读取 Stop hook stdin 输入 ////

// //// 防续写循环:本次停止由 hook 续写引发时直接放行 [@380kkm 2026-07-09] ////
if (input.stop_hook_active) allow();
// //// /防续写循环 ////

// //// 用 git 取本回合改动的源码文件列表 [@380kkm 2026-06-15] ////
function getChangedSourceFiles(dir) {
  // 已跟踪文件(相对 HEAD 有改动)
  const tracked = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: dir, encoding: "utf8", timeout: 10000,
  });
  if (tracked.status !== 0 || tracked.error) return null;

  // 未跟踪文件
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: dir, encoding: "utf8", timeout: 10000,
  });
  if (untracked.error) return null;

  const all = [
    ...(tracked.stdout || "").split(/\r?\n/),
    ...(untracked.stdout || "").split(/\r?\n/),
  ].map(f => f.trim()).filter(Boolean);

  // 只保留源码扩展名
  return all.filter(f => SOURCE_EXTS.has(path.extname(f).toLowerCase()));
}

const sourceFiles = getChangedSourceFiles(cwd);
if (!sourceFiles || sourceFiles.length === 0) allow();   // git 失败或无源码改动
// //// /用 git 取本回合改动的源码文件列表 ////

// //// cleanaudit 预过滤:本回合无改动符号则跳过,省去模型调用 [@380kkm 2026-06-16] ////
if (planDimension("jargon", cwd) === "skip") allow();
// //// /cleanaudit 预过滤 ////

// //// 组装 diff 内容:已跟踪文件取 diff,未跟踪文件取全文 [@380kkm 2026-06-15] ////
function buildDiff(dir, files) {
  const parts = [];

  // 已跟踪:取 git diff HEAD -- <file>
  const trackedDiff = spawnSync("git", ["diff", "HEAD", "--", ...files], {
    cwd: dir, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  if (!trackedDiff.error && trackedDiff.stdout) {
    parts.push(trackedDiff.stdout);
  }

  // 未跟踪:ls-files --others 交集 files,直接读文件内容作为"新增"
  const untrackedSet = (() => {
    const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: dir, encoding: "utf8", timeout: 10000,
    });
    if (r.error) return new Set();
    return new Set((r.stdout || "").split(/\r?\n/).map(f => f.trim()).filter(Boolean));
  })();

  for (const f of files) {
    if (!untrackedSet.has(f)) continue;
    const abs = path.isAbsolute(f) ? f : path.join(dir, f);
    try {
      const content = fs.readFileSync(abs, "utf8");
      parts.push(`\n=== 未跟踪新文件: ${f} ===\n${content}`);
    } catch { /* 读不到跳过 */ }
  }

  return parts.join("\n");
}

const diff = buildDiff(cwd, sourceFiles);
if (!diff.trim()) allow();
const modelDiff = truncateModelInput(diff, MAX_MODEL_INPUT_CHARS);
// //// /组装 diff 内容:已跟踪文件取 diff,未跟踪文件取全文 ////

// //// 留痕:把 diff 写到 archive/jargon-audit.md [@380kkm 2026-06-15] ////
try {
  const archiveDir = path.join(cwd, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, "jargon-audit.md"),
    `# jargon-audit diff\n\ncwd: ${cwd}\nsession: ${sessionId}\ndate: ${new Date().toISOString()}\n\n\`\`\`\n${diff}\n\`\`\`\n`,
    "utf8",
  );
} catch { /* 写文件失败不阻断审计 */ }
// //// /留痕:把 diff 写到 archive/jargon-audit.md ////

// //// MAX_BLOCKS 计数:读写 tmpdir 计数文件 [@380kkm 2026-06-15] ////
const countFile = path.join(os.tmpdir(), `codex-jargon-audit-${sessionId}.count`);
const getCount = () => {
  try { return parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { return 0; }
};
const setCount = (n) => { try { fs.writeFileSync(countFile, String(n)); } catch { /* 忽略 */ } };
// //// /MAX_BLOCKS 计数:读写 tmpdir 计数文件 ////

// //// 词典扫描:确定性列出本项目常见黑话,稍后与模型结果合并成一份清单 [@380kkm 2026-07-07] ////
// 此处不打断:先扫词典,再跑模型审词典外的新黑话,两份合并后一次性给完整清单,避免分两轮打断.
const lexIssues = scanJargon(diff).map(h => `"${h.term}" -> ${h.good}（见：${h.sample}）`);
// //// /词典扫描:确定性列出本项目常见黑话 ////

const RUBRIC = `你是一个代码黑话审计器。只判断以下 diff 里新增的注释和标识符命名有没有"黑话"。

黑话定义（满足任意一条即算黑话）：
1. 生造代号：自造的简写或符号，在整个 diff 范围内首次出现时没有任何解释（哪怕半句也算）。
2. 未解释缩写：行业外不通用的缩写（如 FCS、TSK、PMR），且首次出现时没有展开或说明。
3. 内部暗语：仅靠内部约定才能理解的词，读者无法从上下文或命名本身推断含义。
4. 中文注释里的不平直表达：把普通动作/状态/关系说成比喻（如"回落""烧进""接线"）、
   拟人（让代码/函数/文件"认识/知道/回答"）、口语缩略（如"跑对应 JSON""装 0xA9"）、
   颜色喻状态（如"全绿"喻测试通过）、生造压缩（把多词压成单字或拼接）。改成平直技术陈述。

以下确立术语与字面词不算黑话，出现时不要 flag：${KEEP.join("、")}。

不属于黑话（不要误判）：
- 通用编程术语（如 fn、ctx、req、res、idx、tmp、err、cb、args、opts、buf、num、str、len、id、db、api、url、http、json、sql）。
- 语言/框架的惯用缩写（如 async/await、impl、proto、config、schema、spec、env、cli、cwd、os、fs、path）。
- 数学/算法标准符号（如 i、j、k、n、x、y、z）。
- 中文注释里有完整词义的中文词。
- 在同一 diff 中同一文件内首次出现时已有解释的任何缩写。

只输出一个 JSON 对象，不要任何其它文字，不要代码块围栏：
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["具体黑话词及所在位置", "..."]}`;

// //// 起独立 codex 子进程审计黑话,解析裁决 [@380kkm 2026-06-15] ////
let verdict = null;
const res = runReadOnlyAuditCodex({
  input: `${RUBRIC}\n\n====== diff 内容 ======\n${modelDiff}`,
  // 使用临时目录, 不加载当前项目上下文.
  cwd: os.tmpdir(),
  encoding: "utf8",
  timeout: 100000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status === 0 && !res.error && res.stdout) {
  const m = res.stdout.match(/\{[\s\S]*\}/);
  if (m) { try { verdict = JSON.parse(m[0]); } catch { verdict = null; } }
}
// 模型出错/超时/无法解析:fail-open 只作用于模型部分,模型结果记为空;词典命中仍然算数
const llmOk = verdict && typeof verdict.pass === "boolean";
const llmIssues = (llmOk && verdict.pass === false && Array.isArray(verdict.issues))
  ? verdict.issues
  : [];
// //// /起独立 codex 子进程审计黑话,解析裁决 ////

// //// 合并词典命中与模型结果,一次性给完整清单,至多打断一次 [@380kkm 2026-07-07] ////
// 词典命中在前,模型判定在后,一份清单一次报完;MAX_BLOCKS 保证一个会话至多打断一次.
const allIssues = [...lexIssues, ...llmIssues];
if (allIssues.length === 0) {
  setCount(0);
  allow(llmOk ? {} : { systemMessage: "黑话审计的模型部分未能运行，仅词典扫描已通过。" });
}

const n = getCount() + 1;
if (n > MAX_BLOCKS) {
  setCount(0);
  allow({ systemMessage: `黑话审计连续 ${MAX_BLOCKS} 次未通过，已放行，请人工复核改动中的命名。` });
}
setCount(n);

const issueList = allIssues.map(s => `- ${s}`).join("\n");
allow({
  decision: "block",
  reason: `黑话审计未通过（第 ${n}/${MAX_BLOCKS} 次）。下面是本回合新增注释/命名里扫出的全部黑话（词典命中在前，模型判定在后），请一次性改成平直说法或在首次出现处加半句解释：\n${issueList}`,
});
// //// /合并词典命中与模型结果,一次性给完整清单 ////
