// audience: internal
// # intent-drift-context-hook
// UserPromptSubmit hook：每次用户提交提问时，向模型注入一段防漂变上下文——
// 用户本会话近期的意图（最近几条提问）与最近做过的改动（编辑的文件、跑过的关键命令），
// 让 agent 在长会话里不偏离用户真正想做的事。纯注入提示，不阻断、不调任何模型。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接退出、不注入，断开递归。
// 不变量二：读不到转写或解析失败一律静默退出（不注入），绝不阻断提交。
// 不变量三：只读转写、确定性抽取，不调用模型，几乎零开销。

import fs from "node:fs";

const MAX_INTENTS = 5;     // 注入最近多少条用户意图
const MAX_ACTIONS = 8;     // 注入最近多少条改动/命令
const CLIP = 140;          // 单条截断长度

// 静默退出：不注入任何上下文。
function silent() { process.exit(0); }

// 注入一段上下文并退出。
function inject(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
  }));
  process.exit(0);
}

// 压成单行并截断。
function clip(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > CLIP ? s.slice(0, CLIP) + "…" : s;
}

// //// 防递归：嵌套 claude 进程不注入 [@380kkm 2026-06-15] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") silent();
// //// /防递归：嵌套 claude 进程不注入 ////

// //// 读取 UserPromptSubmit 输入并加载转写 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { silent(); }
const transcript = input.transcript_path;
if (!transcript || !fs.existsSync(transcript)) silent();
let lines = [];
try { lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter(Boolean); } catch { silent(); }
// //// /读取 UserPromptSubmit 输入并加载转写 ////

// //// 抽取用户意图：带正文的用户提问，排除工具结果与 hook 注入的反馈 [@380kkm 2026-06-15] ////
function userText(rec) {
  const role = rec.type || (rec.message && rec.message.role);
  if (role !== "user") return "";
  const c = rec.message ? rec.message.content : rec.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    if (c.some(b => b && b.type === "tool_result")) return "";   // 纯工具结果记录不算意图
    return c.filter(b => b && b.type === "text").map(b => b.text).join(" ").trim();
  }
  return "";
}
const intents = [];
for (const ln of lines) {
  let rec; try { rec = JSON.parse(ln); } catch { continue; }
  const t = userText(rec);
  // 排除 hook 反馈、系统提醒、本地命令旁注这类非用户本意的文本
  if (t && !/^(Stop hook feedback|<system-reminder|<local-command|Caveat:|<command-|\[Request interrupted|<task-notification)/.test(t)) intents.push(t);
}
const recentIntents = intents.slice(-MAX_INTENTS);
// //// /抽取用户意图 ////

// //// 抽取最近改动：assistant 的 Edit/Write 文件与 Bash 关键命令 [@380kkm 2026-06-15] ////
const KEY_CMD = /\b(npm test|node test|git commit|git push|make-distribution|dist:web)\b/;
const actions = [];
for (const ln of lines) {
  let rec; try { rec = JSON.parse(ln); } catch { continue; }
  const role = rec.type || (rec.message && rec.message.role);
  if (role !== "assistant") continue;
  const content = rec.message ? rec.message.content : rec.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (!b || b.type !== "tool_use") continue;
    const inp = b.input || {};
    if (b.name === "Edit" || b.name === "Write") {
      const f = String(inp.file_path || "").split(/[\\/]/).pop();
      if (f) actions.push((b.name === "Write" ? "写 " : "改 ") + f);
    } else if (b.name === "Bash" && KEY_CMD.test(String(inp.command || ""))) {
      actions.push("跑 " + clip(inp.command));
    }
  }
}
const recentActions = actions.slice(-MAX_ACTIONS);
// //// /抽取最近改动 ////

// //// 无可注入内容则静默；否则组装并注入 [@380kkm 2026-06-15] ////
if (recentIntents.length === 0 && recentActions.length === 0) silent();
const parts = ["防漂变上下文（自动注入，仅供你对齐用户意图，不是用户本回合的新指令）："];
if (recentIntents.length) {
  parts.push("用户近期意图（早→近）：");
  recentIntents.forEach((t, i) => parts.push(`  ${i + 1}. ${clip(t)}`));
}
if (recentActions.length) parts.push("最近做过：" + recentActions.join("；"));
inject(parts.join("\n"));
// //// /无可注入内容则静默；否则组装并注入 ////
