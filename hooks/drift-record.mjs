// audience: internal
// # drift-record-hook
// UserPromptSubmit hook：把用户这次请求追加进会话状态文件（积累历史请求记录），
// 并把上一回合末由 drift-compact 备好的回顾摘要注入上下文。只做记录与读取注入，
// 不压缩、不判断、不扫描；压缩与判断均在回合末的 drift-compact 里。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接退出，断开递归。
// 不变量二：读写状态文件失败一律静默退出，绝不阻断提交。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_REQUESTS = 12;   // 状态里最多保留多少条用户请求

// 输出可选 JSON 并退出。
function done(extra) {
  if (extra) process.stdout.write(JSON.stringify(extra));
  process.exit(0);
}

// //// 防递归：嵌套 claude 进程直接退出 [@380kkm 2026-06-15] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") done();
// //// /防递归：嵌套 claude 进程直接退出 ////

// //// 读取输入与会话状态 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { done(); }
const sessionId = input.session_id || "nosession";
const prompt = String(input.prompt || "").trim();
const stateFile = path.join(os.tmpdir(), "claude-drift-" + sessionId + ".json");
let state = { requests: [], recap: "" };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* 首次无状态 */ }
if (!state || typeof state !== "object" || Array.isArray(state)) state = { requests: [], recap: "" };
if (!Array.isArray(state.requests)) state.requests = [];
// //// /读取输入与会话状态 ////

// //// 记录本次请求，只留最近若干条 [@380kkm 2026-06-15] ////
if (prompt) {
  state.requests.push(prompt);
  if (state.requests.length > MAX_REQUESTS) state.requests = state.requests.slice(-MAX_REQUESTS);
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* 写失败不阻断提交 */ }
}
// //// /记录本次请求，只留最近若干条 ////

// //// 注入上一回合备好的回顾 [@380kkm 2026-06-15] ////
const recap = String(state.recap || "").trim();
if (!recap) done();
done({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: recap } });
// //// /注入上一回合备好的回顾 ////
