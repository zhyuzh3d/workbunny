# WorkBunny 架构与执行 FLOW

流程记录当前源码的逻辑责任与主要路径，更新日期为 2026-11-12。数据字段和实现边界见[架构设计](architecture.md)。

## 1. 系统总览

```mermaid
flowchart TB
    Owner["主人 / 外部对话方"] --> UI["UI 系统：角色、文字、语音、面板"]
    UI --> Chat["基础对话：渠道、人物、场景与回复"]
    Chat --> Context["上下文组装器：按用途和预算选择模块"]
    Context <--> Memory["记忆系统：自我理解、历史、事实、经验"]
    Memory --> Tools["受管工具资源与不可变快照"]
    Chat -->|"已授权目标；先回应"| Task["任务系统：AgentService / AgentRuntime"]
    Task --> Context
    Task --> Action["Action：语义调度与程序组合"]
    Action --> Operation["Operation：真实工具 / 视觉键鼠 / 文件 / 接口"]
    Operation --> Perception["感知与实际回执：来源、转换、证据"]
    Perception --> Action
    Action -->|"自主核查与结果"| Task
    Task -->|"原渠道回传"| Chat
    Task -->|"实际结果和反馈"| Memory
    Memory --> Maintenance["统一 Doze / Dream / Deepdream"]
    Maintenance --> Memory
    Security["共同保障：权限、隐私、取消、时间、资源、效果账本"] -.-> Chat
    Security -.-> Task
    Security -.-> Operation
```

## 2. 对话、按需上下文与主人交办

```mermaid
sequenceDiagram
    actor Person as 当前渠道人物
    participant Channel as 渠道与权限
    participant Chat as 基础对话
    participant Assembler as 上下文组装器
    participant Model as Bunny LLM
    participant Runtime as 统一任务运行时
    Person->>Channel: 实际新消息与来源
    Channel->>Channel: 去重、认证、原子保存权限和事件回执
    Channel->>Chat: 绑定渠道、人物、场景与授权
    Chat->>Assembler: 必要规则、当前消息、摘要和极简任务概况
    Assembler-->>Model: 本轮上下文与可选模块目录
    loop 仅在缺少资料时
        Model->>Assembler: configure：选择模块、查询、条数和详情
        Assembler->>Assembler: 校验权限与预算，加载或复用资料
        Assembler-->>Model: 新上下文及是否有新信息
    end
    Model-->>Chat: 回复；或主人交办意图
    Chat->>Channel: 输出密钥替换，按当前快照发送
    alt 已确认主人交办，且回应已发送
        Chat->>Runtime: 同一授权、原始请求、来源和返回渠道
        Runtime-->>Chat: Task ID 与监控状态
    else 普通交流或进度查询
        Chat-->>Person: 根据已读取事实回复，不重复创建任务
    end
    Runtime-->>Chat: 真实结果或需要主人参与的缺口
    Chat-->>Person: 回传进展或成果
```

## 3. 外部主人认证与撤权

```mermaid
flowchart TD
    Input["当前渠道的实际新来信"] --> Local{"本地渠道？"}
    Local -->|"是"| Owner["主人权限，按当前场景读取"]
    Local -->|"否"| Enabled{"本地设置已开启且配置密钥？"}
    Enabled -->|"否"| Ordinary["普通渠道；最高生活，不产生新任务授权"]
    Enabled -->|"是"| Source["核实实际输入来源；视觉内容独立读取"]
    Source --> Exact{"完全匹配？"}
    Exact -->|"是"| Grant["持久化当前渠道权限及回执，随后公布一小时授权"]
    Exact -->|"否"| Similar{"来源绑定候选超过60%？"}
    Similar -->|"否"| Ordinary
    Similar -->|"是"| Judge["Bunny 综合实际来信和感知偏差判断"]
    Judge --> Approved{"认可身份？"}
    Approved -->|"是"| Grant
    Approved -->|"否"| Ordinary
    Grant --> Snapshot["后续对话与交办明确携带权限快照"]
    Snapshot --> Owner
    Revoke["到期 / 关闭开关 / 修改密钥"] --> Invalidate["撤销外部授权，使旧快照与迟到回复失效"]
    Invalidate --> Ordinary
```

