# WorkBunny

以长期记忆维系关系的 macOS 桌面伙伴，也是协助你交办、跟进和检查 WorkBuddy 任务的小秘书。当前版本为 **v0.14.10**。

[下载 macOS Apple Silicon 版](https://github.com/zhyuzh3d/workbunny/releases/download/v0.14.10/workbunny-0.14.10-macos-arm64.zip) · [Release 与校验文件](https://github.com/zhyuzh3d/workbunny/releases/tag/v0.14.10) · [发布说明](docs/workbunny-0.14.10-发布说明.md)

## 使用

- 仅支持 Apple Silicon。最低构建目标 macOS 13，当前实测 macOS 26.5.1；13/14/15 和其他 Mac 仍待实机验收。
- 对话可选 WorkBuddy、DeepSeek、ChatGPT 或 Grok。使用 WorkBuddy 时自动连接已登录账号；任务监督和免费的后台整理、自主生活仍依赖 WorkBuddy。
- 内置形象包括 bunny、芭尼、可可、兰兰、阿雅、琪琪和美莉，默认 bunny；提供 235 个已整理动作，部分素材的再分发权利仍待核实。
- 朗读默认使用系统音色，可选择本地 Qwen、标准 CHP 或豆包语音。Qwen 要求至少16GiB内存，权重在安装后按需下载。
- macOS 26 优先持续端侧识别，旧系统使用自动分段识别；联网识别需明确允许。自动尝试回声消除，持续聆听支持讲话和打字打断；不支持回声消除时使用识别文字过滤回声。

详见 [安装、语音配置与兼容边界](docs/workbunny-macOS安装与兼容.md)。当前使用稳定的本机开发签名，尚未完成苹果公证。

## 记忆与对话

Bunny 共用一份可查看、修订和锁定的自我理解。身份与行为设置作为理解的输入；主人可以直接编辑，锁定后禁止自主改写。每轮按“评估上一轮预测 → 回复 → 新预测”处理，隐藏认知不进入气泡、朗读或普通全文索引。

聊天、记忆、人格和任务回执保存在本机加密资料库。Doze 压缩旧对话，Dream 提炼记忆与相处经验，Deepdream 整理关系、冲突和有效期；相关结论能回查原文、修订和遗忘。私聊、生活、工作有资料边界，角色自我理解保持统一。兴趣与近期目标从实际经历逐步形成。

主动联系和自主创作需要明确授权，支持期限、安静时段、撤销和中断。复杂任务交给 WorkBuddy；微信操作仅通过可见截图和键鼠完成，发送结果不确定时暂停核对，不自动重发。

用户数据默认位于 `~/Library/Application Support/workbunny`，开发数据独立保存在 `.data/dev`。数据库位置可在设置中迁移；断盘时进入恢复，不另建空库。个人 VRM 从“外观 → 定制外形”添加，仅存于用户数据目录，更新不覆盖；可删除个人模型，内置模型受保护。

Bunny 会看到当前形象说明与最近五次实际动作。动作库支持分类、语义描述、权重随机、指定播放、禁用、移除与个人 VRMA 导入。WorkBuddy 等待确认、反复错误、停滞和超过预计耗时会触发本地去重提醒，不额外调用大模型。可在“听力”朗读一段提示文字录入声音并启用近似主人声音筛选；全部在本机处理，不能用作身份认证。跨应用系统通知监听暂不提供。名字唤醒跟随自定义名字，使用本地拼音匹配与可选别名，匹配通过后复用正常回复的语义判断；它不是专用音频唤醒模型。

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

更新安装必须从当前完整源码构建；`tools/package.sh` 和 `tools/install-app.sh` 会核验源码版本、全部审核资源及哈希，拒绝旧包或不完整安装包。

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

官方发行保持免费。源代码采用 [MIT](LICENSE)，第三方模型、动作和标志分别遵循自身条款，不能用项目 MIT 覆盖。各模型分别遵循自身许可；模型和动作的出处、署名、移出原因见 [第三方声明](THIRD_PARTY_NOTICES.md)、[动作署名](licenses/ANIMATION-NOTICE.md)、[资源处理清单](docs/workbunny-0.13.0-资源处理清单.md) 和 [机器可读审计](docs/assets-audit.json)。

芭尼的使用、修改与再分发须遵守其使用的 VRoid AvatarSample D 素材条款；生成所用混元 3D Studio 的具体服务条款仍待核实，详见第三方声明和资源清单。

婷婷模型及已知裸文件分发受限的动作不进入安装包。下列经用户评审选入的动作仍未取得可核实的再分发授权，不能依据本项目 MIT 许可使用。非商用、公示或未收到异议均不等于获得授权。历史审计文档描述的是当时的资源范围。


## 版权待核实的动作及授权请求

以下动作已包含于本构建，文件均位于 `src/renderer/assets/motions/`；逐项来源、SHA-256 和当前许可状态见 [资源清单](resources-manifest.json)。Rocketbox/Hanami 上游标示 MIT，但该许可对对应动作素材的覆盖范围尚待权利人确认；旧动作库素材的原作者及许可尚未查明。

- **Rocketbox / Hanami，许可范围待确认：** `rb_angry_2.vrma`、`rb_angry.vrma`、`rb_happy_2.vrma`、`rb_happy_3.vrma`、`rb_happy.vrma`、`rb_idle_2.vrma`、`rb_idle_3.vrma`、`rb_idle_4.vrma`、`rb_idle_talking_2.vrma`、`rb_idle_talking_3.vrma`、`rb_idle_talking.vrma`、`rb_idle.vrma`、`rb_laugh.vrma`、`rb_listen_2.vrma`、`rb_listen_3.vrma`、`rb_listen.vrma`、`rb_neutral_2.vrma`、`rb_neutral_3.vrma`、`rb_neutral_4.vrma`、`rb_neutral.vrma`、`rb_nod_2.vrma`、`rb_nod_3.vrma`、`rb_nod.vrma`、`rb_relaxed_2.vrma`、`rb_relaxed_3.vrma`、`rb_relaxed_4.vrma`、`rb_relaxed.vrma`、`rb_sad.vrma`、`rb_shake_2.vrma`、`rb_shake_3.vrma`、`rb_shake.vrma`、`rb_shrug_2.vrma`、`rb_shrug.vrma`、`rb_think_2.vrma`、`rb_think.vrma`、`rb_wave_2.vrma`、`rb_wave.vrma`。

- **旧动作库，来源和许可待查：** `idle_look.vrma`、`idle_breath.vrma`、`idle_lalala.vrma`、`idle_shift.vrma`、`greet_wave.vrma`、`greet_hand.vrma`、`bye_goodbye.vrma`、`bye_wave.vrma`、`cheer_clap_vr.vrma`、`cheer_jump_vr.vrma`、`cheer_hop.vrma`、`cheer_yay.vrma`、`cheer_clap_maya.vrma`、`cheer_cross.vrma`、`cheer_joy.vrma`、`praise_snap.vrma`、`dance_excited_maya.vrma`、`dance_macarena.vrma`、`tease_cat.vrma`、`tease_scare.vrma`、`tease_catwalk.vrma`、`refuse_head.vrma`、`refuse_reject.vrma`、`refuse_shrug.vrma`、`refuse_waving.vrma`、`angry_pout.vrma`、`angry_tsundere.vrma`、`angry_hip.vrma`、`angry_arms.vrma`、`shy_cute.vrma`、`shy_bashful.vrma`、`think_lady.vrma`、`think_idea.vrma`、`think_cute.vrma`、`think_dw.vrma`、`sorry_sad.vrma`、`sorry_cry.vrma`、`sorry_sigh.vrma`、`tired_stretch_vr.vrma`、`tired_sleep.vrma`、`tired_reach.vrma`、`tired_nod.vrma`、`tired_yawn.vrma`、`tired_armstretch.vrma`、`thanks_bow_reika.vrma`、`thanks_maya.vrma`、`surprise_scratch.vrma`、`surprise_vr.vrma`、`motion_spinjump.vrma`、`motion_run.vrma`、`motion_situp2.vrma`、`motion_situp.vrma`、`motion_spin.vrma`、`talk_talk.vrma`。

如您是上述素材的版权所有者，恳请您通过 [素材反馈](https://github.com/zhyuzh3d/workbunny/issues/new?template=asset-rights.md) 联系我们，确认是否授权分发；如您认为使用侵犯了您的权益，也请告知，我们会及时核实并移除。此请求和删除承诺本身不构成授权。
