// audience: internal
// # style-rewrite-inject
// 文风审计 Stop hook（已取代原阻塞式 style-audit）：把本回合最终回复交给外部短上下文流水线改写，
// 再经 hookSpecificOutput.additionalContext 注入主 agent 供参考；该注入用户与模型都能看到，因此不要求主 agent
// 复述、不让它多做一次重新输出；主 agent 据此获得一条干净样例以减少后续风格漂移。流水线固定为：改写、审计、改写、审计、改写，取终稿。短上下文的
// 改写与审计 claude 进程不漂移，质量高于长上下文里主 agent 自改。运行前提：PATH 上有 claude CLI，用默认模型。
// 取本回合文本前先等转写落盘：钩子可能在触发停止的最新一条 assistant 文本写进转写之前就运行，直接读会
// 读到上一条；故先轮询，等当前回合的 assistant 文本出现（排在最后一条 user 记录之后）且不再增长，再取它。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量二：stop_hook_active 为真表示本次停止由注入续写引发，直接放行，断开续写循环。
// 不变量三：当前回合文本在等待窗口内始终未落盘，或任一子调用失败、超时、无法解析时放行不注入，绝不卡死会话。

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { extractBlocks } from "./lib/claude-md.mjs";

const MIN_CHARS = 280;        // 短于此的回复跳过，减少不必要的流水线开销
const SUBCALL_TIMEOUT = 90000;
const WAIT_MS = 3000;         // 等转写落盘的最长时间
const POLL_MS = 150;          // 轮询间隔

// 平直语言标准从 CLAUDE.md 的 plain 块取，读不到时用兜底。
const PLAIN_CRITERIA = extractBlocks("plain") ||
  "完整句子，不用电报体或碎片短语，不堆砌缩写，新造代号首次出现给半句解释；没有翻译腔与营销词；中文用全角标点，中文与英文或数字之间留一个空格。";

const AUDIT_RUBRIC = `你是一个独立的中文写作风格审计器。只判断给定文本的"文风"，不评价其技术内容是否正确，也没有任何项目背景，不要试图理解项目。

判定标准（依据下列用户平直语言规范，全部满足才算通过）：
${PLAIN_CRITERIA}

只输出一个 JSON 对象，不要任何其它文字、不要代码块围栏：
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["具体问题，要可据以改写", "..."]}`;

const REWRITE_RUBRIC = `你是一个独立的中文写作风格改写器。把给定文本改写成符合下列标准的版本，保持原意与全部信息不丢失，不增删技术内容。

标准（依据下列用户平直语言规范）：
${PLAIN_CRITERIA}

只输出改写后的正文，不要任何解释、不要代码块围栏。`;

//// 输出一段 hook JSON 并按放行退出 ////
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

//// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-22] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
//// /防递归 ////

//// 读取 Stop 事件输入 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const transcript = input.transcript_path;
//// /读取 Stop 事件输入 ////

//// 续写闸：本次停止由注入续写引发时直接放行，断开续写循环 [@380kkm 2026-06-22] ////
if (input.stop_hook_active) allow();
//// /续写闸 ////

//// 同步休眠，给转写落盘留时间 [@380kkm 2026-06-22] ////
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
//// /同步休眠 ////

//// 读取转写为非空行数组 [@380kkm 2026-06-22] ////
function readLines(tp) {
  if (!tp || !fs.existsSync(tp)) return [];
  return fs.readFileSync(tp, "utf8").split(/\r?\n/).filter(Boolean);
}
//// /读取转写为非空行数组 ////

//// 扫描：最后一条 user 与最后一条带文本的 assistant 记录的下标，及该 assistant 文本 [@380kkm 2026-06-22] ////
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

//// 等当前回合的 assistant 文本落盘后取它：先等它出现在最后一条 user 之后，再等转写整体停止增长 [@380kkm 2026-06-22] ////
const start = Date.now();
let cur = scan(readLines(transcript));
while (cur.lastText < cur.lastUser && Date.now() - start < WAIT_MS) {
  sleepSync(POLL_MS);
  cur = scan(readLines(transcript));
}
if (cur.lastText < cur.lastUser) allow();   // 当前回合文本始终未落盘，宁可不注入也不复述过时内容
let lines = readLines(transcript);
let prevLen = lines.length, stable = 0;
while (Date.now() - start < WAIT_MS) {
  sleepSync(POLL_MS);
  lines = readLines(transcript);
  if (lines.length === prevLen) { if (++stable >= 2) break; }
  else { stable = 0; prevLen = lines.length; }
}
const original = scan(lines).text;
if (original.length < MIN_CHARS) allow();
//// /等当前回合文本落盘 ////

//// 起一个隔离的、无项目上下文的 claude 子进程；失败返回 null [@380kkm 2026-06-22] ////
function runClaude(prompt) {
  const res = spawnSync("claude -p", {
    input: prompt,
    shell: true,
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },
    encoding: "utf8",
    timeout: SUBCALL_TIMEOUT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status === 0 && !res.error && res.stdout) return res.stdout.trim();
  return null;
}
//// /起隔离 claude 子进程 ////

//// 改写一段文本；带上一轮审计意见时按意见修正 [@380kkm 2026-06-22] ////
function rewrite(text, issues) {
  const feedback = issues && issues.length
    ? `\n\n上一轮审计指出以下问题，请一并修正：\n${issues.map(s => `- ${s}`).join("\n")}`
    : "";
  return runClaude(`${REWRITE_RUBRIC}${feedback}\n\n====== 待改写文本 ======\n${text}`);
}
//// /改写一段文本 ////

//// 审计一段文本，返回 {pass, issues}，无法解析时返回 null [@380kkm 2026-06-22] ////
function audit(text) {
  const out = runClaude(`${AUDIT_RUBRIC}\n\n====== 待审文本 ======\n${text}`);
  if (!out) return null;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return typeof v.pass === "boolean" ? v : null; } catch { return null; }
}
//// /审计一段文本 ////

//// 固定流水线：改写、审计、改写、审计、改写，取终稿；首步失败则不注入 [@380kkm 2026-06-22] ////
let draft = rewrite(original, null);
if (!draft) allow({ systemMessage: "文风改写流水线首步失败，本次未注入。" });
const a1 = audit(draft);
draft = rewrite(draft, a1 && !a1.pass ? a1.issues : null) || draft;
const a2 = audit(draft);
draft = rewrite(draft, a2 && !a2.pass ? a2.issues : null) || draft;
const final = draft;
//// /固定流水线 ////

//// 经 additionalContext 注入修正版供参考，不要求复述、不让主 agent 多做一次重新输出 [@380kkm 2026-06-22] ////
const prefix =
  "以下是你上一条回复经独立改写与两轮审计得到的风格修正版，你和用户都已在此看到它。" +
  "请在后续回复中保持这种平直、完整句子、不电报体不缩写的风格。" +
  "本条仅供参考，无需重述、无需回应：\n\n";
allow({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: prefix + final } });
//// /注入修正版 ////
