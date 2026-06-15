// audience: internal
// # drift-compact-hook
// Stop hook：回合末起一个子 agent，把本会话的「要求了什么 + 做了什么 + 项目现状提示」
// 压缩、审计成一段简短回顾，写进会话状态文件，供下一回合 UserPromptSubmit 注入。
// 子 agent 只做判断、压缩、审计——它不跑 manyread；真正的项目扫描仍是主 agent 自己的活，
// 回顾里只放一句提示：在为项目改代码时提示主 agent 自己去核对，不在改时提示无需参考项目。
// 与同在 Stop 的 manyread-rebuild 成一组：那个钩子在代码改动后异步重建索引，本钩子的提示再引导主 agent 去查这份新鲜索引。
// 不变量一：嵌套 claude 进程（CLAUDE_HOOK_NESTED=1）直接放行，断开递归。
// 不变量二：子 agent 报错/超时/无输出一律放行并保留旧回顾，绝不阻断会话。
// 不变量三：从不阻断——只准备状态，注入交给下一次 UserPromptSubmit。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_CHARS = 60000;   // 喂给子 agent 的转写截断长度（取末尾，最近的最相关）

// 放行退出，不阻断回合。
function allow() { process.exit(0); }

// //// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-15] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
// //// /防递归：嵌套 claude 进程直接放行 ////

// //// 读取输入与会话状态 [@380kkm 2026-06-15] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { allow(); }
const sessionId = input.session_id || "nosession";
const transcript = input.transcript_path;
const cwd = input.cwd || process.cwd();
if (!transcript || !fs.existsSync(transcript)) allow();
const stateFile = path.join(os.tmpdir(), "claude-drift-" + sessionId + ".json");
let state = { requests: [], recap: "" };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* 首次无状态 */ }
if (!state || typeof state !== "object" || Array.isArray(state)) state = { requests: [], recap: "" };
const requests = Array.isArray(state.requests) ? state.requests : [];
// //// /读取输入与会话状态 ////

// //// 判断当前目录是不是项目仓库（有 manyread 索引或 .git） [@380kkm 2026-06-15] ////
function isProjectDir(dir) {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, "manyread", "manyread.json")) || fs.existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}
const inRepo = isProjectDir(cwd);
// //// /判断当前目录是不是项目仓库（有 manyread 索引或 .git） ////

// //// 取本回合转写末段喂给子 agent [@380kkm 2026-06-15] ////
let body = "";
try { body = fs.readFileSync(transcript, "utf8"); } catch { allow(); }
if (body.length > MAX_CHARS) body = body.slice(-MAX_CHARS);
// //// /取本回合转写末段喂给子 agent ////

// //// 组装 rubric：压缩 + 判断项目工作 + 审计 [@380kkm 2026-06-15] ////
const reqList = requests.map((r, i) => (i + 1) + ". " + r).join("\n");
const hintRule = inRepo
  ? "最后补一行【项目现状】：判断本会话最近是否在为当前仓库改代码（转写里有没有对项目源码的 Edit/Write，或多次 Read 项目文件）。若是，写：「动手改之前，主 agent 自己先用 manyread 核对相关符号与结构的真实状态再改；manyread 索引已由回合末钩子在代码改动后自动重建，直接查即可。」若否，写：「本会话不在为该项目改代码，无需参考项目代码。」"
  : "最后补一行【项目现状】：当前目录不是代码仓库，写「无需参考项目代码。」";
const RUBRIC = `你是一个会话状态压缩器，为主 agent 维护一份防漂变回顾。给你这个会话的用户请求列表，以及最近的对话转写（JSONL）。

只输出一段简短中文回顾，分两节：
【要求了什么】把用户请求列表归并成几条仍然有效的目标：去掉已被推翻的，合并重复的，保持用户原意，不要替他改主意。
【做了什么】扫转写里 assistant 的工具动作（编辑、写、运行的命令、起的子任务等），去掉用户原话与冗长输出，压成几条「做了某事、改了某文件、跑了某命令」的事实。只写真实发生过的，绝不编造——这一节就是审计要点，宁可少写也不要写没发生的。命令或内容里若出现密钥、token、密码等敏感串，一律用「…」占位替代，绝不原样写进回顾。

${hintRule}

整段控制在 12 行以内。只输出这段回顾本身，不要任何解释、不要代码块围栏。

====== 用户请求列表 ======
${reqList || "（暂无）"}

====== 最近转写（JSONL，已截断到末段） ======
${body}`;
// //// /组装 rubric：压缩 + 判断项目工作 + 审计 ////

// //// 起子 agent 产出回顾；失败则保留旧回顾放行 [@380kkm 2026-06-15] ////
const res = spawnSync("claude -p", {
  input: RUBRIC,
  shell: true,
  cwd: os.tmpdir(),                                    // 隔离：临时目录
  env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },    // 标记嵌套，避免递归
  encoding: "utf8",
  timeout: 120000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status !== 0 || res.error || !res.stdout || !res.stdout.trim()) allow();
const recap = res.stdout.trim();
// //// /起子 agent 产出回顾；失败则保留旧回顾放行 ////

// //// 写回状态、留痕、放行（从不阻断） [@380kkm 2026-06-15] ////
// 写回前重读一次、只更新 recap，避免覆盖期间 drift-record 追加的新请求（读改写竞态）
let fresh = state;
try {
  const f = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (f && typeof f === "object" && !Array.isArray(f)) fresh = f;
} catch { /* 读不到就用启动快照兜底 */ }
fresh.recap = recap;
try { fs.writeFileSync(stateFile, JSON.stringify(fresh)); } catch { /* 写失败下回合再来 */ }
try {
  const dir = path.join(cwd, "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "drift-recap.md"), recap, "utf8");
} catch { /* 留痕失败不阻断 */ }
allow();
// //// /写回状态、留痕、放行（从不阻断） ////