授权属于渠道，包括群聊；不是依据每个发言人的昵称授权。只有本地设置能修改开关。身份密钥在输出边界被替换；感知识别与上下文中可保留必要信息。

## 4. Task 生命周期

```mermaid
stateDiagram-v2
    [*] --> ready: 已确认主人目标与来源
    ready --> queued: 当前启动名额已满
    queued --> ready: 主人显式启动且可准入
    ready --> running: 调度执行
    running --> waiting: 等待条件或下次检查
    waiting --> running: 事件、到时或有效唤醒
    running --> waiting_permission: 缺少实际权限
    waiting_permission --> ready: 权限已满足并继续
    running --> needs_attention: Bunny 判断需要帮助或效果待核对
    needs_attention --> ready: 已补充条件并核实可继续
    running --> paused: 主人暂停
    waiting --> paused: 主人暂停
    paused --> ready: 主人继续，保留原任务
    running --> completed: Bunny 确认目标完成
    waiting --> expired: Task 到期
    ready --> stopped: 主人停止，立即封住调度与回调
    running --> stopped: 主人停止或取消，立即释放名额
    waiting --> stopped: 主人停止或取消
    paused --> stopped: 主人停止
    needs_attention --> stopped: 主人停止，禁止自动恢复
    completed --> [*]
    stopped --> [*]: 清理只一轮，失败不重试
    expired --> [*]
```

原文收到 → 内部待理解记录 → 语义判断 → 聊天/澄清或真实业务采用。接收阶段只确认收到，业务采用之后才按真实状态回执；话题切换不自动控制旧任务。

首次交办、主人续办、自动修订 → 整理后的目标、必要背景、约束和验收 → 共用正文封装 → WorkBuddy。主人原文与原始历史只留私有来源记录，不附正文或敏感任务附件。未知草稿恢复沿用原先保存的精确正文，不因策略升级改写或重发。

这是主要迁移示意；实际迁移还校验来源、代次、权限、未知写入和恢复资格。状态切换不撤销已发生的外部效果。

```mermaid
flowchart LR
    Stop[主人停止] --> Local[立即 stopped
取消子动作、替换执行快照、释放名额]
    Local --> Cleanup[按任务资源句柄清理
外部停止中，最多30秒]
    Local --> New[可开始独立新任务]
    Cleanup --> Verified[逐项实际确认停止]
    Cleanup --> Partial[超时、失败或共享保留
写逐项日志并提示]
    Verified --> Remain[本地仍为 stopped]
    Partial --> Remain
    Partial --> Record[保留原日志与资源身份
失败、超时、重启都不重试]
    Remain --> Hide[终态 X 或清空列表：保存隐藏标记]
    Hide --> Undo[恢复列表：仍保持结束，不执行或补发]
```


## 5. 监听、异步 Action 与连续 Operation

