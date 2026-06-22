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

//// 抽取某标记下所有块、拼接、剥掉块内嵌套标记注释与 CRLF；无则返回空串 [@380kkm 2026-06-22] ////
export function extractBlocks(tag) {
  const md = readClaudeMd();
  if (!md) return "";
  const re = new RegExp(`<!--\\s*${tag}:start\\s*-->([\\s\\S]*?)<!--\\s*${tag}:end\\s*-->`, "g");
  const blocks = [...md.matchAll(re)]
    .map((m) => m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean);
  return blocks.join("\n\n");
}
//// /抽取某标记下所有块 ////

//// 组装某场景的注入文本：场景块去掉与 plain 重复的行后附上 plain 块；都为空返回空串 [@380kkm 2026-06-22] ////
export function composeInjection(tag) {
  const plain = extractBlocks("plain");
  let scenario = extractBlocks(tag);
  if (scenario && plain) {
    const plainSet = new Set(plain.split("\n").map((l) => l.trim()).filter(Boolean));
    scenario = scenario.split("\n").filter((l) => !plainSet.has(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return [scenario, plain].filter(Boolean).join("\n\n");
}
//// /组装某场景的注入文本 ////
