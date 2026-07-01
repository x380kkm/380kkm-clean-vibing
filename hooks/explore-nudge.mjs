// audience: internal
// # explore-nudge
// 用户级 UserPromptSubmit hook：从 CLAUDE.md 注入 presubmit 块（并行前先跑侦察 workflow），经
// hookSpecificOutput.additionalContext 进模型上下文；读不到则不注入。

import { extractBlocks } from "./lib/claude-md.mjs";

const ctx = extractBlocks("presubmit");
const out = ctx
  ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } }
  : {};
process.stdout.write(JSON.stringify(out));
