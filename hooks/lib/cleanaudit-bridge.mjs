// audience: internal
// # cleanaudit-bridge
// 本模块定位并运行 cleanaudit.py.
// plan 子命令返回指定维度是否需要审计.
// context 子命令返回改动符号的有界上下文.
// 任一步骤失败时返回 audit 或 null.
// 调用 hook 随后执行完整审计.
// 查找顺序是 CLEANAUDIT_HOME, 仓库 tools 目录, 用户 Codex tools 目录.
// cleanaudit 使用临时解析, 不修改正式索引.
// PATH 上必须存在 uv. 被审项目必须是 Git 仓库.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// //// 定位 cleanaudit.py,找不到返回 null [@380kkm 2026-06-16] ////
function findCleanaudit() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CLEANAUDIT_HOME && path.join(process.env.CLEANAUDIT_HOME, "cleanaudit.py"),
    path.resolve(here, "..", "..", "tools", "cleanaudit", "cleanaudit.py"),
    path.join(os.homedir(), ".codex", "tools", "cleanaudit", "cleanaudit.py"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}
// //// /定位 cleanaudit.py ////

// //// 执行一个 cleanaudit 子命令,返回 stdout 字符串,失败返回 null [@380kkm 2026-06-16] ////
function runCleanaudit(args, cwd) {
  const script = findCleanaudit();
  if (!script) return null;
  const res = spawnSync("uv", ["run", "--python", "3.12", script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CODEX_HOOK_NESTED: "1" },
  });
  if (res.status !== 0 || res.error || !res.stdout) return null;
  return res.stdout;
}
// //// /执行 cleanaudit 子命令 ////

// //// 获取某维度的判定:返回 "skip" 或 "audit";任何不确定情况均返回 "audit"(fail-open 放行) [@380kkm 2026-06-16] ////
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

// //// 获取某维度的有界上下文(改动符号的字节片段);失败返回 null [@380kkm 2026-06-16] ////
export function boundedContext(dim, cwd) {
  const out = runCleanaudit(["context", "--root", cwd, "--dim", dim], cwd);
  return out && out.trim() ? out : null;
}
// //// /获取某维度的有界上下文 ////