```mermaid
flowchart TD
    Tick["原任务调度 tick / 到期检查"] --> Observe["检查已配置的屏幕、文件、接口或数据"]
    Observe --> Event{"有新的目标事件？"}
    Event -->|"否"| Next["安排下次检查；不撤销已触发动作"]
    Next --> Tick
    Event -->|"是"| Queue["稳定事件 key 入队，保留来源和对象 scope"]
    Queue --> Conflict{"同对象有未完成动作？"}
    Conflict -->|"否"| Start["启动独立 Action"]
    Conflict -->|"是"| Policy["按声明策略合并、排队或替换；已提交效果先核对"]
    Policy --> Start
    Start --> Plan["Bunny 依据目标、经验、当前证据与耗时规划"]
    Plan --> Knowledge["按当前目标、软件和失败上下文检索适用经验"]
    Knowledge --> Mode["每次 Operation 自主选获准模式；其它方法不适用才视觉"]
    Mode --> Permit["核对本次目标、模式、授权、取消与未知效果屏障"]
    Permit --> Group["执行可连贯的一组 Operation"]
    Group --> Decide["Bunny 自主选择何时观察、等待或核查"]
    Decide --> Result{"目标结果有充分证据？"}
    Result -->|"完成"| Done["确认 Action；一次性任务完成，监听任务继续"]
    Result -->|"仍在合理处理"| Wait["明确等待条件和下一检查时机"]
    Wait --> Decide
    Result -->|"偏差或信息不足"| Recover["补关键证据、重新定位或换方法"]
    Recover --> Plan
    Stop["父 Task 暂停、停止或取消"] -.-> Start
    Static["后续静止帧 / 无关对象的新事件"] -.-> Next
```

监听和动作是并行职责。LLM 调度的有效性由当前任务、取消与对象规则判断，不能因为后一轮画面无变化就丢弃结果。Operation 不强制逐次核查。服务、终端/代码、结构化界面与纯视觉键鼠是独立通道，同一 Task/Action 可跨软件组合；经验不增加权限，未知副作用先只读核对。微信的直接 Operation 仅授权视觉键鼠，不将该限制程序继承到独立受托应用内部。

纯视觉链：普通显示像素 → 截图与 VLM 确认身份/区域/焦点/监测区 → 有界帧与局部像素时效 → displayInput 全局键鼠 → 按需要观察与结果核验。没有窗口列表、PID、应用接口或 AX 回落。视觉小区域变化由通用 sample/commit 稳定性机制处理，未知目标或焦点停止；暂停/取消立即使迟到派发失效，已发生输入仍如实保留回执。

每次异步返回 → 核对发起时的视觉会话 → 仅当前会话可写入锚点/帧/采样或派发。重置后的旧成功与旧失败均不能修改新会话；派发后失效只标记实际回执，不重复操作。微信观察缓存失效时分离旧识别请求，新结果不再等待或继承旧缓存。

语音定稿 → 以识别器和音频段核对来源 → 不同段保留相同短句，同段重复不产生新音频覆盖 → 新鲜静音及真实收尾 → 同一语义调度与提交门。识别器停止/换代同时退休当前候选和仍保留的前句待提交输入。

### BOPER 键鼠执行目标流程

以下流程已接入 0.26.43 并在当前 Apple Silicon Mac 重装；安装者本机管理员授权、VirtualHID、MCP 控制及合成接收窗口全链路已验收。其他 macOS、自动物理接管和指定联系人微信任务仍待实测。详细边界及进度见 [BOPER 开发计划](boper-development-plan.md)。

```mermaid
flowchart TD
    Intent["原 Task / Action：授权、GuiLease、目标证据和控制状态"] --> Service["单一 BoperService：会话、后端状态与能力要求"]
    Pixels["纯视觉目标仅来自 CGDisplayStream 像素"] -.-> Service
    Service --> Gate{"所需后端与能力就绪？"}
    Gate -->|"否"| Blocked["停发并说明；故障不自动降级"]
    Gate -->|"是"| Engine["独立普通权限输入进程；控制响应与输入执行隔离"]
    Engine --> Text{"多字符文字？"}
    Text -->|"是"| Clip["写入本次授权正文；核对 changeCount"]
    Clip --> Chord["BOPER 编排 Cmd+V 键序列"]
    Text -->|"否"| State["统一键鼠状态机和有限报告窗口"]
    Chord --> State
    State --> Backend{"当前会话固定后端"}
    Backend -->|"CGEvent，仅获准范围"| CG["BOPER CGEvent 输出"]
    Backend -->|"VirtualHID"| Helper["认证 HID helper；本地有序提交与复位"]
    Install["安装者本机管理员授权；固定 root LaunchDaemon"] -.-> Helper
    Control["宿主薄原生控制绑定；安装核验与 XPC 委托"] -.-> Helper
    Service -.-> Control
    Helper --> Driver["Karabiner daemon → BOPER 自身虚拟设备"]
    Clip -.-> Receipt["原 Operation 账本：剪贴板改变、输入提交、部分或未知"]
    CG --> Receipt
    Helper --> Receipt
    Receipt --> Judge["Bunny 按场景观察、核验和继续"]
    Stop["主人停止、撤权、锁屏或会话失效"] --> Cancel["撤销 inputSession；拒绝旧报告并按序释放自身键鼠"]
    Cancel --> Engine
    Cancel --> Helper
    Watchdog["宿主断线或续期超时"] --> Cancel
```

