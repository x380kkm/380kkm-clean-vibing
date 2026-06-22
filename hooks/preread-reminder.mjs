// audience: internal
// # preread-reminder
// 用户级 PreToolUse hook（匹配 Read、Grep）：读码前从 CLAUDE.md 注入 preread 块（用 cleanread 读、索引
// 生命周期、reuse）外加 plain 块。索引的怎么用和读前刷新由 preread 注入，收尾的全量重建由 stop-reminders
// 负责。按 session 记时间戳节流。内容全部来自 CLAUDE.md，读不到则不注入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeInjection } from "./lib/claude-md.mjs";

// 同 session 的注入间隔：15 分钟
const THROTTLE_MS = 15 * 60 * 1000;

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emit(obj) { process.stdout.write(JSON.stringify(obj ?? {})); process.exit(0); }

//// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-22] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") emit({});
//// /防递归 ////

//// 读 PreToolUse 输入，取 session_id 供节流 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
//// /读 PreToolUse 输入 ////

//// 从 CLAUDE.md 组装 preread 场景注入文本（场景块加去重后的 plain）；为空则不注入 [@380kkm 2026-06-22] ////
const ctx = composeInjection("preread");
if (!ctx) emit({});
//// /取注入内容 ////

//// 节流：同 session 距上次注入不到 THROTTLE_MS 就放行 [@380kkm 2026-06-22] ////
const stampFile = path.join(os.tmpdir(), `claude-preread-${sessionId}.stamp`);
const now = Date.now();
let last = 0;
try { last = parseInt(fs.readFileSync(stampFile, "utf8"), 10) || 0; } catch { last = 0; }
if (now - last < THROTTLE_MS) emit({});
try { fs.writeFileSync(stampFile, String(now)); } catch {}
//// /节流 ////

emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx } });
