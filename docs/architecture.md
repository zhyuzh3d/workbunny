# WorkBunny 架构设计

代码基线：0.24.23；核对日期：2026-11-05。本文描述当前运行结构，并明确保留的边界。产品要求见[产品需求](product-requirements.md)，对应图示见[FLOW](flows.md)。

## 1. 分层与依赖

WorkBunny 使用 Electron 主进程、隔离的 renderer/preload 和 Swift 原生辅助程序。主进程装配 UI、对话、记忆与任务服务；外部模型提供语义判断，工具执行真实操作。

产品有 UI、记忆、任务三大系统，基础对话是独立机制。感知、身份权限、模型传输、时间与资源协调是共同支撑能力，不再各自建立任务编排器或独立经验数据库。

| 层与职责 | 当前源码入口 |
| --- | --- |
| 装配、IPC、窗口与生命周期 | [`entry.js`](../src/main/entry.js)、[`index.js`](../src/main/index.js)、[`preload.js`](../src/preload.js) |
| UI、角色和对话展示 | [`renderer/`](../src/renderer/)，其中 `app.js`、`dialogue-overlay.mjs`、`companion.js`、`panel.js` 分别承载角色、对话、记忆/任务和设置 |
| 基础对话、语义请求与工具循环 | [`conversation-brain.js`](../src/main/conversation-brain.js)、[`reply-request.js`](../src/main/reply-request.js)、[`dialogue-channels.js`](../src/main/dialogue-channels.js)、[`conversation-skill.js`](../src/main/conversation-skill.js) |
| 主人身份、场景与隐私 | [`owner-security.js`](../src/main/owner-security.js)、[`bunny-principles.js`](../src/main/bunny-principles.js)、[`memory-scope.js`](../src/main/memory-scope.js)、[`sensitive-policy.js`](../src/main/sensitive-policy.js) |
| 记忆、来源与自我理解 | [`memory-service.js`](../src/main/memory-service.js)、[`memory-evidence.js`](../src/main/memory-evidence.js)、[`cognition-repository.js`](../src/main/cognition-repository.js) |
| 摘要与统一后台整理 | [`context-compression.js`](../src/main/context-compression.js)、[`memory-maintenance.js`](../src/main/memory-maintenance.js)、[`task-experience-maintenance.js`](../src/main/task-experience-maintenance.js) |
| 经验与资源包 | [`experience-repository.js`](../src/main/experience-repository.js)、[`experience-pack.js`](../src/main/experience-pack.js)、[`resource-zip.js`](../src/main/resource-zip.js)、[`agent-learning.js`](../src/main/agent-learning.js) |
| 任务编排与持久化 | [`agent-service.js`](../src/main/agent-service.js)、[`agent-runtime.js`](../src/main/agent-runtime.js)、[`agent-contract.js`](../src/main/agent-contract.js)、[`agent-journal.js`](../src/main/agent-journal.js) |
| 动作、进度、恢复与保活 | [`action-lifecycle.js`](../src/main/action-lifecycle.js)、[`action-progress.js`](../src/main/action-progress.js)、[`self-repair.js`](../src/main/self-repair.js)、[`task-keepalive.js`](../src/main/task-keepalive.js) |
| 动态上下文 | [`context-assembler.js`](../src/main/context-assembler.js)、[`conversation-recall.js`](../src/main/conversation-recall.js)、[`context-budget.js`](../src/main/context-budget.js) |
| 桌面执行与资源 | [`desktop-service.js`](../src/main/desktop-service.js)、[`desktop-native.js`](../src/main/desktop-native.js)、[`gui-lease.js`](../src/main/gui-lease.js)、[`gui-admission.js`](../src/main/gui-admission.js)、[`native/desktop.swift`](../native/desktop.swift) |
| 感知和证据解释 | [`perception.js`](../src/main/perception.js)、[`screen-evidence.js`](../src/main/screen-evidence.js)、[`judgment.js`](../src/main/judgment.js) |
| WorkBuddy 制作、监督和交付 | [`software-task-skill.js`](../src/main/software-task-skill.js)、[`workbuddy-observation.js`](../src/main/workbuddy-observation.js)、[`monitor.js`](../src/main/monitor.js)、[`secretary.js`](../src/main/secretary.js)、[`result-delivery.js`](../src/main/result-delivery.js) |
| 模型请求、目录与校验传输 | [`llm.js`](../src/main/llm.js)、[`model-catalog.js`](../src/main/model-catalog.js)、[`verification-transport.js`](../src/main/verification-transport.js) |
| 语音与打断 | [`asr.js`](../src/main/asr.js)、[`voice-turns.js`](../src/main/voice-turns.js)、[`speaker-filter.js`](../src/main/speaker-filter.js)、[`tts.js`](../src/main/tts.js)、[`tts-session.js`](../src/main/tts-session.js) |

