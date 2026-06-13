// audience: internal
// # manyread-grounding-hook
// 阻塞型 Stop hook：在已建索引的项目里，若本回合改动或查阅了项目代码却全程没用过 manyread，
// 就打断一次，提醒先用 manyread 核对当前结构再结束，避免 agent 因少用该工具而与真实代码漂移。
// 与文风审计同为回合末 Stop hook，判断纯靠扫描转写、不调用模型，因此几乎不会误判文风。
// 不变量一：找不到 manyread store（非索引项目）就放行，不在没有索引的仓库里强求。
// 不变量二：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量三：同一回合最多提醒 MAX_BLOCKS 次，超出就放行，防止打断死循环。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BLOCKS = 1;          // 每个回合最多提醒一次
const READ_THRESHOLD = 3;      // 纯查阅达到这么多次才算"做了项目工作"

function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

// //// 防递归与基本输入 [@380kkm 2026-06-13] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const transcript = input.transcript_path;
const sessionId = input.session_id || "nosession";
const cwd = input.cwd || process.cwd();
// //// /防递归与基本输入 ////

// //// 非 manyread 项目放行 [@380kkm 2026-06-13] ////
function hasStore(dir) {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, "manyread", "manyread.json"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}
if (!hasStore(cwd)) allow();
if (!transcript || !fs.existsSync(transcript)) allow();
// //// /非 manyread 项目放行 ////

// //// 扫描本回合的工具使用 [@380kkm 2026-06-13] ////
const lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter(Boolean);

// 找本回合起点：最后一条带正文的用户提问（排除纯 tool_result 的用户记录）
function isUserPrompt(rec) {
  const role = rec.type || (rec.message && rec.message.role);
  if (role !== "user") return false;
  const c = rec.message ? rec.message.content : rec.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c)) return c.some(b => b && b.type === "text" && String(b.text || "").trim());
  return false;
}
let start = 0;
for (let i = lines.length - 1; i >= 0; i--) {
  let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
  if (isUserPrompt(rec)) { start = i; break; }
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const MANYREAD_RE = /manyread|manyscan|mr[-_](query|init|enrich|deps|ref|trace|boundary|rules)|query\.py/i;
const BASH_READ_RE = /\b(grep|rg|cat|head|tail|sed|awk|find)\b/;

let edits = 0, reads = 0, usedManyread = false;
for (let i = start + 1; i < lines.length; i++) {
  let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
  const role = rec.type || (rec.message && rec.message.role);
  if (role !== "assistant") continue;
  const content = rec.message ? rec.message.content : rec.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (!b || b.type !== "tool_use") continue;
    const name = b.name || "";
    const blob = name + " " + JSON.stringify(b.input || {});
    if (MANYREAD_RE.test(blob)) { usedManyread = true; continue; }
    if (EDIT_TOOLS.has(name)) edits++;
    else if (READ_TOOLS.has(name)) reads++;
    else if (name === "Bash" && BASH_READ_RE.test(String((b.input && b.input.command) || ""))) reads++;
  }
}
// //// /扫描本回合的工具使用 ////

// //// 据此放行或提醒 [@380kkm 2026-06-13] ////
const countFile = path.join(os.tmpdir(), `claude-mr-ground-${sessionId}.count`);
const getC = () => { try { return parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { return 0; } };
const setC = (n) => { try { fs.writeFileSync(countFile, String(n)); } catch { /* 忽略 */ } };

const didProjectWork = edits >= 1 || reads >= READ_THRESHOLD;
if (!didProjectWork || usedManyread) { setC(0); allow(); }   // 没动项目，或已经用过 manyread

const n = getC() + 1;
if (n > MAX_BLOCKS) {
  setC(0);
  allow({ systemMessage: "本回合改动了项目却未用 manyread 核对；已不再打断，请留意是否与真实代码漂移。" });
}
setC(n);
allow({
  decision: "block",
  reason: "本回合改动或查阅了项目代码，但全程没有用 manyread 核对当前结构。请先用 manyread（例如 /mr-query，或运行其 query.py）确认相关符号、依赖与结构的真实状态，再结束本回合，以免你的理解与实际代码发生漂移。",
});
// //// /据此放行或提醒 ////
