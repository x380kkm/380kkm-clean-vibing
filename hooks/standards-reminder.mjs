// audience: internal
// # standards-reminder
// PreToolUse hook 匹配 apply_patch, Edit 和 Write.
// hook 从 AGENTS.md 注入待编辑文件对应的写作规范.
// Markdown 文件使用 predoc. 源代码文件使用 precode. 配置文件不注入.
// 同一 session 和场景按时间戳限制注入频率.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeInjection } from "./lib/guidance-md.mjs";

// 同 session 同场景的注入间隔:15 分钟
const THROTTLE_MS = 15 * 60 * 1000;
const DOC_EXT = new Set([".md", ".markdown"]);
const SKIP_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".lock", ".csv", ".txt"]);
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

// //// 从 hook 输入提取待编辑文件路径 [@x380kkm 2026-07-16] ////
function getEditedFilePaths(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  if (typeof toolInput.file_path === "string" && toolInput.file_path) return [toolInput.file_path];
  if (typeof toolInput.command !== "string") return [];
  return [...toolInput.command.matchAll(PATCH_FILE_HEADER)].map((match) => match[1].trim());
}
// //// /从 hook 输入提取待编辑文件路径 ////

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emit(obj) { process.stdout.write(JSON.stringify(obj ?? {})); process.exit(0); }

//// 防递归:嵌套 codex 子进程直接放行 [@380kkm 2026-06-22] ////
if (process.env.CODEX_HOOK_NESTED === "1") emit({});
//// /防递归 ////

//// 读 PreToolUse 输入并提取被编辑文件扩展名 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse((fs.readFileSync(0, "utf8") || "{}").replace(/^\uFEFF+/, "")); } catch { input = {}; }
const sessionId = input.session_id || "nosession";
const extensions = getEditedFilePaths(input.tool_input).map((filePath) => path.extname(filePath).toLowerCase());
//// /读 PreToolUse 输入 ////

//// 按扩展名选择全部适用的注入场景 [@380kkm 2026-06-22] ////
const tags = [];
if (extensions.some((ext) => DOC_EXT.has(ext))) tags.push("predoc");
if (extensions.length === 0 || extensions.some((ext) => !DOC_EXT.has(ext) && !SKIP_EXT.has(ext))) {
  tags.push("precode");
}
if (tags.length === 0) emit({});
//// /按扩展名定场景 ////

//// 从 AGENTS.md 组装适用场景和一份 plain [@380kkm 2026-06-22] ////
const ctx = composeInjection(tags);
if (!ctx) emit({});
//// /取注入内容 ////

//// 节流:同 session 同场景距上次注入不到 THROTTLE_MS 就放行 [@380kkm 2026-06-22] ////
const scenarioKey = tags.join("-");
const stampFile = path.join(os.tmpdir(), `codex-standards-${scenarioKey}-${sessionId}.stamp`);
const now = Date.now();
let last = 0;
try { last = parseInt(fs.readFileSync(stampFile, "utf8"), 10) || 0; } catch { last = 0; }
if (now - last < THROTTLE_MS) emit({});
try { fs.writeFileSync(stampFile, String(now)); } catch {}
//// /节流 ////

emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx } });
