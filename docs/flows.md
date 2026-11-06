# WorkBunny 架构与执行 FLOW

流程对应 0.25.0 早期 Beta，更新日期为 2026-11-06。图示记录逻辑责任与主要路径。数据字段和实现边界见[架构设计](architecture.md)。

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
    ready --> stopping: 主人停止
    running --> stopping: 主人停止或取消
    waiting --> stopping: 主人停止或取消
    stopping --> stopped: 子动作收到取消，保留效果记录
    completed --> [*]
    stopped --> [*]
    expired --> [*]
```

这是主要迁移示意；实际迁移还校验来源、代次、权限、未知写入和恢复资格。状态切换不撤销已发生的外部效果。

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
    Plan --> Group["执行可连贯的一组 Operation"]
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

监听和动作是并行职责。LLM 调度的有效性由当前任务、取消与对象规则判断，不能因为后一轮画面无变化就丢弃结果。Operation 不强制逐次核查。

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

## 7. 异常、自主恢复与保活

```mermaid
flowchart TD
    Active["活动 Task / Action"] --> Health{"当前运行事实"}
    Health -->|"工具或模型仍执行；有效等待"| Continue["原超时与等待协议继续负责"]
    Health -->|"调用异常或重复证据无进展"| Diagnose["按错误类型提供最简上下文、耗时与回执"]
    Health -->|"到达一分钟空闲期限"| Reminder["任务调度器发起一条内部继续思考提醒"]
    Reminder --> Original["仍使用同一 Task / Action 的上下文和权限"]
    Original --> Decide["Bunny 判断下一步"]
    Diagnose --> Decide
    Decide -->|"缩减上下文或修复本轮请求"| Tune["调整允许的模块、输出或格式参数"]
    Decide -->|"补证或换方法"| Replan["保留目标、已确认效果及原对象继续"]
    Decide -->|"确需等待"| Wait["记录条件和下一检查时机"]
    Decide -->|"需要主人独有信息或决定"| Ask["清楚说明缺口，任务状态可见"]
    Tune --> Active
    Replan --> Active
    Wait --> Active
    Inactive["已暂停、结束、无事件监听或未知写入"] --> Exclude["不由保活强行重启"]
    Global["自主生活 / 主线程健康 / 进程看门狗"] -.-> Separate["独立职责，不冒充任务保活"]
```

## 8. 感知、经验吸收与工具演进

```mermaid
flowchart TB
    Input["键盘 / 音频 / 图像 / 工具结果"] --> Sensor["实际感知器及转换链"]
    Sensor --> Observation["原内容 + perception + 可用证据引用"]
    Observation --> Think["Bunny 综合上下文判断；关键歧义才补证"]
    Think --> Act["授权内行动及自主核查"]
    Act --> Outcome["真实成功、失败、恢复与适用条件"]
    Dialogue["渠道历史与重要事实"] --> Doze["分渠道、分场景 Doze Summary"]
    Dialogue --> Dream["统一 Dream / Deepdream 调度与预算"]
    Outcome --> Dream
    Pack["外部 ZIP / 文件夹；主人传授；内置指南"] --> Validate["路径、清单、完整性、精确去重"]
    Validate --> Stage["固定工具快照；提交来源和当前 head"]
    Stage --> Dream
    Dream --> Related["有限相关候选；Bunny 合并、修订、并存或判失效"]
    Related --> Commit["核对来源与代次后提交修订；保留引用"]
    Commit --> Repo["同一加密记忆库：事实、经验、工具元数据"]
    Doze --> Repo
    Repo --> Retrieve["按目标、场景和标签取概要；正文及工具按需展开"]
    Retrieve --> Think
    Tools["不可变工具资源与接口"] --> Act
    Stage --> Tools
```

私聊记忆不进入任务经验提炼，Task 读取最高生活；导入不等于执行或授权。经验更新和模型解释都不能被当作外部效果已经发生的证据。
