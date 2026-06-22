// audience: internal
// # claude-md
// 从用户级 CLAUDE.md 按场景标记块抽取内容，供各提醒钩子共用，使 CLAUDE.md 成为单一事实源。
// 一个标记是一对 <!-- tag:start --> 与 <!-- tag:end --> 注释；同名标记可有多块，全部拼接。抽取时剥掉
// 块内嵌套的标记注释，避免重叠标记（如 plain 嵌在 precode 内）把标记文本带进输出。
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

//// 抽取某标记下所有块，各自剥掉嵌套标记注释与 CRLF、折叠空行、去首尾空白；无则返回空数组 [@380kkm 2026-06-22] ////
function extractRawBlocks(tag) {
  const md = readClaudeMd();
  if (!md) return [];
  const re = new RegExp(`<!--\\s*${tag}:start\\s*-->([\\s\\S]*?)<!--\\s*${tag}:end\\s*-->`, "g");
  return [...md.matchAll(re)]
    .map((m) => m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean);
}
//// /抽取某标记下所有块 ////

//// 抽取某标记下所有块并以空行拼接；无则返回空串 [@380kkm 2026-06-22] ////
export function extractBlocks(tag) {
  return extractRawBlocks(tag).join("\n\n");
}
//// /拼接某标记下所有块 ////

//// 从文本删去某段原文连同其相邻换行，两侧都有内容时以单个换行接合 [@380kkm 2026-06-22] ////
function stripBlock(text, block) {
  let i = text.indexOf(block);
  while (i !== -1) {
    let start = i, end = i + block.length;
    while (start > 0 && text[start - 1] === "\n") start--;
    while (end < text.length && text[end] === "\n") end++;
    const joiner = start > 0 && end < text.length ? "\n" : "";
    text = text.slice(0, start) + joiner + text.slice(end);
    i = text.indexOf(block);
  }
  return text;
}
//// /删去某段原文 ////

//// 组装某场景注入文本：从场景块删去每个 plain 块原文，再统一附一份 plain；都为空返回空串 [@380kkm 2026-06-22] ////
export function composeInjection(tag) {
  const plainBlocks = extractRawBlocks("plain");
  let scenario = extractBlocks(tag);
  if (scenario && plainBlocks.length) {
    for (const block of plainBlocks) scenario = stripBlock(scenario, block);
    scenario = scenario.trim();
  }
  return [scenario, plainBlocks.join("\n\n")].filter(Boolean).join("\n\n");
}
//// /组装某场景注入文本 ////