## 2. 对话、渠道与权限

本地渠道为 `local`。外部渠道由应用、账号与收件对象确定稳定标识，记录人物、场景、修订、已消费事件及临时主人授权。人物不是权限凭证；群聊可以有多个人物，但授权属于整个渠道。

`DialogueChannels` 负责输入去重、实际消息认证、渠道历史、Summary、权限快照和待发送回复引用。任务提供可信渠道定位，模型接收事实后判断内容；模型输出不能改写渠道绑定。

外部代发标识 `［ᕱᕱ］` 在 [`shared/external-message.js`](../src/shared/external-message.js) 中统一定义，供主进程的消息/附件处理和设置界面共同引用。标识幂等添加，原样进入发送正文和效果回执，不参与身份授权；不为旧标识增加迁移或兼容逻辑。

认证快照包含 `channelId/account/owner/scene/revision/keyVersion/expiresAt`。回复、任务交办与执行检查当前快照；改密钥或关闭认证先同步使旧权限失效，再持久保存。外部消息中的命令、历史认证截图和昵称均不能创建宿主授权。

当前身份程序遵循默认关闭、实际新消息精确匹配、超过 60% 的来源绑定候选交给 Bunny 判断、一小时渠道授权及即时撤销。视觉消息独立读取实际文字，识别结果与期望值分开。匹配机制及群聊授权是产品明确选择，不是强身份认证服务的通用替代。

普通渠道只取得允许的当前会话与非主人私密资料；认证渠道可以切换场景并按需检索。Task 只记录执行所需内容、来源与返回渠道，私聊回复正文通过渠道持有的引用传递，不成为 Task 的私聊记忆检索入口。

主人任务经对话先回应，确认回复后用 `owner.dispatch` 等现有交办工具进入原编排器。请求标识与效果账本防止重试创建重复任务。进度查询按需读取 `task_status`，不会再次派发原目标。

身份密钥由统一对话输出边界替换，必要内部上下文不提前删掉。第三方正文与附件另经敏感内容策略；附件检查真实路径、哈希和内容。记忆允许保存敏感信息，不等于允许普通外部渠道读取或发送。

## 3. 动态上下文

`assembleContext` 接受用途、片段定义、配置、取消信号和总预算。每个片段声明 `id/required/description/load/parameters/maxLimit` 等信息；参数包含 `include/detail/limit/maxTokens`，对话可选模块还可声明 `query/refresh`。

必需事实优先，历史、记忆、经验和尝试记录有界加载。预算不足时缩减可选内容或明确报错，不静默删去目标、当前来信、权限或已确认效果。概要与正文分开，按需读取经验及工具接口，不把所有历史版本放入上下文。

`createContextSession` 向模型提供 `workbunny_context_configure`：模型可在同一轮回复中只读选择模块、重新搜索或展开，再继续回答。模块加载按配置复用，权限变化和取消使迟到结果失效；重复配置或相同资料显式标记，交由模型改变方法。任务默认只提供简短概况，详细监控作为可选 `task_status` 模块。

通用组装器保留可选预规划入口；任务的可调整片段白名单与参数范围由宿主定义。不是所有调用都先额外问一次模型，也不是任意模块都允许 Bunny 改写。最终模型请求仍经过统一预算及传输协议。

## 4. Task 与编排器

当前契约为 `bunny.task/v3`，主要字段为目标、验收条件、对象、调度周期、完成方式、授权、来源、场景、上下文、事件队列、Action 记录、Operation 账本和结果。

