// audience: internal
// # session-start-reminders
// 用户级 SessionStart hook：开工时从 CLAUDE.md 注入 presession 块（工作流、opus 与审计、scout 编排）外加
// plain 块（平直语言），经 hookSpecificOutput.additionalContext 进模型上下文。读码与改代码的具体规范分别
// 由 preread 与 standards 在各自触发点注入，不在这里重复。内容全部来自 CLAUDE.md，读不到则不注入。

import { composeInjection } from "./lib/claude-md.mjs";

//// 从 CLAUDE.md 组装 presession 场景注入文本（场景块加去重后的 plain）；为空则不注 [@380kkm 2026-06-22] ////
const ctx = composeInjection("presession");
const out = ctx
  ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }
  : {};
process.stdout.write(JSON.stringify(out));
//// /注入 presession 与 plain ////
