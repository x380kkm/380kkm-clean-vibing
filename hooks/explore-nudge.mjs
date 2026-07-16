// audience: internal
// # explore-nudge
// 用户级 UserPromptSubmit hook:从 AGENTS.md 注入 presubmit 块(并行前先跑只读侦察 subagent),经
// hookSpecificOutput.additionalContext 进模型上下文;读不到则不注入.

import { extractBlocks } from "./lib/guidance-md.mjs";

const ctx = extractBlocks("presubmit");
const out = ctx
  ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } }
  : {};
process.stdout.write(JSON.stringify(out));