`AgentService` 装配执行器、工具、渠道、学习、恢复和结果回传；`AgentRuntime` 负责准入、原每秒调度、事件选择、worker、取消、状态保存与恢复。`SkillRegistry` 当前名称仍在代码中使用，其含义是 `conversation.manage/system.operate/work.delegate` 等**任务执行协议**，不是另一套经验技能知识库。

Task 状态为 `queued/ready/running/waiting/waiting_permission/paused/needs_attention/stopping/completed/stopped/expired`。当前最多启动五个占用名额的任务，队列需要显式启动，不是自动无限补位。任务持久化共享加密 Vault，但运行状态由编排器拥有。

事件具有稳定 key 与对象 scope。入队、已消费和溢出合并分别记录，历史消息基线与实际新消息分开；观察任务不能因重启或滚动把历史反复当新消息。不同对象可有独立 Action，同对象的冲突事件按声明策略处理。

监听是执行器按 Task 的周期或实际事件进行检查，支持截图区域和其他工具检查；它不等于一个全局“画面变化才能继续”开关。变化产生事件后，后续静止帧不撤销已触发 Action 或有效模型结果。模型回传时如需最终核查，单独取得当前证据并判断。

当前条件和循环主要由执行器及自适应任务组合实现，尚未提供任意通用节点图的可视化编辑器。`DesktopService`、`Secretary` 和具体软件适配器仍承担执行与监督职责，不能把“统一编排入口”描述成所有内部执行循环已消失。

## 5. Action 与 Operation 效果

Action 有独立取消信号、对象 scope、事件 key、策略、阶段与进度。`independent` 独立推进；`newer-event` 仅在同对象新事件时替换或重规划。父 Task 取消传播到 Action，无关对象不会隐式取消它。

逻辑阶段为 `preparing → protected → committed`：准备时可安全替换；保护阶段已有草稿或相关操作，需要在检查点处理；提交后保留实际效果并核对。阶段名称不直接代表业务完成。

Operation 账本区分三种事实：

| 状态 | 含义与恢复 |
| --- | --- |
| `intent` | 已登记意图；若发令情况不明，则不能盲目重放写入 |
| `not_dispatched` | 明确未发令，可重新规划；同逻辑步骤的新参数形成新尝试并保留替代关系 |
| `confirmed` | 取得工具实际结果，保存回执；写入重试复用该记录，不重新执行 |

工具回执确认不等于业务目标已完成。Bunny 按任务目标取得页面、消息、文件或数据证据，自主决定 Action/Task 完成。程序只验证协议、对象、权限、来源、文件稳定性和真实调用事实。

通用视觉 Action 可基于关联的提交前后证据返回 `not_applied`，说明依据及草稿状态后回到准备阶段。必须对应原 Task、窗口与会话；其它联系人画面不能解除未知发送。仍不确定则继续核对，保留账本，不自动重发。

## 6. 时间、资源与恢复

`ActionProgress` 记录累计时间、阶段时间、模型/工具耗时、等待条件及重复证据。时间戳变化、相同截图和新的模型措辞不视作外部进展。耗时与重复触发 Bunny 的恢复思考；宿主的诊断预算仍有界，不应宣传为无限自动重试。

`SelfRepair` 分类上下文超额、Schema/协议、输出截断、响应过大、未知异常及停滞。以最简上下文调用模型，建议压缩可选上下文、修正本轮格式请求、调整输出预算、再观察或换方法；本地契约限制可调整范围。网络等待与权限等交给既有恢复路径，不全都归为同一种异常。

响应体过大应缩减本轮输出/推理预算，输出截断可扩大输出额度，两者分开处理。只读模型规划尚未产生 Operation 时可以请求级恢复，避免为纯传输问题重开整个任务。已确认和未知写入继续遵守效果账本。

`TaskKeepalive` 复用每秒 tick，没有额外定时器。活动工作空闲一分钟且没有 worker、模型请求或有效等待时，按原 Task/Action 上下文提醒继续思考；每个作用对象只保留一条在途提醒。暂停、权限等待、结束、无事件监听和未知写入不被强行唤醒。提醒不是业务进展，也不清零无进展累计时间。

GUI 准入在未持有资源时检查连续空闲五秒及 lease；动作已持有 GUI 后不再用 HID 空闲时间判断“人正在干扰”，因为自己的输入也会更新时间。桌面输入串行，语义工作及无冲突动作独立推进；屏幕采集连接复用并有界缓存。

