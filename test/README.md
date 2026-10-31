# 测试入口

从项目根目录运行。测试代码与主代码保持同级深度，夹具放在 `test/fixtures/`；构建脚本仍在 `tools/`。

## 默认离线回归

```sh
npm ci
zsh tools/build-vault.sh
zsh tools/build-desktop.sh
zsh tools/make-signing-cert.sh
zsh tools/build-keychain.sh
npm test
```

`npm test` 顺序执行本目录 `.js` 与 `.mjs` 文件，覆盖配置、素材、记忆、作用域、对话、授权、原生协议与本地语音模拟。部分用例会重建原生测试程序或使用临时数据库；不读取正式聊天库，不调用真实 LLM，不给真实联系人发送内容。Node22以上运行。

单项示例：

```sh
node --test test/test-assets.js test/test-motion-policy.js
node test/test-portability.js
node test/test-memory-service.js
```

## 图形与打包集成

`.cjs` 文件为显式运行的 Electron、界面或原生集成入口，不包含在默认命令中。按文件头的环境要求执行，例如：

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-panel-scene-settings.cjs
zsh tools/package.sh
node test/test-portability-app.cjs
node test/test-embodiment-app.cjs
node test/test-avatar-picker-app.cjs
node test/test-view-scale-app.cjs
```

打包验收使用临时用户目录，检查签名包的入口、五个模型、评审后的动作、个人模型导入/重启、HTTP TTS 与真实 WebAudio 播放结束；不会打开正式 Vault。测试截图和日志是过程产物，保存在临时目录或 `.cache/`。

`test-avatar-picker-app.cjs` 验证统一模型下拉菜单、个人模型卡片双向同步、外部配置同步及真实 VRM 切换。设置面板夹具另覆盖保存失败回退、快速连续选择与模型列表刷新。

`test-view-scale-app.cjs` 验证底部控件收窄至 80%、50% 半身画布及投影以底部中心缩放、各档位控件尺寸固定，以及重启后恢复。使用隔离数据与真实 VRM，不调用大模型；加 `--source` 可验证当前源码。

## 显式账号验收

`test/live/` 中的合成验收会使用当前 WorkBuddy 账号和模型服务，默认不运行。需要时先阅读文件头，再显式执行。带 `live` 的 Electron 测试同样是手动入口，不纳入离线回归。

动作素材检查：`node tools/motion-quality-audit.mjs`，结果写入 `.cache/motion-quality-report.json`。`tools/motion-window.cjs` 用于重新计算过长动作的裁切窗口；检查工具不会自动改写素材许可或将私人素材加入白名单。

0.14 增加动作调度/回执、说话人筛选、监督估计、虚拟窗口边界及打断预测资格用例。`test-embodiment-app.cjs --source` 可先验证真实源码入口；默认验证签名包，使用不可用的临时 Vault 隔离钥匙串与后台模型。`test-interaction-speech-ui.cjs` 还验证输入事件在500毫秒内停止真实WebAudio。原生声学性能自检：`bin/asr --voice-feature-test` 与 `bin/asr-legacy --voice-feature-test`，不需要麦克风授权。

动作调度与真实渲染验收：`node test/test-motion-playback-app.cjs`；对已构建的本地包使用 `node test/test-motion-playback-app.cjs --bundle`。测试使用临时数据目录，并覆盖按需加载、坐站转换和过渡中的请求。