沿用现有任务调度与 GuiLease，不另建业务队列；清理失败有界退出占用，但 BOPER 保持故障，禁止新的输入。截图与软件检查不进入输入进程，长轨迹不阻塞控制和语音。

设置 → 键鼠：启用组件 → 完成本机管理员安装及官方驱动批准 → 返回重新检测 → 单独允许屏幕识别 → 生活场景可选验证输入。页面按真实状态给出下一步，操作即时生效；查看其他设置页不触发屏幕权限查询。

粘贴动作只由 BOPER 键盘快捷键产生，VirtualHID 模式使用虚拟键盘；系统剪贴板写入是前置数据准备。只有明确无法粘贴或确认未插入才选逐键策略，部分插入或结果不明先核对，不再粘贴或整段重打。默认不读取、备份或自动恢复旧剪贴板。

原按 PID 的后台 CGEvent 输入不能直接换成全局 HID；VirtualHID 提前返回不支持，由宿主取得新的前台授权和焦点，或选择其他已获准通道。它不在后台悄悄换回 CGEvent。

停止和报告提交在最后出口复核会话，复位按序处理；已进入系统的事件不保证可撤回。重连只恢复接纳资格，不重放旧输入。输入能力不扩大联系人、正文或渠道授权。

桌面桥退出/断管/异步写入失败 → 封住原桥接纳 → 按原 owner/scope 停止 BOPER 并有界等待 → 保留实际派发或未知回执 → 完成清理后才允许新桥。旧续租失败仅能处理自己的活动会话，不能误停后来的输入。

## 6. 写入账本与不确定效果

```mermaid
flowchart TD
    Call["已授权的工具调用"] --> Prior{"同逻辑步骤已有确认写入？"}
    Prior -->|"是"| Reuse["复用原回执，不重发"]
    Prior -->|"否"| Unknown{"有未知写入意图？"}
    Unknown -->|"是"| Evidence["Bunny 收集原对象的实际效果证据"]
    Unknown -->|"否"| Intent["持久登记 intent"]
    Intent --> Dispatch["核对当前权限、对象和取消状态后发令"]
    Dispatch --> Outcome{"实际调用结果"}
    Outcome -->|"明确未发令"| Safe["not_dispatched；允许新尝试并保留替代关系"]
    Safe --> Call
    Outcome -->|"取得真实回执"| Confirm["confirmed；保存结果供业务核查"]
    Outcome -->|"结果不明"| Evidence
    Evidence --> Review{"Bunny 对真实证据的判断"}
    Review -->|"已生效"| Confirm
    Review -->|"确切未生效"| Reconcile["记录关联、前后证据、依据与草稿状态"]
    Reconcile --> Prepare["同一 Action 重新准备，目标和权限不变"]
    Prepare --> Call
    Review -->|"仍未知"| Hold["保留待核查，不自动重放"]
    Confirm --> Business["Bunny 判断 Action / Task 是否真正完成"]
    Reuse --> Business
```

