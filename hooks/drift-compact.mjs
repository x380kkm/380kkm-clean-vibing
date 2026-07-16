// audience: internal
// # drift-compact-hook
// Stop hook:回合末起一个子 agent,把本会话的"要求了什么 + 做了什么 + 项目现状提示"
// 压缩,审计成一段简短回顾,写进会话状态文件,供下一回合 UserPromptSubmit 注入.
// 子 agent 只做判断,压缩,审计 - 它不跑 cleanread;真正的项目扫描仍是主 agent 自己的活,
// 回顾里只放一句提示:在为项目改代码时提示主 agent 自己去核对,不在改时提示无需参考项目.
// 正式索引由"每个任务完成后主 agent 跑一次正式重建"维护;本钩子的提示引导主 agent 在改代码前核对,并在任务收尾时正式重建.
// 不变量一:嵌套 codex 子进程(CODEX_HOOK_NESTED=1)直接放行,断开递归.
// 不变量二:stop_hook_active 为真表示本次停止由 hook 续写引发,直接放行,断开续写循环.
// 不变量三:子 agent 报错,超时,无输出或缺少路径归属时放行并保留旧回顾,绝不阻断会话.
// 不变量四:从不阻断 - 只准备状态,注入交给下一次 UserPromptSubmit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRecapCodex } from "./lib/nested-codex.mjs";

const MAX_TRANSCRIPT_CHARS = 24000;

// 放行退出,不阻断回合.
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

// //// 防递归:嵌套 codex 子进程直接放行 [@380kkm 2026-06-15] ////
if (process.env.CODEX_HOOK_NESTED === "1") allow();
// //// /防递归:嵌套 codex 子进程直接放行 ////

// //// 读取输入与会话状态 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse((fs.readFileSync(0, "utf8") || "{}").replace(/^\uFEFF+/, "")); } catch { allow(); }
const sessionId = input.session_id || "nosession";
const transcript = input.transcript_path;
const cwd = input.cwd || process.cwd();
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));

// //// 防续写循环:本次停止由 hook 续写引发时直接放行 [@380kkm 2026-07-09] ////
if (input.stop_hook_active) allow();
// //// /防续写循环 ////

if (!transcript || !fs.existsSync(transcript)) allow();
const stateFile = path.join(os.tmpdir(), "codex-drift-" + sessionId + ".json");
let state = { requests: [], recap: "" };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
if (!state || typeof state !== "object" || Array.isArray(state)) state = { requests: [], recap: "" };
const requests = Array.isArray(state.requests) ? state.requests : [];
// //// /读取输入与会话状态 ////

// //// 查找当前目录所属的项目根 [@380kkm 2026-07-16] ////
function findProjectRoot(dir) {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, "cleanread", "cleanread.json")) || fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
const currentProjectRoot = findProjectRoot(cwd);
// //// /查找当前目录所属的项目根 ////

// //// 取本回合转写末段喂给子 agent [@380kkm 2026-06-15] ////
let body = "";
try { body = fs.readFileSync(transcript, "utf8"); } catch { allow(); }
if (body.length > MAX_TRANSCRIPT_CHARS) body = body.slice(-MAX_TRANSCRIPT_CHARS);
// //// /取本回合转写末段喂给子 agent ////

