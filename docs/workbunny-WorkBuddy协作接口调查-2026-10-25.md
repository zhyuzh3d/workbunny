# WorkBuddy 协作接口调查（2026-10-25）

> 本文原调查对象为 5.8.3，以下历史范围与只读结论保留。随后用户重启并更新到 5.9.2，已另行授权完成 GUI 派发实测：WorkBuddy 专用控件适配 + 普通键盘输入成功提交简单任务，真实 Monitor 读到完成。最新结果、GUI effort 未核验边界及“小秘书”责任分工见 [0.3.4 验收](workbunny-0.3.4-桌面协作与授权稳定性.md)。当前采用 WorkBuddy GUI 承担工作，没有使用 CLI 另建工作执行团队。

## 范围与结论

只检查当前安装的 WorkBuddy 5.8.3（`/Applications/WorkBuddy.app`）和其随附 CLI 2.161.0 的帮助及程序代码，以及 workbunny 自己的 broker 客户端。没有读取 `~/.workbuddy/wbipc/endpoint.json` 内容、会话数据库、对话记录、密钥或 token；没有发任务或请求，也没有启动/停止用户会话。电脑锁屏期间完成。

结论：WorkBuddy 本地 broker 对外可见的主要能力是经过会话认证的 `wb.request/http.fetch` 账号 HTTP 转发；已安装的 broker 代码没有注册 GUI agent/task 创建、查询或取消 pipe。随附 CodeBuddy CLI 则有独立的后台 session 派发、JSON 查询与停止能力，比坐标点击更适合管理由 CLI 创建的 session，但安装包当前 CLI 帮助列出的模型 ID 不含 `hy3` / `hy3-x`，也没有证据表明其后台 session API 能查询/取消 WorkBuddy GUI 当前任务。GUI 中的 `Hy3` 标签也不能区分免费 `hy3` 与付费 `hy3-x`。

## 本地 broker：已读到的协议

workbunny 客户端在 [workbuddy.js](src/main/workbuddy.js:16) 从当前用户目录发现 broker endpoint；源码明确要求端点文件只由当前用户拥有且不是符号链接，并且只在内存中使用其中 ticket。本文没有读取文件本身或其字段值。认证按协议 1 的 `session_hello` → `session_challenge` → `session_prove` → `session_hello_ack` 进行；连接只在 broker 宣告 `wb.request` 后取 pipe，再调用它公布的 `http.fetch` 方法。客户端的确切请求结构见 [workbuddy.js](src/main/workbuddy.js:61)：

```json
{"jsonrpc":"2.0","id":1,"method":"broker/GetPipe","params":{"pipe":"wb.request"}}
{"jsonrpc":"2.0","id":2,"method":"c:wb.request/http.fetch","mode":"call","params":{"method":"POST","path":"/v2/chat/completions","headers":{"content-type":"application/json","accept":"text/event-stream"},"body_b64":"<标准 base64 请求体>"}}
```

这里的 `c:wb.request` 是 `GetPipe` 响应返回的 channel 名称，不应硬编码成通用 broker channel。`http.fetch` 走 WorkBuddy 当前登录账号的服务端点，接收 HTTP 方法 `GET/HEAD/POST/PUT/PATCH/DELETE`、以 `/` 开头的相对 path、独立 query 对象和受限请求头；源码拒绝协议相对 URL、`..` path 段、query/hash 混入 path，以及非白名单请求头。GET/HEAD 不允许 body；body 使用标准 base64。服务端对请求设置约 50 秒超时，内联响应上限为 655,360 字节。workbunny 当前聊天实际使用 `POST /v2/chat/completions`，将 JSON body 编为 base64；SSE 返回时优先读取响应事件的 `model` 字段作为实际返回模型 ID，字段缺失才回退到请求的 model，见 [workbuddy.js](src/main/workbuddy.js:109) 和 [workbuddy.js](src/main/workbuddy.js:122)。

安装包源码证据位于 `/Applications/WorkBuddy.app/Contents/Resources/app.asar` 的 `main/server.js`（生产打包、单行压缩模块）：

- `WbipcPipeRegistry`、`Connection.handleGetPipe`、`Connection.handleChannelCall` 实现 pipe 列举、解析及方法/调用模式校验。`session_hello_ack` 返回当前连接可见的 pipe 名单。
- `createWbipcService` 默认只注册 `createWbRequestPipe`。随 WorkBuddy 产品额外注册的是 `wb.entitlement/subscription.check` 和 `wb.wecom-a2a/authorize`；未见 agent/task pipe 的注册。
- `createWbRequestPipe` 只公布 `http.fetch` 一个 `call` 方法。静态代码中未见以 GUI task/session 为目标的 `create/delete/cancel/list task` broker 方法。