同一外部会话中的新一轮交办仍需要本轮消息回执。首次、主人续办与自动修订共用制作正文分工；已有会话绑定只用于定位，填写草稿或发出提交动作后先显示待核对，观察到本轮新消息才确认交办。未观察到时保留原草稿与记录，读取原会话补证，不复用旧回复或重复发送。

填稿前建立新轮次和消息基线 → 仅展示本轮输入/提交阶段 → 当前阻断绑定同一工作与轮次。前轮已确认的交办和成果独立保留，不能让新草稿直接变成已接收；旧失败不会覆盖更新的实际阻断，控制请求返回也不等于业务完成。成果网址先按原答复的 Markdown 边界整理；只有真实验收缺项才考虑必要修订。

当前补充确证未派发 → 绑定前轮正向回执与保留成果 → Bunny 在原验收中判断补充是否仍必要。原目标已满足且明确选择放弃 → 完整归档补充稿和拒绝证据 → 按前轮成果汇报；否则保留待核对，不派发本次验收生成的补充。unknown、已派发或新消息出现不进入此分支；同组证据不反复自动复核，暂停和停止优先。

旧成果状态不完整时：未派发证明 → 原 session/messageKey 的只读完成回执 → 克隆候选与 snapshot 同步事实 → 严格资格检查。不同消息、失败/未完成记录或无合法时间不能补成完成；坏任务单独记录脱敏阶段与原因，后续任务继续核对。

正常退出 → 取消本进程控制器并保存 host-suspend → 按原业务状态和提交屏障恢复；用户/业务停止 → 保存 terminal → 重启和挂起均不复活。旧停止意图不明确 → 完整证明只能开放本次明确只读重验 → 当前进程许可校验 → 重新验收；不自动发送、不清草稿、不把 unknown 降级。状态及生命周期变化都会产生新 checkpoint，拒绝原因包含固定检查布尔与有限 Vault code/op。

恢复核对把“查到本轮回执”和“Bunny确认原提交未生效”作为不同分支：前者直接补全回执；后者在完整记录、原会话、精确草稿和当前画面支持下保留正文与轮次，核查当前权限后续交一次，再等待新回执。未知判断保留缺口等待新事实，迟到回执、草稿变化和取消优先于任何恢复输入。权限维护不阻塞恢复核对，界面显示实际检查与下一恢复时点。

## 7. 异常、自主恢复与保活

```mermaid
flowchart TD
    Active["原 Task / Action：局部执行与实际回执"] --> Local["按情景联合核实关键疑点、历史反思、探索与补救"]
    Local -->|"可安全继续"| Active
    Local -->|"明确无法自行突破"| Suspend["同 episode 自我挂起；原目标、scope 与效果保留"]
    Local -->|"预算到达；障碍仍不确定"| Yield["让出本轮资源；不冒充自我挂起或失败"]
    Monitor["原调度器监测：运行期限、无进展、WorkBuddy 异常"] --> Request
    Suspend --> Request["原 Task / Action.mainReview：登记、持久化、去重"]
    Yield --> Request
    Request --> Self["SelfSystem：共享身份、记忆、Summary、经验与最新相关情景；独立调用状态"]
    Self --> Decision["主脑高层决定与可修订指导；不执行工具"]
    Decision --> Validate["原 runtime 校验 reviewId、scope、目标、控制、授权及写入效果"]
    Validate -->|"有效指导"| Commit["原保存串行区提交；新策略获有界窗口；不清空 episode 或账本"]
    Validate -->|"停止、撤权或依据失效"| Reject["拒绝迟到应用，保留来源与原因"]
    Commit -->|"原 scope 安全边界消费"| Active
    Commit -->|"等待具体条件"| Wait["保存条件与下次审阅时间，释放 worker"]
    Wait --> Request
    Commit -->|"主脑明确 needs_owner / fail"| Report["保存 disposition，经原渠道说明依据、缺口和继续条件"]
    New["可信新观察"] -->|"自挂起或暂缓只复评"| Request
    Owner["主人对话、语音、停止与其它 scope"] --> Independent["独立响应；停止/撤权即时生效"]
    Services["模型或保存无响应"] --> Bounded["逻辑有界退让；物理请求/实际写入仍被原链跟踪"]
```

