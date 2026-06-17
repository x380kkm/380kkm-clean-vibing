---
name: clean-tools
description: 读码、查依赖、回合末审计的本地工具族（cleanread 加 cleanscan 加 cleanaudit）。主动使用：读、搜、解释、追踪代码，或做依赖与影响分析之前先走它，不要先用 ls、grep、cat、Read 扫仓库；无索引时先建。这些是经 uv 运行的脚本，不是插件。
---

# clean-tools

三件工具，经 `uv run --python 3.12 <脚本>` 运行（脚本带 PEP 723 内联依赖，首次自动装；需 Python ≥ 3.12）。
脚本根：`<本仓库>/tools/cleanread`（含子目录 `cleanscan`）与 `<本仓库>/tools/cleanaudit`。读取 SQL 结果与符号，
不读取整个文件。

## cleanread —— 把源码索引进本地 SQLite，按需有界检索

- 建索引：`tools/cleanread/index_build.py --init --root R --langs python,cpp` 再 `tools/cleanread/enrich_treesitter.py --root R`。
- 查询：`tools/cleanread/query.py --root R "<SQL>"`（结果走 stdout，自动记 trace；`--no-log` 关闭）。
- 库表：`files(id,path,ext,size,mtime,content)`；`symbols(id,file_id,name,kind,lang,start_line,end_line,start_byte,end_byte,parent_id,attrs,provenance)`（attrs 与 provenance 是 override 规则写入的 json 溯源列）；`edges(id,file_id,src_symbol_id,dst_symbol_id,dst_name,relation)`，relation ∈ {calls,imports,uses_type,contains,extends,implements}（references 仅在 `enrich --refs` 时产出）；`files_fts`（trigram 全文，即把内容切成三字符序列，任意子串 `MATCH` 命中）。
- 检索纪律：先 `files_fts MATCH` 或查 `symbols` 收窄到 path 与跨度，再有界提取，绝不读取整个文件。
- 有界提取按符号字节跨度用 `slice_bytes`，不要用 `substr`（substr 按字符计数，符号前有中文时会错位）；按文本锚点用 `instr` 配 `substr`（都按字符）：
  - `SELECT slice_bytes(content, start_byte, end_byte-start_byte) FROM files WHERE path=?`
- 其它：`ref.py`（可提交的剪枝阅读工作区）、`rules.py`（项目级解析修正规则，人审 preview 后才写）、`trace.py`（跨会话查询记忆，static/dynamic 双轨，陈旧由人 keep/shelve/clear）。

## cleanscan —— 有界的依赖、影响、边界分析（建在 cleanread 索引之上，只读）

面向 agent 的精简命令，输出紧凑 JSON，带 `path:line` 锚点与置信度；结果被预算截断时显式标注，绝不悄悄丢弃：
- `tools/cleanread/cleanscan/scan.py impact <符号> --store R/cleanread`：谁依赖它（反向调用方），同名歧义会标 `ambiguous`。
- `... interface --target-root <相对目录> --store R/cleanread`：这块对外依赖的接口，每条带置信度（取值为命中唯一 `unique`、多义 `ambiguous`、未解析到目标 `unresolved` 三种状态之一）。
- `... seam <符号> --store R/cleanread`：可拆分处（桥与关节节点）。
人用可视化（原样保留）：`scan`、`analyze`、`boundary --format html|json|mermaid|dot`。典型用法：`cleanscan` 定位 `path:line`，再由 `cleanread` 提取对应源码片段。

## cleanaudit —— 回合末确定性后审计预过滤（不碰正式索引）

- `tools/cleanaudit/cleanaudit.py plan --root R [--dims comment,doc-sync,jargon]`：判定每个维度要不要起模型审计。
- `... changeset --root R`：本回合改动的符号；`... context --root R --dim comment`：改动符号的当前有界源码。
- 对改动文件做进程内临时解析（复用 cleanread 的 tree-sitter 抽取），用完即弃，从不读写正式索引。

## 临时索引与正式索引（互相隔离，防止相互污染）

- 回合内审计用临时解析（cleanaudit，不落盘、不碰 `source.db`）。
- 正式索引每个任务完成后正式重建：`index_build.py` 全量 + `enrich_treesitter.py`，产物 `<R>/cleanread/source.db`，供 cleanread/cleanscan 读码。
- 大型库快速刷新：`index_build.py --incremental`（git 驱动，只更新改动文件）+ `enrich_treesitter.py --files a,b`；跨文件边一致仍需周期性全量。

## 安装（@ agent 即可，无需另装 CLI app）

把本仓库的 `hooks/`、`skills/`、`agents/`、`workflows/`、`settings.json`、`CLAUDE.md` 放进 `~/.claude/`（或项目 `.claude/`）；
按机器改 `settings.json` 里 hooks 的绝对路径；`tools/` 随仓库走。需 `uv` 与 `git`。
侦察先行的子 agent 编排见 `CLAUDE.md` 的 Agent Orchestration 段：只读侦察子 agent `agents/cleantools-scout.md`，可复用模板 `workflows/scout-first-read.js`。
