// audience: internal
// # stop-reminders
// Stop hook 在工作区有未提交改动时请求 Codex 继续完成收尾.
// 续写原因提醒主 agent 重建正式索引, 并按改动类型启动独立文风审计.
// 输入来自 stdin 的 Stop 事件 JSON.
// stop_hook_active 为真时直接放行, 同一提醒不会反复续写.
// cwd 不是 Git 仓库或工作区无改动时直接放行.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REMINDER =
  "收尾提醒: 本回合工作区有未提交改动. 结束前按需收尾. 改了代码就运行一次正式 cleanread 重建" +
  " (index_build 加 enrich) 刷新正式索引. 写了文档或大改注释就启动一次独立文风审计. 无需收尾动作时直接结束.";

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emit(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
  process.exit(0);
}
//// /输出 hook JSON 并退出 ////

//// 探测 dir 的 git 工作区是否有未提交改动;在 dir 下跑 git,非 git,目录不存在或命令失败时按无改动处理 [@380kkm 2026-06-22] ////
function hasUncommittedChanges(dir) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  if (res.error || res.status !== 0) return false;
  return res.stdout.trim().length > 0;
}
//// /探测 git 工作区是否有未提交改动 ////

//// 读取 Stop 事件输入;解析失败按空对象处理 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse((fs.readFileSync(0, "utf8") || "{}").replace(/^\uFEFF+/, "")); } catch { input = {}; }
const cwd = input.cwd || process.cwd();

//// 本次停止由上一条提醒引发时直接放行,断开续写循环 [@380kkm 2026-06-22] ////
if (input.stop_hook_active) emit({});

//// 仅在确有未提交改动时请求主 agent 继续收尾 [@380kkm 2026-06-22] ////
if (!hasUncommittedChanges(cwd)) emit({});
emit({ decision: "block", reason: REMINDER });
