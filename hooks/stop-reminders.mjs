// audience: internal
// # stop-reminders
// 用户级 Stop hook:每轮结束时显示一行收尾提醒(更新 manyread 索引、文风审计)。
// 输出一行 JSON,systemMessage 显示给用户;本脚本不读 stdin。
console.log(
  JSON.stringify({
    systemMessage: "收尾提醒:这轮改了代码就更新 manyread 索引(/mr-index);写了文档或大改注释就拉一次文风审计。",
  }),
);
