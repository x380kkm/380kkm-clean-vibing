// audience: internal
// # stop-reminders
// 用户级 Stop hook：每轮结束时输出一行提醒，告知任务完成后重建 `cleanread` 索引和运行文风审计。
// 输出一行 JSON，`systemMessage` 字段显示给用户；本脚本不读 `stdin`。
// 重建策略：任务进行中的审计使用临时解析（`cleanaudit` 不修改正式索引）；一个任务完成后，主 agent 自己跑一次
// 正式重建（`index_build` 加 `enrich`）刷新正式索引，供后续 `cleanread` 与 `cleanscan` 读码用。
console.log(
  JSON.stringify({
    systemMessage: "收尾提醒：一个任务完成后跑一次正式 cleanread 重建（index_build 加 enrich）刷新正式索引；写了文档或大改注释就拉一次文风审计。",
  }),
);
