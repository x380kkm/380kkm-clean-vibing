// audience: internal
// # session-start-reminders
// 用户级 SessionStart hook：向模型注入四条开工提醒（`cleanread` 有界检索、注释写法、平直语言、侦察先行的子 agent 编排）。
// 输出一行 JSON，`additionalContext` 字段写入模型上下文；本脚本不读 stdin。
const context = [
  "会话开工提醒（用户级 SessionStart hook）：",
  "1. 读代码优先走 cleanread 索引：动手做事前先跑增量更新（index_build --incremental 加 enrich_treesitter --files）刷新正式索引，任务完成后再跑一次全量重建（index_build 加 enrich_treesitter）；回合内的一致性审计用临时解析、不依赖正式索引。检索时先用 cleanscan 定位到 path:line，再用 cleanread 按字节跨度有界提取对应片段，不要 Read 整个文件，也不要用 ls、grep 扫仓库。",
  "2. 注释遵守用户级 CLAUDE.md 的写法：标识符英文、注释中文；每个源文件首行是 audience 头块、第二行是 H1 模块名；每个代码单元上方加 //// 标记；注释用现在时写代码做什么，不写意图与计划。",
  "3. 全部输出内容（对话、注释、文档、提交文案）用平直语言：完整句子，不生造代号缩写与比喻词，不用电报体与箭头链等文字压缩格式，新术语首次出现给出解释并受到审计。",
  "4. 把任务分派给多个子 agent 前，先派一个只读 cleanread 与 cleanscan 的预采集子 agent（cleantools-scout），让它产出带 path:line 锚点的清单；后续子 agent 拿着锚点按字节跨度有界提取，每个子 agent 的提示都带上这条有界检索纪律。需要写文件、跑命令或读取未索引内容的子任务，才用带全套工具的正常子 agent。",
].join("\n");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
