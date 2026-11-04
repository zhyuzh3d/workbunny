<img src="res/logo.svg" alt="WorkBunny" width="88">

# WorkBunny

有长期记忆的 macOS 桌面伙伴，也是能替主人行动的小秘书。

Bunny 的目标是积极思考、自主行动、核查真实结果，并从成功与失败中积累经验。框架提供调度、感知、权限、工具和恢复保障；Bunny 根据情景选择方法，经验作为可修订的参考。

[下载安装](https://github.com/zhyuzh3d/workbunny/releases/latest) · [产品需求](docs/product-requirements.md) · [架构设计](docs/architecture.md) · [架构 FLOW](docs/flows.md)

> 当前源码版本为 **0.24.21**。源码开发进度与已公开的安装包分别管理；本轮更新不创建新 Release。

## 能做什么

- **陪伴与交流**：桌面角色、文字及语音对话、独立渠道历史、可查看和修订的自我理解。
- **长期记忆**：记住主人交代的重要信息；Doze 压缩对话，Dream 与 Deepdream 整理事实、关系和经验，区分私聊、生活与工作。
- **自主任务**：自然语言交办、持续监听、通用桌面与工具操作、WorkBuddy 委派、任务进度和结果回传。
- **恢复与时间意识**：保留目标及实际回执，自主补证、换方法和恢复；任务真正空闲时由原调度器提醒继续思考。
- **经验与工具积累**：ZIP 或文件夹导入经验和配套工具，按目标与标签检索，结合实际反馈整理和更新。
- **本机管理**：加密资料库、个人形象与动作资源、数据迁移及加密备份；更新保留个人资料。

## 安装与使用

目前面向 **Apple Silicon Mac**。最低构建目标为 macOS 13，持续端侧语音识别需要 macOS 26；当前设备验证不代表旧系统或其它 Mac 已通过。发行采用稳定本机开发签名，尚未完成苹果公证。

1. 从 [Releases](https://github.com/zhyuzh3d/workbunny/releases) 下载公开安装包，正常退出旧版后安装。
2. 打开设置，选择并配置对话模型。WorkBuddy 模式连接当前已登录账号；也可配置直接 API。后台免费整理与 WorkBuddy 任务监督仍依赖 WorkBuddy。
3. 按需要授权麦克风、语音识别、辅助功能及屏幕录制。文字输入可独立使用；微信仅使用外部视觉和键鼠，不使用内部接口或自动登录。
4. 在对话中交办目标，或在“任务与工作”查看进展、暂停、继续和停止。Bunny 接到主人任务先回应，再执行。
5. 在“记忆”导入经验 ZIP 或文件夹。可直接参考 [示例资源包](examples/experience-pack/)；导入不会自动执行其中的工具。

朗读支持系统音色及可选的本地/远程引擎；本地 Qwen 权重按需下载，要求至少 16GiB 内存。[HTTP 配置示例](examples/tts-profiles/)不包含地址或凭据。

外部主人身份识别**默认关闭**，只能由主人在本地设置开启。开启后按实际新来信认证，临时授权属于整个对话渠道；关闭或修改密钥立即撤销外部授权。身份密钥在 Bunny 对话输出中替换为星号。详细权限与隐私要求见[产品需求](docs/product-requirements.md)。

## 项目结构

```text
src/                    主进程、隔离界面、预加载桥及发行资源
native/                 ASR、Vault、钥匙串与桌面桥的 Swift 源码
tools/                  开发、构建、打包、安装及资源检查工具
test/                   离线回归、隔离 GUI 验证和显式账号测试
examples/               经验与工具资源包、语音配置示例
docs/                   产品需求、架构设计与流程图
licenses/               第三方许可、署名与资源审计
res/                    标准标志、图标与托盘资源
resources-manifest.json  发行素材白名单、来源、许可状态及哈希
```

`node_modules/`、`bin/`、`dist/`、`.data/`、`.cache/` 是本机生成目录。真实聊天、设备标识、截图、历史实验和旧构建产物不属于公开源码。当前设计统一从 [docs 索引](docs/README.md)进入，避免重复维护按日期分散的计划。

## 开发与构建

需要 Apple Silicon、macOS 26 SDK/Xcode 命令行工具、Node.js 22 以上、CMake 与 Git。

```sh
npm ci
zsh tools/setup-dev.sh
zsh tools/make-signing-cert.sh
zsh tools/build-asr.sh
zsh tools/build-asr-legacy.sh
zsh tools/build-vault.sh
zsh tools/build-desktop.sh
zsh tools/dev-prepare.sh
zsh tools/run-dev.sh
```

开发资料独立使用 `.data/dev`，正式资料默认位于 `~/Library/Application Support/workbunny`。不要将正式资料、账号票据或个人模型复制进仓库。首次解锁请完成系统钥匙串授权；不要删除旧钥匙或资料库绕过锁定。

```sh
npm test
zsh tools/package.sh
node tools/verify-bundle.cjs dist/workbunny.app
zsh tools/install-app.sh
```

[测试入口](test/README.md)说明离线、图形和显式账号验收的区别。默认回归不调用真实 LLM 或给真实联系人发消息。

构建和安装核对当前源码、资源白名单、哈希与签名。正常退出旧版后安装；失败保留回滚，成功清理旧应用备份，用户资料不在清理范围内。关键版本需要外置归档时，使用 `WORKBUNNY_ARCHIVE_PREVIOUS=1`，并可通过 `WORKBUNNY_ARCHIVE_VOLUME` 指定外置卷；外置备份失败会停止安装。

准备公开源码快照时，先提交经过审查的文件并重新构建，再运行 `node tools/source-release.js`。它只收集 Git 跟踪的维护文件及已核验的发行资源，不打入 Git 历史、运行资料、私有实验或模型权重。创建 GitHub Release 是单独的发布步骤。

## 能力边界

Bunny 依据实际信息自主验收 Task 与 Action，工具调用成功不等于业务完成。未知发送保留证据并继续核对，不自动重发。经验和自我修复不能扩大授权，也不代表允许自动改写正式应用。

其它 Mac/旧系统兼容、长期学习效果和开放任务能力仍需持续验证；当前设备的真实实验与离线测试分别报告。资源包导入、模型整理和真实任务能力提升也分别验证。

## 许可与素材

WorkBunny 自有源码使用 [MIT](LICENSE)，官方发行保持免费。第三方形象、动作和组件按各自条款使用，不能用项目 MIT 覆盖。

**当前资源选择中仍含权利待核实的动作，不能视为已取得再分发授权。** 逐项范围及授权请求见[动作署名与待核实清单](licenses/ANIMATION-NOTICE.md)，来源和哈希见[资源清单](resources-manifest.json)及[历史素材审计](licenses/assets-audit.json)。完整说明见[第三方声明](THIRD_PARTY_NOTICES.md)。

版权所有者可通过[素材反馈](https://github.com/zhyuzh3d/workbunny/issues/new?template=asset-rights.md)联系项目。公示、免费或未收到异议均不构成授权。
