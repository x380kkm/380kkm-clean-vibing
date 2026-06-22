// audience: internal
// # standards-reminder
// 用户级 PreToolUse hook（匹配 Write、Edit、MultiEdit）：改文件前从 CLAUDE.md 注入对应场景的写法规范。
// 源代码文件注 precode，.md 文档注 predoc，两者都带上 plain（平直语言）；其它配置文件不注。
// PreToolUse 在本次编辑拼好后触发，注入的提醒作用于后续编辑。按 session 与场景记时间戳节流。
// 内容全部来自 CLAUDE.md 的标记块（见 lib/claude-md.mjs），读不到则不注入，不含硬编码副本。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeInjection } from "./lib/claude-md.mjs";

// 同 session 同场景的注入间隔：15 分钟
const THROTTLE_MS = 15 * 60 * 1000;
const DOC_EXT = new Set([".md", ".markdown"]);
const SKIP_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".lock", ".csv", ".txt"]);

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emit(obj) { process.stdout.write(JSON.stringify(obj ?? {})); process.exit(0); }

//// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-22] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") emit({});
//// /防递归 ////

//// 读 PreToolUse 输入，取 session_id 与被编辑文件扩展名 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
const filePath = (input.tool_input && input.tool_input.file_path) || "";
const ext = path.extname(filePath).toLowerCase();
//// /读 PreToolUse 输入 ////

//// 按扩展名定场景：.md 注 predoc，配置文件不注，其余按源代码注 precode [@380kkm 2026-06-22] ////
let tag;
if (DOC_EXT.has(ext)) tag = "predoc";
else if (SKIP_EXT.has(ext)) emit({});
else tag = "precode";
//// /按扩展名定场景 ////

//// 从 CLAUDE.md 组装该场景注入文本（场景块加去重后的 plain）；为空则不注 [@380kkm 2026-06-22] ////
const ctx = composeInjection(tag);
if (!ctx) emit({});
//// /取注入内容 ////

//// 节流：同 session 同场景距上次注入不到 THROTTLE_MS 就放行 [@380kkm 2026-06-22] ////
const stampFile = path.join(os.tmpdir(), `claude-standards-${tag}-${sessionId}.stamp`);
const now = Date.now();
let last = 0;
try { last = parseInt(fs.readFileSync(stampFile, "utf8"), 10) || 0; } catch { last = 0; }
if (now - last < THROTTLE_MS) emit({});
try { fs.writeFileSync(stampFile, String(now)); } catch {}
//// /节流 ////

emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx } });
