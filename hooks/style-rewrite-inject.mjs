// audience: internal
// # style-rewrite-inject
// Stop hook 审计本回合最终回复.
// 审计不通过时, hook 生成一个修正版并请求 Codex 输出该版本.
// 流程最多启动两个独立 Codex 子进程. 短回复和超长回复不启动子进程.
// PATH 上必须存在 codex CLI.
// hook 在转写停止增长后读取最后一条 assistant 文本.
// CODEX_HOOK_NESTED=1 时直接放行.
// stop_hook_active 为真时直接放行.
// 文本未落盘或子进程失败时直接放行.

import fs from "node:fs";
import os from "node:os";
import { extractBlocks } from "./lib/guidance-md.mjs";
import { runReadOnlyAuditCodex } from "./lib/nested-codex.mjs";

// //// 定义触发范围与等待时间 [@x380kkm 2026-07-15] ////
const MIN_CHARS = 800;
const MAX_CHARS = 12000;
const SUBCALL_TIMEOUT = 90000;
const WAIT_MS = 3000;
const POLL_MS = 150;
// //// /定义触发范围与等待时间 ////

//// 从 AGENTS.md 的 plain 块取平直语言标准,读不到时用内置默认值 [@380kkm 2026-06-22] ////
const PLAIN_CRITERIA = extractBlocks("plain") ||
  "使用完整句子, 每句只陈述一个事实. 不用电报体或碎片短语, 不堆砌缩写. 新术语首次出现时用半句解释. 所有语言使用半角 ASCII 标点和符号, 中文与 Latin 或数字之间留一个空格. 删除翻译腔和营销词.";
//// /取平直语言标准 ////

const AUDIT_RUBRIC = `你是一个独立的中文写作风格审计器. 只判断给定文本的"文风", 不评价技术内容是否正确. 你没有项目背景, 不判断项目语义.

判定标准 (全部满足才算通过):
${PLAIN_CRITERIA}

只输出一个 JSON 对象, 不要其他文字或代码块围栏:
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["具体问题, 必须可以直接用于改写", "..."]}`;

const REWRITE_RUBRIC = `你是一个独立的中文写作风格改写器. 把给定文本改写成符合下列标准的版本. 保留原意和全部信息, 不增删技术内容.

标准:
${PLAIN_CRITERIA}

只输出改写后的正文, 不要解释或代码块围栏.`;

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emitAndExit(output) {
  process.stdout.write(JSON.stringify(output ?? {}));
  process.exit(0);
}
//// /输出一段 hook JSON 并退出 ////

//// 防递归:嵌套 codex 子进程直接放行 [@380kkm 2026-06-22] ////
if (process.env.CODEX_HOOK_NESTED === "1") emitAndExit();
//// /防递归 ////

//// 读取 Stop 事件输入 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse((fs.readFileSync(0, "utf8") || "{}").replace(/^\uFEFF+/, "")); } catch { input = {}; }
const transcript = input.transcript_path;
//// /读取 Stop 事件输入 ////

//// 防续写循环:本次停止由注入续写引发时直接放行 [@380kkm 2026-06-22] ////
if (input.stop_hook_active) emitAndExit();
//// /防续写循环 ////

//// 同步休眠,给转写落盘留时间 [@380kkm 2026-06-22] ////
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
//// /同步休眠 ////

//// 读取转写为非空行数组 [@380kkm 2026-06-22] ////
function readLines(tp) {
  if (!tp || !fs.existsSync(tp)) return [];
  return fs.readFileSync(tp, "utf8").split(/\r?\n/).filter(Boolean);
}
//// /读取转写为非空行数组 ////

//// 扫描:最后一条 user 与最后一条带文本的 assistant 记录的下标,及该 assistant 文本 [@380kkm 2026-06-22] ////
function scan(lines) {
  let lastUser = -1, lastText = -1, text = "";
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const msg = rec.message || rec;
    const role = rec.type || msg.role;
    if (role === "user") { lastUser = i; continue; }
    if (role !== "assistant") continue;
    const c = msg.content;
    let t = "";
    if (Array.isArray(c)) t = c.filter(b => b && b.type === "text").map(b => b.text).join("").trim();
    else if (typeof c === "string") t = c.trim();
    if (t) { lastText = i; text = t; }
  }
  return { lastUser, lastText, text };
}
//// /扫描转写 ////

// //// 等当前回合的 assistant 文本落盘后取它 [@380kkm 2026-06-22] ////
const start = Date.now();
let cur = scan(readLines(transcript));
while (cur.lastText < cur.lastUser && Date.now() - start < WAIT_MS) {
  sleepSync(POLL_MS);
  cur = scan(readLines(transcript));
}
if (cur.lastText < cur.lastUser) emitAndExit();
let lines = readLines(transcript);
let previousSnapshot = lines.join("\n");
let stablePolls = 0;
while (Date.now() - start < WAIT_MS) {
  sleepSync(POLL_MS);
  lines = readLines(transcript);
  const snapshot = lines.join("\n");
  if (snapshot === previousSnapshot) {
    stablePolls += 1;
    if (stablePolls >= 2) break;
  } else {
    stablePolls = 0;
    previousSnapshot = snapshot;
  }
}
const original = scan(lines).text;
if (original.length < MIN_CHARS || original.length > MAX_CHARS) emitAndExit();
// //// /等当前回合的 assistant 文本落盘后取它 ////

//// 起一个隔离的,无项目上下文的 codex 子进程;失败返回 null [@380kkm 2026-06-22] ////
function runCodex(prompt) {
  const res = runReadOnlyAuditCodex({
    hookInput: input,
    input: prompt,
    maxInputChars: 16_000,
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: SUBCALL_TIMEOUT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status === 0 && !res.error && res.stdout) return res.stdout.trim();
  return null;
}
//// /起隔离 codex 子进程 ////

// //// 按审计问题改写一段文本 [@x380kkm 2026-07-15] ////
function rewrite(text, issues) {
  const feedback = issues.length
    ? `\n\n审计问题:\n${issues.map(issue => `- ${issue}`).join("\n")}`
    : "";
  return runCodex(`${REWRITE_RUBRIC}${feedback}\n\n====== 待改写文本 ======\n${text}`);
}
// //// /按审计问题改写一段文本 ////

//// 审计一段文本,返回 {pass, issues},无法解析时返回 null [@380kkm 2026-06-22] ////
function audit(text) {
  const out = runCodex(`${AUDIT_RUBRIC}\n\n====== 待审文本 ======\n${text}`);
  if (!out) return null;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return typeof v.pass === "boolean" ? v : null; } catch { return null; }
}
//// /审计一段文本 ////

// //// 先审计,仅在不通过时改写一次 [@x380kkm 2026-07-15] ////
const verdict = audit(original);
if (!verdict) emitAndExit({ systemMessage: "文风审计未能运行或返回无法解析, 本次未继续." });
if (verdict.pass) emitAndExit();
const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
const final = rewrite(original, issues);
if (!final) emitAndExit({ systemMessage: "文风改写未能运行, 本次未继续." });
// //// /先审计,仅在不通过时改写一次 ////

//// 请求 Codex 输出修正版 [@380kkm 2026-06-22] ////
const continuationReason =
  "上一条回复未通过文风审计. 仅输出以下修正版正文, 不要解释审计过程:\n\n" + final;
emitAndExit({ decision: "block", reason: continuationReason });
//// /请求 Codex 输出修正版 ////