// //// 组装提示词:按项目路径压缩,判断项目工作并审计 [@380kkm 2026-07-16] ////
const reqList = requests.map((r, i) => (i + 1) + ". " + r).join("\n");
const hintRule = `最后为 [涉及路径] 中的每个已识别路径分别写一行 [项目现状: 绝对路径]. 只统计该路径下发生的读取和修改, 不得把其他路径的工作归入其中. 代码仓库有改动时提醒主 agent 在修改前核对真实状态, 并在任务完成后重建 cleanread 索引. 用户配置目录只报告配置修改状态. 当前启动目录所属的项目根 ${currentProjectRoot || "未识别"} 只用于判断, 不得自动列为任务路径.`;
const RUBRIC = `你压缩会话状态, 并为主 agent 维护一份会话回顾. 输入包含用户请求列表和最近的 JSONL 对话转写.

当前 Codex 启动目录是 ${path.resolve(cwd)}. 它所属的项目根是 ${currentProjectRoot || "未识别"}. 用户级 Codex 配置目录是 ${codexHome}. 这些路径只用于判断归属, 不能把所有任务默认归到当前项目.

只输出一段简短中文回顾, 分三节:
[涉及路径] 列出本回顾涉及的每个项目根或配置目录的绝对路径. 根据用户请求和工具参数里的路径判断归属. 同一会话可以涉及多个项目. 无法确认归属时写 "路径未识别", 不得猜测或套用当前目录.
[要求了什么] 把用户请求列表归并成仍然有效的目标. 每条目标单独占一行, 并以 "[路径: 绝对路径]" 开头. 用户级 Codex 配置归到 ${codexHome}. 去掉已被推翻的要求. 合并同一路径内的重复要求, 不得合并不同路径的要求.
[做了什么] 检查转写里的工具动作. 每条事实单独占一行, 并以 "[路径: 绝对路径]" 开头. 根据被读写文件或命令工作目录确定归属. 只写真实发生过的编辑, 写入, 命令和子任务. 不同路径的动作不得混写. 命令或内容里若出现密钥, token 或密码, 一律用 "..." 替代.

${hintRule}

整段控制在 16 行以内. 只输出这段回顾本身, 不要解释或代码块围栏.

====== 用户请求列表 ======
${reqList || "(暂无)"}

====== 最近转写 (JSONL, 已截断到末段) ======
${body}`;
// //// /组装提示词:压缩,判断项目工作,审计 ////

// //// 检查每条要求和动作是否标明路径 [@380kkm 2026-07-16] ////
function getSectionLines(recap, startHeading, endHeading) {
  const start = recap.indexOf(startHeading);
  if (start < 0) return [];

  const contentStart = start + startHeading.length;
  const end = recap.indexOf(endHeading, contentStart);
  if (end < 0) return [];

  return recap
    .slice(contentStart, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasProjectPathAttribution(recap) {
  if (!recap.includes("[涉及路径]")) return false;

  const requirements = getSectionLines(recap, "[要求了什么]", "[做了什么]");
  const actions = getSectionLines(recap, "[做了什么]", "[项目现状:");
  const records = [...requirements, ...actions];
  return requirements.length > 0
    && actions.length > 0
    && records.every((line) => /^\[路径: (?!绝对路径\])[^\]\r\n]+\]/.test(line));
}
// //// /检查每条要求和动作是否标明路径 ////

// //// 起子 agent 产出回顾;失败则保留旧回顾放行 [@380kkm 2026-06-15] ////
const res = runRecapCodex({
  hookInput: input,
  input: RUBRIC,
  maxInputChars: 32_000,
  // 使用临时目录, 不加载当前项目上下文.
  cwd: os.tmpdir(),
  encoding: "utf8",
  timeout: 120000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status !== 0 || res.error || !res.stdout || !res.stdout.trim()) allow();
const recap = res.stdout.trim();
if (!hasProjectPathAttribution(recap)) allow();
// //// /起子 agent 产出回顾;失败则保留旧回顾放行 ////

// //// 写回状态,留痕,放行(从不阻断) [@380kkm 2026-06-15] ////
// 写回前重读一次,只更新 recap,避免覆盖期间 drift-record 追加的新请求(读改写竞态)
let fresh = state;
try {
  const f = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (f && typeof f === "object" && !Array.isArray(f)) fresh = f;
} catch { /* 读不到则退而使用启动时读取的快照 */ }
fresh.recap = recap;
try { fs.writeFileSync(stateFile, JSON.stringify(fresh)); } catch { /* 写失败下回合再来 */ }
try {
  const dir = path.join(cwd, "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "drift-recap.md"), recap, "utf8");
} catch { /* 留痕失败不阻断 */ }
allow();
// //// /写回状态,留痕,放行(从不阻断) ////
