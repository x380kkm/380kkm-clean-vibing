# clean-vibing

非稳定实测：非逆向查找依赖的任务，在不受到别名、歧义、少于两个字符的变量名称的干扰下，初次获取相同信息节约30～55%token。
仅在首次寻找特定的逆向依赖这一任务中禁用read和grep的子agent过量消费token。


个人 Codex 配置: 写作规范, 每轮结束后的审计 hook, 读码工具 cleanread, cleanscan, cleanaudit, 以及侦察先行的子 agent 编排 (`AGENTS.md`, `agents/` 与 `hooks.json`). 不是插件, 将 `AGENTS.md`, `hooks.json`, `agents/`, `hooks/`, `skills/` 与 `tools/` 放进 `~/.codex/` (或项目 `.codex/`) 即可使用.

迁移到本机时保留现有 `~/.codex/config.toml`, 仅合并本仓库 `config.toml` 的 `[agents]` 配置; 再把 `hooks.json` 内各 hook 的绝对路径换成本机路径.

运行前提：`uv`、`git`、Node.js。命令清单见 `skills/clean-tools/SKILL.md`。

灵感与初版来源 https://github.com/IOchair/SQL-ManyThing

初版：https://github.com/x380kkm/manyread-cc