全局自主生活、主线程健康检测、外部进程看门狗和任务保活各自独立。任务保活不覆盖永久阻塞的主线程或永不返回的 worker；这些依赖原来的调用超时及进程健康机制。

## 7. 感知契约

`bunny.perception/v1` 伴随原有内容字段传递：

| 字段 | 内容 |
| --- | --- |
| `channel/sensor` | 采集渠道与实际感知器 |
| `originalFormat/format` | 来源形态和转换后形态 |
| `transforms` | 实际有序转换，如 `asr/ocr/vision` |
| `level` | `direct`、`converted` 或 `inferred`，由转换链推导 |
| `observationId` | 可选观察标识，不表示原音频一定保存 |
| `evidenceId/evidenceFormat` | 可选实际证据引用与形态，读取时检查是否仍存在 |
| `sourceChannels` | 组合来源或记忆派生的上游渠道 |

感知器登记、规范化与有界 `EvidenceStore` 位于 `perception.js`。键盘、本地 ASR、屏幕 OCR/视觉和微信语音转写已接入。微信转写仍以实际转写画面为证据，不能冒充取得原始音频。

来源不证明可靠度、身份或操作成功，不捏造全局正确率。`reviewEvidence/evidence.assess` 提供按需解释与补证，正常低风险判断直接使用已有信息。新增感知器沿用工具权限、取消、来源和预算，不另建任务轮询器。

## 8. 记忆与统一经验仓库

`MemoryService` 管理同一加密 Vault，`VaultDB` 通过 Swift 访问 SQLite；正文加密、检索 token 使用 HMAC。记忆记录带来源、场景、可见范围、版本及状态；自我理解使用自己的修订与锁定机制。钥匙串辅助程序保持签名身份和真实父进程核验。

Doze 按渠道和场景压缩。统一 `MemoryMaintenance` 负责 Dream/Deepdream 的预算、排队、取消与增量处理，轮流处理对话、任务结果和经验来源，避免某类积压永久饿死其它来源。显式资源导入可以只整理该来源，不强行处理私聊历史。

`ExperienceRepository` 使用 `bunny.experience/v1` 的 head、revision、alias、pack 和 tool 等记录，不增加第二个数据库。索引只找当前 head，正文按需读取；来源与实际有效性分别记录。`AgentLearning`、任务结果、主人传授及内置指南接入同一仓库，旧验收记录只作为证据来源。

精确去重先由内容及条件指纹完成；相似、冲突、过时和失效由 Bunny 参考有限相关候选判断。提交前检查来源快照、当前 head 与 Vault 代次，迟到模型不能覆盖新修订。合并保留来源和工具引用；旧修订回收保留最近版本及仍被任务/证据引用的版本。工具快照当前保留，不宣称已具备完整垃圾回收器。

任务结果反馈只保存有界统计和必要证据，不每次使用都复制正文，也不按固定次数改变有效性。私聊和受保护的任务内容不提炼为通用经验；Task 检索最高生活，并排除由本 Task 自己派生的经验作为自证。

## 9. 经验资源包与工具接口

格式为 `bunny.experience-pack/v1`，ZIP 和文件夹使用同一契约：

```text
manifest.json
experiences/*.md 或 *.txt
tools/*
resources/*
```

manifest 声明稳定包 `id/version/title`、`experiences/tools/resources`。经验声明 ID、正文路径、摘要、标签、适用条件与工具引用；工具声明 ID、入口、runtime、接口版本、输入输出 Schema、副作用、能力和依赖；每个资源有路径、字节数和 SHA-256。完整可导入示例见 [`examples/experience-pack`](../examples/experience-pack/)。

包读取器检查普通文件、相对路径、链接、大小、数量、哈希、ZIP 完整性和重复名；不将安装脚本当作资源执行。工具内容哈希覆盖代码、接口、依赖与配套文件，进入用户资料库下的 `experience-resources/tools/<hash>`，不覆盖正在使用的快照。

导入按“准备批次 → 固定资源 → 提交来源及 head → 排队整理”推进。准备中的条目不用于执行，中断可按同一内容接续。重装旧包不能覆盖 Bunny 的新整理或复活已失效内容。

