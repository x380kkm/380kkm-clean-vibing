// audience: internal
// # manyread-rebuild-hook
// 异步 Stop hook：回合末，若当前项目有 manyread store 且源码自上次重建后有变化，
// 就重建 L1 索引并重跑 L2 富化。重建是全量 DROP+CREATE，会清空 symbols/edges，
// 因此必须紧接着跑 enrich 把 L2 补回来，否则索引会退化成只剩 L1。
// 不变量一：不是 manyread 项目（找不到 store）就直接退出，绝不在任意 repo 乱建索引。
// 不变量二：git 仓库按指纹判变化、无变化跳过；非 git 仓库用 120 秒去抖，避免每回合空转。
// 不变量三：嵌套 claude（如文风审计器）带 CLAUDE_HOOK_NESTED=1，见到即退出，断开递归。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

if (process.env.CLAUDE_HOOK_NESTED === "1") process.exit(0);

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { input = {}; }
const startCwd = input.cwd || process.cwd();

// //// 向上找 manyread store（mr-init 产出 manyread/manyread.json） [@380kkm 2026-06-13] ////
function findStore(dir) {
  let cur = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(cur, "manyread", "manyread.json"))) {
      return { root: cur, store: path.join(cur, "manyread") };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
const found = findStore(startCwd);
if (!found) process.exit(0);
const { root, store } = found;
// //// /向上找 manyread store ////

// //// 变化门控：git 按指纹、非 git 按去抖，决定是否值得重建 [@380kkm 2026-06-13] ////
function fingerprint(r) {
  try {
    const head = execSync("git rev-parse HEAD", { cwd: r, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: r, encoding: "utf8" });
    return `${head}:${dirty.length}:${dirty.split(/\r?\n/).length}`;
  } catch {
    return "nogit";
  }
}
const fpFile = path.join(store, ".last-hook-reindex");
const fp = fingerprint(root);
const isGit = fp !== "nogit";
let lastFp = "", lastMtime = 0;
try { lastFp = fs.readFileSync(fpFile, "utf8").trim(); } catch { /* 首次无记录 */ }
try { lastMtime = fs.statSync(fpFile).mtimeMs; } catch { /* 首次无记录 */ }
if (isGit) {
  if (lastFp === fp) process.exit(0);                 // 源码无变化，跳过
} else if (Date.now() - lastMtime < 120000) {
  process.exit(0);                                     // 非 git：120 秒去抖
}
// //// /变化门控 ////

// //// 定位已安装插件脚本（取最新版本，回退 marketplace 检出） [@380kkm 2026-06-13] ////
function resolveScript(name) {
  const base = path.join(os.homedir(), ".claude", "plugins");
  const cacheDir = path.join(base, "cache", "manyread", "manyread");
  try {
    const vers = fs.readdirSync(cacheDir)
      .filter(v => fs.existsSync(path.join(cacheDir, v, "scripts", name)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (vers.length) return path.join(cacheDir, vers[vers.length - 1], "scripts", name);
  } catch { /* 无 cache，回退 */ }
  const mk = path.join(base, "marketplaces", "manyread", "scripts", name);
  return fs.existsSync(mk) ? mk : null;
}
const idx = resolveScript("index_build.py");
const enr = resolveScript("enrich_treesitter.py");
if (!idx) process.exit(0);
// //// /定位已安装插件脚本 ////

// //// 重建 L1 后补 L2，记录指纹 [@380kkm 2026-06-13] ////
function run(script) {
  execFileSync("uv", ["run", "--python", "3.12", script, "--root", root], {
    stdio: "ignore",
    timeout: 240000,
  });
}
try {
  run(idx);                                  // L1 全量重建（清空 symbols/edges）
  if (enr) run(enr);                          // L2 富化（把 symbols/edges 补回来）
  fs.writeFileSync(fpFile, fp);               // 记录本次指纹，供下次比对
} catch { /* 重建失败：异步、不阻断会话，静默退出 */ }
process.exit(0);
// //// /重建 L1 后补 L2，记录指纹 ////
