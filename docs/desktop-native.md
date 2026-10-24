# 桌面原生桥接

`native/desktop.swift` 构建为 arm64 macOS 26 的 `bin/desktop`，通过标准输入/输出交换 JSONL；`src/main/desktop-native.js` 提供持续子进程客户端。桥接不接受 shell 命令或任意辅助功能路径。

支持 `permissions`（AX、屏幕录制、事件权限和 macOS 锁屏状态）、`requestPermission`（仅在显式调用时请求系统授权）、`frontmost`（前台进程身份和 CGWindowList 窗口 ID/矩形）、`capture`（主显示器或指定 `windowId` 的 PNG）、`recognize`（对调用方传入的 PNG 做 Vision OCR）、`activate`（按 bundle ID 激活）以及带前台进程和窗口边界校验的 `click`、`move`、`scroll`、`key`、`type`。电脑锁屏时，截图、激活和输入操作都会拒绝执行；`recognize` 只处理请求中提供的 PNG，因此允许锁屏时对合成图像测试。OCR 限制为合法 PNG、最大 8 MiB 和 1600 万像素，返回简体中文/英文候选文字、置信度，以及左上原点的归一化坐标。它不读取辅助功能树，也不调用应用私有 API；对微信的任何处理都只基于显式传入的可见截图。`key` 只接受显式 ANSI 字母/数字、编辑键、方向键和 F1-F12 映射，修饰键名为 `command`、`shift`、`control`、`option`。`type` 默认只接受不含 ASCII 控制字符的单段文本；含 LF/CRLF 的文本必须由调用方显式传 `lineBreak: "shiftEnter"`，原生端会把每个换行计划成 Shift+Return 软换行，不发送裸 Return。Tab、单独 CR、NUL、DEL 等控制字符始终拒绝。每个文本块和软换行事件发出前都会重查锁屏、前台、目标窗口与截止时间。`bin/desktop --self-test-native` 只检查原生矩形解析和键盘输入计划，不创建 CGEvent；涵盖 CGWindowBounds 的 `X/Y/Width/Height` 键、无效矩形、软换行和 surrogate pair 分块。

窗口列表不返回标题或辅助功能元素。每个输入动作必须提供刚读取的 `{bundleId,pid}`、属于该进程的 `windowId`，并为鼠标动作提供窗口内的桌面点坐标。JS 调用方应在每次截图后自行维护截图 revision，检测窗口改变后重新读取前台信息和截图。客户端 `cancel()` 会终止并等待原生进程退出，供全局急停；`close()` 会终止并等待退出并永久关闭客户端。

主进程保持 AppKit 主运行循环活跃，同时在后台读取 JSONL，避免空闲时 NSWorkspace 前台应用通知积压导致读取陈旧前台信息。首次屏幕录制授权由 macOS 隐私设置管理，程序无法绕过。`permissions` 只查询状态；显式调用 `requestPermission` 后，系统可能要求用户在“系统设置 → 隐私与安全性”中允许 workbunny，并重新启动应用。权限被拒绝时，截图和输入接口返回可读错误。

构建：`zsh tools/build-desktop.sh`。协议单测：`node --test tools/test-desktop-native.js`。合成 OCR 集成验证：`node tools/test-desktop-ocr.cjs`（脚本以独立临时用户目录启动 Electron offscreen 并生成 PNG，不截图桌面）。打包集成还需在 `tools/package.sh` 构建并复制 `bin/desktop`，对其签名后再签外层 app；主进程集成应将 `DesktopNative` 放入受信 IPC 处理器中，仅转发固定操作字段，并由调用方按用户授权定义 WorkBuddy 派发验收流程。