所以该 broker 可用于发起新的兼容账号 API 请求，但它不是现有 GUI agent 任务的可靠派发/回查/取消通道。本文没有试探任何其他 API path，也没有真实调用 `http.fetch`。

## 随包 CLI：session 工作流

CLI 位于 `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`，包内代码在 `.../cli/dist/codebuddy-lite-wb.mjs`。从安装程序实测 `codebuddy --version` 输出 `2.161.0`。常规无环境 `codebuddy --help` 在本安装包中因缺少 `dist/codebuddy` 失败；`bin/codebuddy` 明确提供 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 路由，测试时设该变量并把 `HOME` / `XDG_CONFIG_HOME` 指向临时目录后，CLI 帮助正常返回。这样没有读取当前用户 session。

帮助与静态实现确认这些操作：

- `codebuddy [options] [command] [prompt]` 可以以 prompt 创建一个新的 CLI 对话；`--print` 是前台调用并输出后退出。`--model <model>` 指定当前 session 模型 ID。
- `--bg` / `--background` 以 detached 后台 session 启动，`--name` 命名；可同时指定 `--model`、`--agent` 与 `--permission-mode`。`dispatchBackgroundSession` 会生成 session UUID、记录 prompt/cwd/重启参数并 fork background worker。这里记录的是新建的 CLI session，不是已运行 GUI 任务。
- `codebuddy agents --jobs` 将 session 列表输出成 JSON；`--all` 包含已完成 session。`codebuddy ps --json` 查询活动 session；`kill` / `stop` 结束后台 session；`rm` 仅从 agent 视图移除条目；`respawn` 恢复原 session。
- `codebuddy agents` 打开交互式 agent view，可通过 `--model`、`--agent`、`--cwd` 设置新派发 session 的默认值。

上述 CLI 帮助只用于列举接口；本调查没有运行 `--jobs`、`ps`、`kill`，没有派发 prompt。当前会话已授权后续工作实验，CLI 是管理“由 CLI 创建的任务”的候选；尚未验证其账号及免费模型契约，不能据此声称它能控制 GUI 已有任务。

## Hy3 / hy3-x：名称与实际模型 ID

安装包 renderer 资源 `.../app.asar.unpacked/renderer/assets/contexts-BNN7VV-R.js` 包含明确的 paid-line 映射：`freeId: "hy3"`、`paidId: "hy3-x"`、两者共用 `displayName: "Hy3"`，并标记允许免费/付费切换。因此 GUI 显示 `Hy3` 本身不足以判断实际模型，必须取请求/当前 session 的模型 ID。相邻定义还有 `hy4` / `hy4-x` 同名成对映射。另一个 agent 目录模型 ID `hy3-preview-agent` 是独立的 `Hy3 preview`，不应与 `hy3` 或 `hy3-x` 混淆。

当前 CLI 的 `--help` 动态显示支持模型清单（临时隔离用户目录下实测）：`auto`、若干 GLM/Kimi/MiniMax/DeepSeek ID；没有 `hy3` 或 `hy3-x`。因此不应把 GUI 的 Hy3 付费切换通过 CLI 的 `--model` 假定为可复现。

安全而可靠的核验原则：模型目录/配置只能说明有哪些 ID 和别名；当前正在运行任务的模型应读取该任务请求的 `model` 字段，或任务完成响应的 `model` 元数据。workbunny 的账号 API 流程已按 SSE 响应模型 ID 记录 `usedModel`。对于 WorkBuddy GUI 现有任务，本地 broker 没有发现只返回当前 task model ID 的公开查询；在不读取其会话/对话状态的本次范围内，无法声称已确定 GUI 当前 task 的模型。模型选择器显示名不可作高倍率任务的验收证据。

## 实测与未验证边界

- **实测只读结果：** app 版本 5.8.3；CLI 版本 2.161.0；隔离用户目录的 CLI 全局/子命令 help 成功；正常无环境 `--help` 因缺包失败；运行任何 CLI task/session 管理命令都没有做。
- **源码结论：** broker pipe 注册和方法限制、CLI 的后台 session 派发与管理命令、Hy3/Hy3-x 的显示名映射。
- **未实测：** 没有读取当前 GUI task 的 session model、发起任何账号请求、创建/查询/取消 CLI session，也没有验证 CLI 是否接受未列出的 `hy3-x` ID。真实任务应在已有授权范围内，以明确模型和可观测回执单独验收。
