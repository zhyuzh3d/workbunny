# 测试入口

从项目根目录运行。默认回归、隔离 GUI 验证与真实账号实验分开，不能把调用成功或截图相近当成业务目标已完成。

## 默认离线回归

需要 macOS 原生构建环境、Node.js 22 以上和项目依赖：

```sh
npm ci
zsh tools/build-vault.sh
zsh tools/build-desktop.sh
zsh tools/make-signing-cert.sh
zsh tools/build-keychain.sh
npm test
```

`tools/test.cjs` 顺序运行本目录顶层的 `.js`、`.mjs` 用例。覆盖对话与场景、加密记忆与来源、渠道授权、Task/Action 生命周期、效果账本、保活、上下文、感知、经验资源包、工具引用、安装回滚及角色/语音基础能力。测试使用合成输入、临时数据库和受控原生协议，不读取正式聊天库、不调用真实 LLM、不向真实联系人发消息。

单项运行：

```sh
node --test test/test-task-keepalive.js
node --test test/test-experience-repository.js
node --test test/test-dialogue-channels.js
```

`test/fixtures/` 保存合成界面，`test/support/` 保存公共夹具与驱动。设备驱动必须显式提供授权设备和会话目标，不内置开发者的账号或设备标识。

## 显式图形与安装包验证

顶层 `.cjs` 是手动运行的 Electron、GUI 或原生集成入口，不纳入默认回归。先阅读文件头的运行环境与副作用说明，例如：

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-panel-scene-settings.cjs
node test/test-embodiment-app.cjs --source
node test/test-view-scale-app.cjs --source
```

需要安装包的用例先运行 `zsh tools/package.sh`。使用合成数据和临时用户目录；发行资源数量及哈希以 `resources-manifest.json` 为准。进程退出、系统授权、实际音频播放、界面结果和用户数据隔离分别检查。

## 显式模型与账号实验

`test/live/` 及文件名带 `live`、`model` 的部分 `.cjs` 入口可能调用当前已登录服务或操作桌面。它们都需要独立授权与环境检查，不能随离线回归自动执行。执行前确认实际读取范围、费用、目标和停止条件。

真实微信只能通过外部截图和通用输入操作，不能使用内部接口、数据库、辅助功能控制树或自动登录。保留输入前后、实际效果与接收方证据，结果未知时不重复发送。

绑定个人账号、USB 序列号或某一次实验路径的脚本、截图和报告存放在外置私有备份，不随公开源码分发。后续现场测试应由公共夹具和显式配置创建，不恢复硬编码的个人环境。

## 资料与产物

截图、日志、临时数据库及验收记录写入临时目录或忽略的本机目录，不写入 `docs/`。长期保留的过程资料和旧安装包移至指定外置备份；正式用户资料不作为测试缓存清理。

资源检查工具为 `node tools/motion-quality-audit.mjs`，结果写入 `.cache/`。检查不会自动改变许可状态或将个人资源加入发行白名单。默认测试通过不代表真实云服务、其它 Mac、旧系统或长期使用效果已经验收。
