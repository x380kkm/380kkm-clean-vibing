// audience: internal
// # guidance-md
// 本模块从 Codex 用户级 AGENTS.md 抽取场景标记块.
// 同名标记的所有块按出现顺序拼接.
// 抽取结果不包含嵌套的标记注释.
// composeInjection 接受一个或多个场景标记.
// composeInjection 删除场景块内的 plain 标记块.
// composeInjection 在场景内容后附加一份 plain 内容.
// os.homedir() 定位用户级规则文件.
// 文件或标记不存在时返回空字符串.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//// 读用户级 Codex 规则全文;读不到时兼容读取迁移备份,仍失败则返回空串 [@380kkm 2026-06-22] ////
function readGuidanceMd() {
  const candidates = [
    path.join(os.homedir(), ".codex", "AGENTS.md"),
    path.join(os.homedir(), ".codex", "migrated", "claude-clean-vibing", "CLAUDE.md"),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      // 读取失败后继续尝试下一份迁移文件.
    }
  }
  return "";
}
//// /读用户级规则全文 ////

//// 取某标记下所有块的正文,去掉 CRLF;不删嵌套标记,无则返回空数组 [@380kkm 2026-06-22] ////
function rawBodies(tag) {
  const md = readGuidanceMd();
  if (!md) return [];
  const re = new RegExp(`<!--\\s*${tag}:start\\s*-->([\\s\\S]*?)<!--\\s*${tag}:end\\s*-->`, "g");
  return [...md.matchAll(re)].map((m) => m[1].replace(/\r/g, ""));
}
//// /取某标记下所有块的正文 ////

//// 删去一段正文里所有剩余标记注释,折叠空行,去首尾空白 [@380kkm 2026-06-22] ////
function clean(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
//// /删标记并清洗 ////

//// 把文本里某个嵌套标记从起标记到止标记的整段,连同紧跟的一个换行,一起删去 [@380kkm 2026-06-22] ////
function dropNested(text, nestedTag) {
  const re = new RegExp(`<!--\\s*${nestedTag}:start\\s*-->[\\s\\S]*?<!--\\s*${nestedTag}:end\\s*-->\\n?`, "g");
  return text.replace(re, "");
}
//// /删去嵌套标记整段 ////

//// 抽取某标记下所有块,清洗后以空行拼接;无则返回空串 [@380kkm 2026-06-22] ////
export function extractBlocks(tag) {
  return rawBodies(tag).map(clean).filter(Boolean).join("\n\n");
}
//// /拼接某标记下所有块 ////

//// 组装一个或多个场景的注入文本 [@380kkm 2026-06-22] ////
export function composeInjection(tags) {
  const uniqueTags = [...new Set(Array.isArray(tags) ? tags : [tags])].filter(Boolean);
  const scenarios = uniqueTags.flatMap((tag) =>
    rawBodies(tag).map((body) => clean(dropNested(body, "plain"))).filter(Boolean),
  );
  const plain = extractBlocks("plain");
  return [...scenarios, plain].filter(Boolean).join("\n\n");
}
//// /组装一个或多个场景的注入文本 ////
