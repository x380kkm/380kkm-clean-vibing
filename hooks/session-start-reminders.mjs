// audience: internal
// # session-start-reminders
// 用户级 SessionStart hook：向模型注入三条开工提醒（`cleanread`、注释写法、平直语言）。
// 输出一行 JSON，`additionalContext` 字段写入模型上下文；本脚本不读 stdin。
const context = [
  "会话开工提醒（用户级 SessionStart hook）：",
  "1. 读代码优先走 cleanread 索引：正式索引在每个任务完成后由主 agent 跑一次正式重建（index_build 加 enrich）刷新；回合内的一致性审计用临时解析、不依赖正式索引。不要直接用 ls、grep 扫仓库。",
  "2. 注释遵守用户级 CLAUDE.md 的写法：标识符英文、注释中文；每个源文件首行是 audience 头块、第二行是 H1 模块名；每个代码单元上方加 //// 标记；注释用现在时写代码做什么，不写意图与计划。",
  "3. 全部输出内容（对话、注释、文档、提交文案）用平直语言：完整句子，不生造代号缩写与比喻词，不用电报体与箭头链等文字压缩格式，新术语首次出现给出解释并受到审计。",
].join("\n");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
