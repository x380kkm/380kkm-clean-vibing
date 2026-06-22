// audience: internal
// # style-rewrite-inject
// 文风审计 Stop hook（已取代原阻塞式 style-audit）：把本回合最终回复交给外部短上下文流水线改写，
// 再经 hookSpecificOutput.additionalContext 注入主 agent 并要求复述，使用户看到干净版、主 agent 也
// 获得一条干净样例以减少后续风格漂移。流水线固定为：改写、审计、改写、审计、改写，取终稿。短上下文的
// 改写与审计 claude 进程不漂移，质量高于长上下文里主 agent 自改。运行前提：PATH 上有 claude CLI，用默认模型。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量二：stop_hook_active 为真表示本次停止由注入续写引发，直接放行，断开续写循环。
// 不变量三：任一子调用失败、超时或无法解析时放行不注入，绝不因改写器坏掉卡死会话。

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const MIN_CHARS = 280;        // 短于此的回复跳过，减少不必要的流水线开销
const SUBCALL_TIMEOUT = 90000;

const AUDIT_RUBRIC = `你是一个独立的中文写作风格审计器。只判断给定文本的"文风"，不评价其技术内容是否正确，也没有任何项目背景，不要试图理解项目。

判定标准（全部满足才算通过）：
1. 平直：完整句子；不用电报体或碎片短语；不用箭头链（如 A → B → 失败）；不堆砌缩写；新造的代号或缩写在首次出现时必须有半句解释。
2. 非过度简化：简洁不等于潦草，为了短而丢掉"读者据以行动所需的信息"算不通过；不要把完整推理压成无主语的碎句。
3. 没有翻译腔，没有营销词。
4. 中文用全角标点；中文与英文或数字之间留一个空格。

只输出一个 JSON 对象，不要任何其它文字、不要代码块围栏：
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["具体问题，要可据以改写", "..."]}`;

const REWRITE_RUBRIC = `你是一个独立的中文写作风格改写器。把给定文本改写成符合下列标准的版本，保持原意与全部信息不丢失，不增删技术内容：
1. 平直：完整句子；不用电报体或碎片短语；不用箭头链；不堆砌缩写；新造的代号或缩写首次出现给半句解释。
2. 非过度简化：保留读者据以行动所需的信息；不要把推理压成无主语碎句。
3. 没有翻译腔，没有营销词。
4. 中文用全角标点；中文与英文或数字之间留一个空格。
只输出改写后的正文，不要任何解释、不要代码块围栏。`;

// 输出一段 hook JSON 并按放行退出。
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

//// 从转写取最后一条 assistant 文本；过短则跳过 [@380kkm 2026-06-22] ////
function lastAssistantText(tp) {
  if (!tp || !fs.existsSync(tp)) return "";
  const lines = fs.readFileSync(tp, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const msg = rec.message || rec;
    const role = rec.type || msg.role;
    if (role !== "assistant") continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      const t = content.filter(b => b && b.type === "text").map(b => b.text).join("").trim();
      if (t) return t;
    } else if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
  }
  return "";
}
const original = lastAssistantText(transcript);
if (original.length < MIN_CHARS) allow();
//// /从转写取最后一条 assistant 文本 ////

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

//// 经 additionalContext 注入修正版，要求主 agent 复述并在后续保持平直风格 [@380kkm 2026-06-22] ////
const prefix =
  "你上一条回复存在风格漂移。下面是经独立改写与两轮审计得到的修正版。" +
  "请把这段修正版作为你的回复重新完整输出一遍（只输出修正版正文，不要额外说明），" +
  "并在后续回复中保持这种平直、完整句子、不电报体不缩写的风格：\n\n";
allow({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: prefix + final } });
//// /注入修正版 ////