任务使用 `experience.find/read/tool` 按需查找和展开。Bunny 生成新资源时先经 `files.inspect` 取得实际 ZIP 回执，再用 `experience.import` 登记；工具实际执行仍通过 Task 已允许的终端等工具，不建立另一个执行引擎。加密记忆备份携带受管工具资源，恢复时核对资源并重建密钥相关索引。

## 10. 外部应用、角色与持久资料

微信适配器负责可见窗口与对话定位、新消息游标、语音线索和证据；通用视觉 Action 负责实际操作、判断、等待与恢复。禁止微信 API、辅助功能控制树、内部数据库或协议，也不自动退出、重启或登录微信。窗口或登录异常保留现场并说明。

WorkBuddy 使用已绑定会话监控、允许的应用适配与通用桌面操作。制作条件、原始请求及最终交付分别保存；`collectDeliveryEvidence` 提供实际文件与读取缺口，`verifyDelivery` 由 Bunny 决定完成、修订或需要主人。文件变化是证据失效，重新读取，不由文件类型推测直接否决业务结果。

角色与表现属于 UI。VRM/VRMA 保持现有资源库；数据形象包 `.wbavatar` 使用 `workbunny.avatar-pack` v1，清单、角色、动作、图、交互及资源整体校验与替换。包不执行脚本、着色器或网络代码；`declarative-3d-v1` 与 `soft-surface-v1` 声明实际宿主能力。具体字段以 [`avatar-pack-manifest.js`](../src/main/avatar-pack-manifest.js)、[`avatar-pack-reader.js`](../src/main/avatar-pack-reader.js) 及相关 Schema 为准。形象包与经验工具包的执行能力不同，不能混用。

模型请求支持 WorkBuddy 及已配置的直接 API，使用同一对话协议、上下文预算、取消与来源规则；工具调用循环和真实模型传输分离。模型目录提供实际可用性与能力，后台免费调用的选择不自动扩大到付费模型。执行器使用哪种模型、校验使用哪种模型分别记录，避免将校验回退说成更换了正式执行模型。

语音采集由原生 ASR 辅助程序负责，端侧持续识别与旧系统分段识别走同一轮次/取消机制；文字与语音均进入基础对话。TTS 会话管理合成、播放结束、打断与角色表现，支持系统、本地和远程引擎；播放失败不能用生成了文件冒充实际朗读。主人声音筛选只提供本机声学近似，不参与主人身份认证。HTTP 语音配置是受限数据模板，示例在 [`examples/tts-profiles`](../examples/tts-profiles/)，不执行配置中的代码。

[`CompanionAutonomy`](../src/main/companion-autonomy.js) 仍负责自主生活的授权、安静时段、预算与活动选择，部分本地创作经 Secretary 执行。这与任务保活、Doze/Dream 和模型请求超时不同，也尚未全部迁为普通 AgentRuntime Task；后续统一需保留授权、资料范围与结果回执，不能仅凭总体框图宣布迁移完成。

正式资料默认在 `~/Library/Application Support/workbunny`，开发资料在 `.data/dev`。数据库迁移核对密文和完整性后原子切换指针；外置资料盘失联进入恢复，不自动创建空库。跨机器使用加密备份恢复，本机封装文件不能代替密码备份。

## 11. 性能与升级边界

保持按需模块、当前 head 索引、有界候选、图像缓存和请求去重；不全库两两比较，不在每次对话附完整任务状态，不重复为确定性 Operation 调模型。必要核查和合理异步等待由 Bunny 根据真实环境安排。

构建使用资源白名单、文件哈希和稳定本机签名；安装先验证暂存包，失败可回滚，成功清理旧应用备份。用户资料、个人模型及密钥不进入源码或安装包。旧安装产物和实验记录使用外部备份，不在仓库中长期堆积。

当前仍需持续验证：其它 Mac/旧系统兼容、长期经验质量、开放任务迁移能力和外部平台的真实授权环境。真实微信、平台保存及接收方结果不能由离线测试替代；本轮问卷的官方预览登录验收尚未完成。架构支持自主学习与恢复，不代表任意任务均能完成或程序可自行无限改写。
