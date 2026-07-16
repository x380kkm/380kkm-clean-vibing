// audience: internal
// # nested-codex
// hooks 通过本模块启动隔离的 Codex 子进程.
// 只有 root thread hook 可以启动子进程.
// Native subagent, tool agent 和无法识别的 thread 都返回跳过结果.
// 所有嵌套任务使用 gpt-5.6-luna.
// 注释一致性检查与对话回顾使用 xhigh. 其他只读审计使用 medium.
// 子进程使用标准 service tier, 并关闭与任务无关的扩展功能.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

// //// 定义嵌套 `Codex` 的公共参数与任务模型 [@x380kkm 2026-07-15] ////
const CODEX_EXEC_ARGS = [
  "exec",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--ephemeral",
  "--disable", "hooks",
  "--disable", "fast_mode",
  "--disable", "apps",
  "--disable", "plugins",
  "--disable", "multi_agent",
  "--disable", "memories",
  "--disable", "goals",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--config", 'service_tier="default"',
  "--config", "notify=[]",
];
const COMMENT_TEST_MODEL = {
  model: "gpt-5.6-luna",
  reasoningEffort: "xhigh",
  maxInputChars: 100_000,
  projectDocMaxBytes: 32768,
  sandboxMode: "workspace-write",
};
const RECAP_MODEL = {
  model: "gpt-5.6-luna",
  reasoningEffort: "xhigh",
  maxInputChars: 100_000,
  projectDocMaxBytes: 0,
  sandboxMode: "read-only",
};
const READ_ONLY_AUDIT_MODEL = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  maxInputChars: 100_000,
  projectDocMaxBytes: 0,
  sandboxMode: "read-only",
};
const SKIPPED_RESULT = Object.freeze({
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  error: undefined,
  skipped: true,
});
// //// /定义嵌套 `Codex` 的公共参数与任务模型 ////

// //// 读取 transcript 的第一条 JSON 记录 [@x380kkm 2026-07-16] ////
function readFirstTranscriptRecord(transcriptPath) {
  const file = fs.openSync(transcriptPath, "r");
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);

  try {
    while (true) {
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    fs.closeSync(file);
  }

  const line = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF+/, "").replace(/\r$/, "");
  return line ? JSON.parse(line) : null;
}
// //// /读取 transcript 的第一条 JSON 记录 ////

// //// 确认 hook 来自 root thread [@x380kkm 2026-07-16] ////
export function isRootThreadHook(hookInput) {
  if (hookInput?.parent_thread_id || hookInput?.source?.subagent) return false;

  const directSource = hookInput?.thread_source;
  if (directSource === "subagent") return false;
  if (directSource === "user") return true;

  const transcriptPath = hookInput?.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) return false;

  try {
    const record = readFirstTranscriptRecord(transcriptPath);
    const payload = record?.type === "session_meta" ? record.payload : null;
    if (!payload || payload.thread_source !== "user") return false;
    if (payload.parent_thread_id || payload.source?.subagent) return false;
    return true;
  } catch {
    return false;
  }
}
// //// /确认 hook 来自 root thread ////

// //// 截断模型输入并保留首尾上下文 [@x380kkm 2026-07-15] ////
export function truncateModelInput(text, maxChars) {
  if (text.length <= maxChars) return text;

  const marker = "\n\n====== 中间内容已截断 ======\n\n";
  const retainedChars = maxChars - marker.length;
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return text.slice(0, headChars) + marker + text.slice(-tailChars);
}
// //// /截断模型输入并保留首尾上下文 ////

// //// 使用指定任务模型启动嵌套 `Codex` 子进程 [@x380kkm 2026-07-15] ////
function runNestedCodex(modelConfig, options) {
  if (!isRootThreadHook(options.hookInput)) return SKIPPED_RESULT;

  const args = [
    ...CODEX_EXEC_ARGS,
    "--model",
    modelConfig.model,
    "--config",
    `model_reasoning_effort="${modelConfig.reasoningEffort}"`,
    "--config",
    `project_doc_max_bytes=${modelConfig.projectDocMaxBytes}`,
    "--sandbox",
    modelConfig.sandboxMode,
    "-",
  ];
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    CODEX_HOOK_NESTED: "1",
  };
  const { hookInput, maxInputChars, ...spawnOptions } = options;
  const input = truncateModelInput(
    spawnOptions.input,
    maxInputChars ?? modelConfig.maxInputChars,
  );

  return spawnSync("codex", args, { ...spawnOptions, input, env });
}
// //// /使用指定任务模型启动嵌套 `Codex` 子进程 ////

// //// 启动注释一致性测试子进程 [@x380kkm 2026-07-15] ////
export function runCommentTestCodex(options) {
  return runNestedCodex(COMMENT_TEST_MODEL, options);
}
// //// /启动注释一致性测试子进程 ////

// //// 启动对话回顾子进程 [@x380kkm 2026-07-16] ////
export function runRecapCodex(options) {
  return runNestedCodex(RECAP_MODEL, options);
}
// //// /启动对话回顾子进程 ////

// //// 启动只读审计任务子进程 [@x380kkm 2026-07-16] ////
export function runReadOnlyAuditCodex(options) {
  return runNestedCodex(READ_ONLY_AUDIT_MODEL, options);
}
// //// /启动只读审计任务子进程 ////