普通建议不取消正常 worker；仅明确检查点重启且无其它活跃 scope 时可隔离唯一失效调用。所有新输入仍走原权限、GUI lease、操作账本和派发前检查。后台模型满额是普通等待，为主人对话保留容量；主脑督导不直接说话，不借主人对话的 busy 或 controller。主进程与任务系统是程序组织，主脑与任务脑是 LLM 认知用途；不存在第二人格或执行账本。

## 8. 感知、经验吸收与工具演进

```mermaid
flowchart TB
    Input["键盘 / 音频 / 图像 / 工具结果"] --> Sensor["实际感知器及转换链"]
    Diagnostic["主人开启本机诊断；最长20秒"] --> PrivateSensor["独立识别器；暂停普通聆听及自动重启"]
    PrivateSensor --> PrivateSink["同一过滤与轮次规则 → 私有文件接收端"]
    PrivateSink --> DiagnosticEnd["停止采集并有界排空；不进入对话或Task；手动清理"]
    Mic["AVAudioEngine 原始麦克风"] --> Echo["启用时：固定版 WebRTC AEC3"]
    Reference["私有 unmuted CoreAudio 全局输出 tap"] --> Echo
    Echo --> Audio["格式转换 → 同一份最终 PCM"]
    Echo -.->|"参考拒绝、超时或断流：有界降级并受控恢复"| Audio
    Audio --> Analyzer["SpeechDetector人声门控 + Transcriber增量识别"]
    Names["设定：正确名字 + 用户别名昵称"] --> Vocabulary["统一去重总库最多512项；系统识别选取最多100项"]
    ExtraWords["听力：共享额外热词；默认 WorkBunny / Workbuddy"] --> Vocabulary
    WordManagement["用户编辑 / Bunny已有对话或任务中的增改删"] --> WordSave["版本检查 + 既有提交门 / OperationLedger → 保存真实回执"]
    WordSave --> ExtraWords
    Vocabulary --> WordSnapshot["启动或下一自然识别段取快照；不重启采集"]
    WordSnapshot --> Analyzer
    Analyzer -.-> WordReceipt["系统上下文 submitted / failed；不等于准确率增益"]
    Audio --> VAD["独立VAD：随物理音频连续；不随Analyzer冷启，不裁音频"]
    Audio --> Speaker["声纹特征"]
    Analyzer --> EndGate
    VAD --> EndGate["交付事件异步复核：同代新鲜静音 600ms；timer兜底"]
    EndGate --> FinalBarrier["完整输入finalizer成功 + 结果流排空 + 实际输入范围校验 → 仅上报一次"]
    FinalBarrier --> TurnGate["整句确认 + 新鲜quiet → 立即语义请求"]
    TurnGate -.->|"精确后继来源在短quiet窗口请求真实排空"| FinalBarrier
    VAD --> TurnGate
    TurnGate --> EntryGate["microphone-observation候选；合并未完成输入"]
    Partial["同范围声学支持的partial增量显示；非已知回声同步打断"] --> TurnGate
    Partial --> Unconfirmed["八秒输入未确认或提交门超时：丢弃未确认输入"]
    VAD --> EffectGate["当前提交门：fresh quiet；新有声须新定稿"]
    EffectGate --> WaitGate["实际副作用等待时关门：保留同轮结果；独立八秒有界等待"]
    WaitGate -.-> EffectGate
    WaitGate --> Unconfirmed
    Unconfirmed --> Rearm["普通识别失败静默；1.2–8秒退避恢复；旧回调隔离"]
    WaitGate -.->|"已接纳操作实际等待提交失败"| EffectNotice["如实提示未执行；不以失败冒充成功"]
    FinalBarrier -.->|"识别/定稿失败；无成功回执"| Rearm
    EntryGate --> AsrContext["ASR纠错经验 + 名字/昵称/热词 + 语义与交流间隔 + 实际播放线索；同次调度解释并回答"]
    Vocabulary --> AsrContext
    AsrContext --> Observation
    VAD --> VoiceFault["四秒无证据 / 最长界：取消未确认片段并有界恢复"]
    Sensor --> Observation["原内容 + perception + 可用证据引用"]
    Observation --> Think["Bunny 综合上下文判断；关键歧义才补证"]
    Think --> Decision{"同次推理：是否为需处理的对话？"}
    Decision -->|"忽略 / 成功空决定"| Silent["退休候选；无气泡/声音/主人历史"]
    Decision -->|"接纳"| Accepted["记录已接纳发言；原效果门保持有效"]
    Accepted --> Reply["普通非敏感答复：有效轮次展示/朗读"]
    Accepted --> EffectGate
    EffectGate --> Act["授权内行动及自主核查；真实提交处重核"]
    Act --> Outcome["真实成功、失败、恢复与适用条件"]
    Dialogue["渠道历史与重要事实"] --> Doze["分渠道、分场景 Doze Summary"]
    Dialogue --> Dream["统一 Dream / Deepdream 调度与预算"]
    Outcome --> Dream
    Pack["主人选择混合资料 ZIP / 文件夹，不预先分类"] --> Validate["路径与完整性检查；凭据等本地过滤"]
    Validate --> Source["加密隔离来源与游标；不执行代码"]
    Source --> Dream
    Dream --> Absorb["Bunny 理解资料、按需检索已有记录、剔除风险"]
    Absorb --> Stage["快照复查后提交记忆、经验修订、静态审查工具"]
    Stage --> ImportReport["基于实际写入生成新增/合并/忽略报告"]
    Bundle["安装包更新"] --> Innate["独立只读先天区；用户与 Bunny 不可修改"]
    Innate --> Retrieve
    Dream --> Related["有限相关候选；Bunny 合并、修订、并存或判失效"]
    Related --> Commit["核对来源与代次后提交修订；保留引用"]
    Commit --> Repo["同一加密记忆库：事实、经验、工具元数据"]
    Doze --> Repo
    Repo --> Retrieve["按目标、场景和标签取概要；共享有界祖先检查"]
    Retrieve --> Prepare["排除回到本 Task 或不完整来源链；快照准备"]
    Prepare --> SavePolicy["核对任务/控制/资料代次；先持久化"]
    SavePolicy --> AdoptPolicy["成功后合入经验；保留旧来源"]
    AdoptPolicy --> Think
    Tools["不可变工具资源与接口"] --> Act
    Stage --> Tools
    Stage --> Repo
```

私聊记忆不进入任务经验提炼，Task 读取最高生活；导入不等于执行或授权。经验更新和模型解释都不能被当作外部效果已经发生的证据。

任务列表清理：本机主人请求 → 快照旧任务 → 本地同步停止并释放名额 → 至多30秒的一轮外部清理 → 记录错误 → 加密保存列表隐藏标记。终态 X 直接保存同一隐藏标记；“恢复已清理任务”只移除标记，保留终态和取消的旧报告。整个过程不级联删除资料或文件。

操作取证：既有 Operation/控制器上下文 → UTC+单调时钟+序号 → 截图采集/同轮VLM/区域变化/输入预检/派发请求/原生回执或未知 → 白名单异步滚动元数据。异常 → 关联原 Operation 的脱敏引用进入原错误链 → 复用最近已采像素及随后正常观察的有限关联帧 → 有钥匙则异步本地加密，否则记录缺口。该支路不调度额外截图或输入，不解除暂停，不影响业务回执；已有授权内精确单帧读取并校验完整性，重建只报告最近关联动作和证据覆盖范围，不自动给出退出原因。
