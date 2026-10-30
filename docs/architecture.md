# 0.14.0 架构与开发入口

本文描述当前已实现的结构。旧开发计划、一次性实验与本机验收过程不作为运行依赖。

## 运行链路

`src/main/entry.js` 区分普通启动与独立钥匙辅助进程；`src/main/index.js` 组装窗口、连接、语音、记忆与任务调度。`src/preload.js` 暴露受限 IPC，`src/renderer/index.html`、`panel.html`、`companion.html` 分别承载角色、设置和伙伴空间。主进程校验调用窗口、当前授权及数据状态。

`workbuddy-connection.js` 发现登录状态并建立模型目录，`workbuddy.js` 是唯一文本模型通道。连接或账号变化会使旧请求、缓存和任务监督失效。`reply-request.js`、`reply-format.js` 与 `dialogue-cognition.js` 约束“评估 → 回复 → 预测”，完整校验后才发布可见正文；`conversation-recall.js` 和 `conversation-search.js` 提供受限记忆回查与联网来源。

## 记忆与成长

`memory-service.js` 管理加密写入和读取，`vault-db.js` 通过独立 Swift `native/vault.swift` 访问 SQLite。正文使用本机钥匙加密，搜索词以 HMAC 索引。`keychain-key-provider.js`、独立签名钥匙程序及 `vault-key-broker.js` 负责首次创建、读取与旧钥匙迁移；系统授权在辅助进程中等待。

`message-identity.js`、`message-blocks.js`、`recent-rounds.js` 与 `context-budget.js` 管理身份、连续原文块和完整请求预算。`memory-evidence.js`、`memory-references.js` 和知识记录模块维护来源、作用域、修订与删除链。`memory-maintenance.js` 统一调度 Doze、Dream 和 Deepdream。

`cognition-repository.js` 保存唯一自我理解、条目/整体锁和修订来源；`user-facts.js`、`companion-growth.js`、`companion-affect.js` 与 `companion-autonomy.js` 处理有条件的用户理解、兴趣目标、情绪和受授权的主动行为。抽象角色理解共享，原始私聊资料保留场景边界。

`data-location.js` 执行暂停、checkpoint、关闭、复制校验、原子位置切换和中断恢复。不能通过创建空库来掩盖原磁盘不可用。

## 语音与角色

`asr.js` 驱动 `native/asr.swift` 或 `native/asr-legacy.swift`，持续识别与按次识别共享前台调度。`tts.js` 路由系统朗读、Qwen、CHP 与通用 HTTP；`tts-http-profile.js` 限定配置能力，`tts-session.js` 与播放标识管理取消和结束确认。Qwen 使用固定版本 speech.cpp，源码由 `tools/build-tts-runtime.sh` 拉取并构建，不保留旧 llama.cpp worker。

`speaker-features.swift` 用本地 MFCC、音高与人声活动构造轻量描述，`speaker-filter.js` 管理多段模板、设备变化和近似筛选；模板仅存在加密 Vault，不保存或上传录音。声学筛选通过后才进入原有语义回复/跳过判断，复用前台模型请求。`memory-service.markInterrupted` 标记被用户打断的回复，其预测不再用于下一轮评估。

`embodiment.js` 以渲染层实际播放回执记录最近五次动作；`motion-library.js` 是分类、语义、启用、权重和个人导入的唯一目录。共享 `motion-core.js` 负责主进程与渲染层的同一加权算法。对话复用已有动作/情绪标签，明确指定动作不会被另一个动作冒充。`window-geometry.js` 保存逻辑画布和物理窗口的偏移，支持顶部越过菜单栏的拖拽效果。

`avatars.js` 合并四个发行角色与用户显式导入的个人库。`asset-library.js` 校验并原子保存个人 VRM。公开模型和动作只来自 `resources-manifest.json`，不会扫描项目旁边的私人素材目录。Three.js 附加模块只保留运行所用的 GLTFLoader 及其 BufferGeometryUtils 依赖；编辑用插件不进入发行源码树。

## 任务与桌面

`desktop-service.js`、`desktop-native.js`、`secretary.js`、`monitor.js` 与任务/关注日志管理交办、执行、检查和恢复。`task-supervision.js` 在本地追踪等待用户、连续错误、停滞和预计耗时，使用去重/过期/冷却队列，空闲时才用本地文字提醒。全局通知接口不稳定，当前没有跨应用通知监听或后台通知判断模型请求。

共享 GUI 操作锁、显式发送意图和不重复提交规则用于约束可见界面操作。协议见 [桌面原生桥](desktop-native.md)、[微信交办与关注](wechat-delegation-and-watches.md) 和 [对话协议](dialogue-protocol-and-presentation.md)。

## 开发边界

- `npm ci` 恢复固定依赖；`bin/`、`dist/` 和开发资料按需生成，不是源码输入。
- 构建与源码快照脚本保留在 `tools/`；测试和夹具统一在 `test/`。测试详情见 [测试入口](../test/README.md)。
- `tools/copy-release-resources.js` 校验资源哈希并形成运行资源清单，`tools/source-release.js` 从已构建应用与明确目录生成干净源码快照。
- 安装脚本用于普通更新，会保护个人资源；需要测试首次安装时，使用独立空用户目录，不能直接清空正式资料。
- 私人模型、创作实验、参考音频、历史报告与旧构建产物不放进 Git 项目；源码包不收集项目同层级目录。

兼容性和已知验收范围见 [安装与兼容](workbunny-macOS安装与兼容.md)。本次目录整理不修改 v0.13.0 标签或已公开的 Release 附件。
