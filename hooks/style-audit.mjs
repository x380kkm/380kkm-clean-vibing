// audience: internal
// # style-audit-hook
// 阻塞型 Stop hook：把本回合最终回复落到 archive/，再用一个独立的、无项目上下文的
// claude 进程按平直语言标准审计；不通过就 block，把审计意见反馈给主 agent 改写重交。
// 运行前提：PATH 上有 claude CLI；审计进程用默认模型（用户配置的默认模型）。
// 不变量一：审计器报错/超时/无法解析一律放行（fail-open），绝不因审计器坏掉而卡死会话。
// 不变量二：审计自身起的 claude 进程带 CLAUDE_HOOK_NESTED=1，本脚本见到即放行，断开递归。
// 不变量三：同一回复最多打断 MAX_BLOCKS 次，超出则放行并告警，防 block 死循环。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveMode } from "./lib/style-mode.mjs";

const MIN_CHARS = 280;   // 短于此的回复（状态行、一句话汇报）跳过审计，减少不必要的调用开销
const MAX_BLOCKS = 2;    // 同一回复最多打断重写次数

// 输出一段 hook JSON 并按放行退出。
function allow(extra) {
  process.stdout.write(JSON.stringify(extra ?? {}));
  process.exit(0);
}

// //// 防递归：嵌套 claude 进程直接放行 [@380kkm 2026-06-13] ////
if (process.env.CLAUDE_HOOK_NESTED === "1") allow();
// //// /防递归 ////

// //// 读取 Stop hook 输入 [@380kkm 2026-06-13] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const transcript = input.transcript_path;
const sessionId = input.session_id || "nosession";
const cwd = input.cwd || process.cwd();
// //// /读取 Stop hook 输入 ////

// //// A/B 模式闸：inject 模式由 style-rewrite-inject 接管，本阻塞审计让位放行 [@380kkm 2026-06-22] ////
if (resolveMode(cwd) !== "block") allow();
// //// /A/B 模式闸 ////

// //// 从转写里取最后一条 assistant 文本 [@380kkm 2026-06-13] ////
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
const text = lastAssistantText(transcript);
if (text.length < MIN_CHARS) allow();   // 短回复跳过
// //// /从转写里取最后一条 assistant 文本 ////

// //// 落临时文档到 archive/（用户要求的前置一步） [@380kkm 2026-06-13] ////
try {
  const dir = path.join(cwd, "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "style-audit.md"), text, "utf8");
} catch { /* 写入失败时不阻断后续审计流程 */ }
// //// /落临时文档到 archive/ ////

// //// 重试计数（防 block 死循环） [@380kkm 2026-06-13] ////
const countFile = path.join(os.tmpdir(), `claude-style-audit-${sessionId}.count`);
const getCount = () => { try { return parseInt(fs.readFileSync(countFile, "utf8"), 10) || 0; } catch { return 0; } };
const setCount = (n) => { try { fs.writeFileSync(countFile, String(n)); } catch { /* 忽略 */ } };
// //// /重试计数 ////

const RUBRIC = `你是一个独立的中文写作风格审计器。只判断给定文本的"文风"，不评价其技术内容是否正确，也没有任何项目背景，不要试图理解项目。

判定标准（全部满足才算通过）：
1. 平直：完整句子；不用电报体或碎片短语；不用箭头链（如 A → B → 失败）；不堆砌缩写；新造的代号或缩写在首次出现时必须有半句解释。
2. 非过度简化：简洁不等于潦草——为了短而丢掉"读者据以行动所需的信息"算不通过；不要把完整推理压成无主语的碎句。
3. 没有翻译腔，没有营销词。
4. 中文用全角标点；中文与英文或数字之间留一个空格。

只输出一个 JSON 对象，不要任何其它文字、不要代码块围栏：
{"pass": true, "issues": []}
或
{"pass": false, "issues": ["具体问题，要可据以改写", "..."]}`;

// //// 起独立 claude 审计，解析裁决 [@380kkm 2026-06-13] ////
let verdict = null;
const res = spawnSync("claude -p", {
  input: `${RUBRIC}\n\n====== 待审文本 ======\n${text}`,
  shell: true,
  cwd: os.tmpdir(),                                       // 隔离：临时目录，无项目上下文
  env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },       // 标记嵌套，避免递归审计
  encoding: "utf8",
  timeout: 180000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status === 0 && !res.error && res.stdout) {
  const m = res.stdout.match(/\{[\s\S]*\}/);
  if (m) { try { verdict = JSON.parse(m[0]); } catch { verdict = null; } }
}
if (!verdict || typeof verdict.pass !== "boolean") {
  setCount(0);
  allow({ systemMessage: "文风审计未能运行或返回无法解析，本次已放行。" });
}
// //// /起独立 claude 审计，解析裁决 ////

// //// 据裁决决定放行或打断 [@380kkm 2026-06-13] ////
if (verdict.pass) {
  setCount(0);
  allow();
}
const n = getCount() + 1;
if (n > MAX_BLOCKS) {
  setCount(0);
  allow({ systemMessage: `文风审计连续 ${MAX_BLOCKS} 次未通过，已放行，请人工复核上一条回复。` });
}
setCount(n);
const issues = Array.isArray(verdict.issues) && verdict.issues.length
  ? verdict.issues.map(s => `- ${s}`).join("\n")
  : "（审计器未给出具体问题）";
allow({
  decision: "block",
  reason: `文风审计未通过（第 ${n}/${MAX_BLOCKS} 次）。请把上一条回复改写后重新输出，保持平直、完整句子、非过度简化（不电报体、不缩写、不造词）：\n${issues}`,
});
// //// /据裁决决定放行或打断 ////
