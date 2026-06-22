// audience: internal
// # stop-reminders
// 用户级 Stop hook：任务收尾时把重建正式索引与按需文风审计的提醒注入模型上下文，走非阻塞的
// hookSpecificOutput.additionalContext 通道，使主 agent 据此收尾，而不是只显示给用户。
// 读取 stdin 的 Stop 事件 JSON。两条不变量：stop_hook_active 为真表示本次停止由上一条提醒的续写
// 引发，直接放行以断开续写循环；cwd 非 git 仓库或工作区干净时也直接放行，只在确有未提交改动、
// 值得收尾时才注入提醒。

import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REMINDER =
  "收尾提醒：本回合工作区有未提交改动。结束前按需收尾——改了代码就跑一次正式 cleanread 重建" +
  "（index_build 加 enrich）刷新正式索引，写了文档或大改注释就拉一次文风审计；无需收尾动作时直接结束。";

//// 输出一段 hook JSON 并退出 [@380kkm 2026-06-22] ////
function emit(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
  process.exit(0);
}
//// /输出 hook JSON 并退出 ////

//// 探测 dir 的 git 工作区是否有未提交改动；在 dir 下跑 git，非 git、目录不存在或命令失败时按无改动处理 [@380kkm 2026-06-22] ////
function hasUncommittedChanges(dir) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", timeout: 5000 });
  if (res.error || res.status !== 0) return false;
  return res.stdout.trim().length > 0;
}
//// /探测 git 工作区是否有未提交改动 ////

//// 读取 Stop 事件输入；解析失败按空对象处理 [@380kkm 2026-06-22] ////
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const cwd = input.cwd || process.cwd();

//// 本次停止由上一条提醒引发时直接放行，断开续写循环 [@380kkm 2026-06-22] ////
if (input.stop_hook_active) emit({});

//// 仅在确有未提交改动时注入收尾提醒，对话继续供主 agent 收尾 [@380kkm 2026-06-22] ////
if (!hasUncommittedChanges(cwd)) emit({});
emit({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: REMINDER } });
