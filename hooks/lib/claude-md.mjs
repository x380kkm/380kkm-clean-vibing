// audience: internal
// # claude-md
// 从用户级 CLAUDE.md 按场景标记块抽取内容，供各提醒钩子共用，使 CLAUDE.md 成为单一事实源。
// 一个标记是一对 <!-- tag:start --> 与 <!-- tag:end --> 注释；同名标记可有多块，全部拼接。抽取时剥掉
// 块内嵌套的标记注释，使重叠标记（如 plain 嵌在 precode 内）的标记文本不进入输出。
// composeInjection 用嵌套 plain 标记的边界把场景块里的 plain 整段连标记切掉，再统一附一份 plain，不靠文本比对。
// 用 os.homedir() 定位 CLAUDE.md，不含机器特定路径。读不到或无该标记时返回空串，由调用方决定是否跳过。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//// 读用户级 CLAUDE.md 全文；读不到返回空串 [@380kkm 2026-06-22] ////
function readClaudeMd() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".claude", "CLAUDE.md"), "utf8");
  } catch {
    return "";
  }
}
//// /读用户级 CLAUDE.md ////

//// 取某标记下所有块的正文、去掉 CRLF；不剥嵌套标记，无则返回空数组 [@380kkm 2026-06-22] ////
function rawBodies(tag) {
  const md = readClaudeMd();
  if (!md) return [];
  const re = new RegExp(`<!--\\s*${tag}:start\\s*-->([\\s\\S]*?)<!--\\s*${tag}:end\\s*-->`, "g");
  return [...md.matchAll(re)].map((m) => m[1].replace(/\r/g, ""));
}
//// /取某标记下所有块的正文 ////

//// 剥掉一段正文里所有剩余标记注释、折叠空行、去首尾空白 [@380kkm 2026-06-22] ////
function clean(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
//// /剥标记并清洗 ////

//// 把一段正文里嵌套的某标记整段（标记带内容连同尾随换行）删掉 [@380kkm 2026-06-22] ////
function dropNested(text, nestedTag) {
  const re = new RegExp(`<!--\\s*${nestedTag}:start\\s*-->[\\s\\S]*?<!--\\s*${nestedTag}:end\\s*-->\\n?`, "g");
  return text.replace(re, "");
}
//// /删去嵌套标记整段 ////

//// 抽取某标记下所有块、清洗后以空行拼接；无则返回空串 [@380kkm 2026-06-22] ////
export function extractBlocks(tag) {
  return rawBodies(tag).map(clean).filter(Boolean).join("\n\n");
}
//// /拼接某标记下所有块 ////

//// 组装某场景注入文本：场景块按嵌套边界切掉 plain 后清洗，再统一附一份 plain；都为空返回空串 [@380kkm 2026-06-22] ////
export function composeInjection(tag) {
  const scenario = rawBodies(tag).map((body) => clean(dropNested(body, "plain"))).filter(Boolean).join("\n\n");
  const plain = extractBlocks("plain");
  return [scenario, plain].filter(Boolean).join("\n\n");
}
//// /组装某场景注入文本 ////
