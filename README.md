# WorkBunny

以长期记忆维系关系的 macOS 桌面伙伴，也是协助你交办、跟进和检查 WorkBuddy 任务的小秘书。当前开发基线为 **v0.13.0**。

[下载 macOS Apple Silicon 版](https://github.com/zhyuzh3d/workbunny/releases/download/v0.13.0/workbunny-0.13.0-macos-arm64.zip) · [Release 与校验文件](https://github.com/zhyuzh3d/workbunny/releases/tag/v0.13.0) · [发布说明](docs/workbunny-0.13.0-发布说明.md)

## 使用

- 仅支持 Apple Silicon。最低构建目标 macOS 13，当前实测 macOS 26.5.1；13/14/15 和其他 Mac 仍待实机验收。
- 必须安装并登录 WorkBuddy。它是唯一 LLM 通道，Bunny 自动发现账号，设置中也可重新连接，无需复制账号票据。
- 内置可可、阿雅、琪琪、美莉四个角色及18个确认可分发的动作，默认可可、100%窗口半身像。
- 朗读默认使用系统音色，可选择本地 Qwen、标准 CHP 或自定义 HTTP。Qwen 要求至少16GiB内存，权重在安装后按需下载。
- macOS 26 优先持续端侧识别，旧系统回退到按次识别；联网识别需明确允许。播放时自动半双工，无需额外配置回声消除。

详见 [安装、语音配置与兼容边界](docs/workbunny-macOS安装与兼容.md)。当前使用稳定的本机开发签名，尚未完成苹果公证。

## 记忆与对话

Bunny 共用一份可查看、修订和锁定的自我理解。身份与行为设置作为理解的输入；主人可以直接编辑，锁定后禁止自主改写。每轮按“评估上一轮预测 → 回复 → 新预测”处理，隐藏认知不进入气泡、朗读或普通全文索引。

聊天、记忆、人格和任务回执保存在本机加密资料库。Doze 压缩旧对话，Dream 提炼记忆与相处经验，Deepdream 整理关系、冲突和有效期；相关结论能回查原文、修订和遗忘。私聊、生活、工作有资料边界，角色自我理解保持统一。兴趣与近期目标从实际经历逐步形成。

主动联系和自主创作需要明确授权，支持期限、安静时段、撤销和中断。复杂任务交给 WorkBuddy；微信操作仅通过可见截图和键鼠完成，发送结果不确定时暂停核对，不自动重发。

用户数据默认位于 `~/Library/Application Support/workbunny`，开发数据独立保存在 `.data/dev`。数据库位置可在设置中迁移；断盘时进入恢复，不另建空库。个人 VRM 从“外观 → 导入个人模型”添加，仅存于用户数据目录，更新不覆盖。

## 项目结构

```text
src/                    主进程、预加载桥、界面、发行模型和动作
native/                 ASR、Vault、钥匙串和桌面桥的 Swift 源码
tools/                  开发准备、构建、打包、安装与动作检查脚本
test/                   离线单元/集成测试、隔离 Electron 测试和显式 live 测试
res/                    图标与托盘资源
licenses/               第三方依赖与素材许可
docs/                   当前架构、安装、协议和素材来源
resources-manifest.json  发行素材白名单、来源与哈希
```

当前开发与测试说明见 [架构与开发入口](docs/architecture.md) 和 [测试入口](test/README.md)。仓库不保存个人模型、参考音频、实验工程、旧计划、验收过程、旧安装包或开发数据库。`node_modules/`、`bin/`、`dist/`、`.data/`、`.cache/` 为本机生成目录。

## 开发与构建

需要 Apple Silicon、macOS 26 SDK/Xcode 命令行工具、Node22以上、CMake 和 Git。

```sh
npm ci
zsh tools/setup-dev.sh
zsh tools/build-asr.sh
zsh tools/build-asr-legacy.sh
zsh tools/build-vault.sh
zsh tools/build-desktop.sh
zsh tools/dev-prepare.sh
zsh tools/run-dev.sh
```

开发环境与正式资料隔离，不会自动导入安装版的个人模型、设置或历史记忆。

公开安装包：

```sh
zsh tools/make-signing-cert.sh
zsh tools/package.sh
node tools/source-release.js
```

`package.sh` 自动准备必要原生组件和固定版本的本地语音运行时，严格按白名单打包。产物为 `dist/workbunny.app`；源码快照包含当前测试及其夹具。签名身份须保持稳定，任何签名失败都会停止构建。签名私钥、API Key、账号票据、用户资料和模型权重不得进入仓库。

## 测试

先按 [测试入口](test/README.md) 准备原生程序与本机签名，再运行：

```sh
npm test
```

默认运行离线单元与合成集成测试，不调用真实 LLM 或操作真实联系人。需要图形环境的 `.cjs` 测试与 `test/live/` 中的账号验收按 [测试说明](test/README.md) 显式执行。不要用测试结果代替旧系统、其他 Mac 或长期相处质量的实测。

## 许可与素材公示

官方发行保持免费。源代码采用 [MIT](LICENSE)，第三方模型、动作和标志分别遵循自身条款，不能用项目 MIT 覆盖。四个官方模型不是 CC0；模型和动作的出处、署名、移出原因见 [第三方声明](THIRD_PARTY_NOTICES.md)、[动作署名](licenses/ANIMATION-NOTICE.md)、[资源处理清单](docs/workbunny-0.13.0-资源处理清单.md) 和 [机器可读审计](docs/assets-audit.json)。

婷婷及17个裸文件分发受限动作、60个许可待核实动作不在公开代码树或安装包中。非商用、公示或未收到异议均不等于获得授权；欢迎通过 [素材反馈](https://github.com/zhyuzh3d/workbunny/issues/new?template=asset-rights.md) 补充出处与许可。历史版本资料可在对应 Git 标签和 Release 源码快照中查阅。
