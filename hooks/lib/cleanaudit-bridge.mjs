// audience: internal
// # cleanaudit-bridge
// 审计钩子调用 cleanaudit 预过滤器的共享桥接：定位 cleanaudit.py、执行 plan 子命令获取维度判定、
// 执行 context 子命令获取改动符号的有界上下文。任何一步失败一律 fail-open（出错时放行而非阻断），返回 audit 让钩子回退整审。
// 解析顺序：环境变量 CLEANAUDIT_HOME > 钩子同级的 ../tools/cleanaudit > ~/.claude/tools/cleanaudit。
// cleanaudit 对改动文件做进程内临时解析、不碰正式索引，故本桥接无需先刷新索引——审计永远看当前真相，
// 正式索引由「每个任务后的正式重建」单独维护（见 stop-reminders 的提醒）。
// 运行前提：PATH 上有 uv；被审项目是 git 仓库。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// //// 定位 cleanaudit.py，找不到返回 null [@380kkm 2026-06-16] ////
function findCleanaudit() {
  // fileURLToPath 跨平台且自动百分号解码，安装目录含空格或 Unicode 时仍能正确定位
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CLEANAUDIT_HOME && path.join(process.env.CLEANAUDIT_HOME, "cleanaudit.py"),
    path.resolve(here, "..", "..", "tools", "cleanaudit", "cleanaudit.py"),
    path.join(os.homedir(), ".claude", "tools", "cleanaudit", "cleanaudit.py"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 跳过 */ }
  }
  return null;
}
// //// /定位 cleanaudit.py ////

// //// 执行一个 cleanaudit 子命令，返回 stdout 字符串，失败返回 null [@380kkm 2026-06-16] ////
function runCleanaudit(args, cwd) {
  const script = findCleanaudit();
  if (!script) return null;
  const res = spawnSync("uv", ["run", "--python", "3.12", script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CLAUDE_HOOK_NESTED: "1" },  // 标记嵌套调用，防止触发其他钩子
  });
  if (res.status !== 0 || res.error || !res.stdout) return null;
  return res.stdout;
}
// //// /执行 cleanaudit 子命令 ////

// //// 获取某维度的判定：返回 "skip" 或 "audit"；任何不确定情况均返回 "audit"（fail-open 放行） [@380kkm 2026-06-16] ////
export function planDimension(dim, cwd) {
  const out = runCleanaudit(["plan", "--root", cwd, "--dims", dim], cwd);
  if (!out) return "audit";
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return "audit";
  try {
    const obj = JSON.parse(m[0]);
    const d = (obj.decisions || []).find((x) => x.dim === dim);
    return d && d.action === "skip" ? "skip" : "audit";
  } catch {
    return "audit";
  }
}
// //// /获取某维度的判定 ////

// //// 获取某维度的有界上下文（改动符号的字节片段）；失败返回 null [@380kkm 2026-06-16] ////
export function boundedContext(dim, cwd) {
  const out = runCleanaudit(["context", "--root", cwd, "--dim", dim], cwd);
  return out && out.trim() ? out : null;
}
// //// /获取某维度的有界上下文 ////
