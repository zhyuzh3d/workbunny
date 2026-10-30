# 对话协议与呈现边界

适用于 0.13.0 的 WorkBuddy 对话通道。核心实现为 `src/main/reply-format.js`、`reply-request.js` 和 `dialogue-cognition.js`。

- 外层协议为 dialogue-v2，顺序必须是 review → reply → prediction。单轮先评估上一轮预测，再回复，再形成新预测；隐藏评估和预测不进入普通全文索引、气泡或朗读。
- 内层只接受 chat、action、skip。完整输出通过类型、字段、重复键、尾随内容、正文和预算校验后才发布。传输层返回可解析 JSON 不代表通过产品协议。
- 历史 assistant 消息在请求时统一包装为 chat 正文示例，不改写真实聊天记录，不把隐藏认知或工具结果伪装成人物发言。
- chat 只呈现自然语言正文；action 进入任务调度器，由调度器报告自然状态；skip 不生成可见回复或语音。气泡与 TTS 入队处再次检查正文边界。
- 正常数字表达可以是有效聊天，不使用数字或特定模型名黑名单。代码、工具 XML、程序 JSON 和角色分隔符不能作为普通对话朗读。
- 只允许在同一模型、同一上下文和同一总时限内进行一次协议修复。非法或截断输出不保存为正常助手回答；取消和传输错误不触发纯文本旁路。
- 连接测试使用正式提示及相同校验器；返回 HTTP 200 或任意字符串不能作为对话功能通过的依据。
- 语音打断、取消、内部通知和不确定播放使旧预测失去配对资格。共享请求预算同时计算系统提示、历史、检索、工具和输出空间。

回归入口包括 `test/test-reply-format.js`、`test/test-reply-request.js`、`test/test-cognitive-loop.js`、`test/test-dialogue-foreground.js` 和 `test/test-bubble-ui.cjs`。真实模型语义质量另由显式 live 验收评估，不与离线协议测试混同。
