# clean-vibing

非稳定实测：非逆向查找依赖的任务，在不受到别名、歧义、少于两个字符的变量名称的干扰下，初次获取相同信息节约30～55%token。
仅在首次寻找特定的逆向依赖这一任务中禁用read和grep的子agent过量消费token。


个人 Claude Code 配置：写作规范、每轮结束后的审计 hook、读码工具 cleanread、cleanscan、cleanaudit，以及侦察先行的子 agent 编排（`agents/` 与 `workflows/`）。不是插件，放进 `~/.claude/`（或项目 `.claude/`）即用。

迁移到本机只改一处：把 `settings.json` 里各 hook 的绝对路径换成本机路径。

运行前提：`uv`、`git`、Node.js。命令清单见 `skills/clean-tools/SKILL.md`。

灵感与初版来源 https://github.com/IOchair/SQL-ManyThing

初版：https://github.com/x380kkm/manyread-cc