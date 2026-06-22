// audience: internal
// # style-mode
// A/B 实验的模式解析器：决定本次 Stop 走哪一套文风处理。被 style-audit（A 边，阻塞重写）与
// style-rewrite-inject（B 边，外部流水线注入）共用，保证两者对同一会话给出一致判断、互不重叠。
// 默认（未设环境变量）一律返回 block，保持现有阻塞审计行为。设 CLAUDE_STYLE_MODE=inject 时返回
// inject、走 B；可再设 CLAUDE_STYLE_TEST_ROOT 为某目录，把 B 限制在该目录之下，当前目录不在其下
// 时退回 block。两个变量都按会话生效，本模块不含任何机器特定路径。

import path from "node:path";

//// 判断 dir 是否在 root 之下（含 root 自身），按规范化并小写后的路径前缀比对 [@380kkm 2026-06-22] ////
function isUnder(dir, root) {
  const a = path.resolve(dir).toLowerCase();
  const b = path.resolve(root).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}
//// /判断 dir 是否在 root 之下 ////

//// 解析本次 Stop 的文风模式：未开 inject 恒为 block；开了 inject 且设了限制目录则仅在该目录内生效 [@380kkm 2026-06-22] ////
export function resolveMode(cwd) {
  if (process.env.CLAUDE_STYLE_MODE !== "inject") return "block";
  const root = process.env.CLAUDE_STYLE_TEST_ROOT;
  if (root && cwd && !isUnder(cwd, root)) return "block";
  return "inject";
}
//// /解析本次 Stop 的文风模式 ////
