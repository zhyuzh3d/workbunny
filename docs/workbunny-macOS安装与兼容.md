# workbunny 的 Mac 安装与兼容

适用于 v0.3.0。当前安装包面向 **Apple Silicon、macOS 26 或以上**，使用系统 SpeechAnalyzer / SpeechTranscriber 持续识别语音。最低系统版本已同时写入应用声明和原生识别程序编译目标，避免在旧系统上显示可安装却无法识别。

支持范围按识别能力确定，不按机器购买年限推测。升级到 macOS 26 的 M1 MacBook Air、M1 MacBook Pro、M1 Mac mini（2020）已处于这一范围；不包含 Intel 安装包。依据：[Apple 兼容机型](https://support.apple.com/en-euro/122867)、[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)。

## 安装

1. 解压 `workbunny-0.3.0-macos26-arm64.zip`，将 `workbunny.app` 放入本机“应用程序”或 `~/Applications`。
2. 安装并打开 WorkBuddy，登录自己的账号。workbunny 默认通过 WorkBuddy 的本机授权通道使用账号模型，不要求复制登录 token。
3. 打开 workbunny，按 macOS 提示允许麦克风；中文识别资源未安装时会自动准备，期间显示准备状态。
4. 在“设置—听力”检查监听。输入设备使用系统默认；需要换麦克风时在 macOS 声音设置选择输入设备。
5. 可先使用系统语音。需要本地 Qwen 时在“设置—语音”下载模型；需要局域网 CHP 时填写自己的地址和密钥，获取模型与音色，再保存或试听。
6. 迁移陪伴资料时，从旧机的“记忆与关系”导出加密备份，再在新机输入备份密码恢复。不要仅复制 Keychain 封装的钥匙文件；API 密钥和各机权限分别配置。
7. 需要桌面任务时打开“桌面任务—请求权限”，在 macOS 允许辅助功能和屏幕录制。它们与麦克风是独立权限，首次需要系统授权；未解锁或未授权时不会操作桌面。

当前是固定开发证书签名的测试包，尚未进行 Developer ID 签名与 Apple 公证。在其他 Mac 首次打开可能需要通过系统的“隐私与安全性”确认。麦克风和局域网授权属于每台 Mac，不能随安装包继承。后续正式公开发布前还需完成 Developer ID 签名、公证及独立机器验收。

## 数据与工作协作

- 配置、记忆资料库、本地模型在当前用户的 `~/Library/Application Support/workbunny`。记忆正文与索引采用本机密钥保护，跨机使用带独立密码的加密备份。安装包不包含开发者的配置、API 密钥、WorkBuddy 授权票据、历史或下载的模型权重。
- 配置采用私有文件权限与原子替换，写入失败保留旧文件和当前有效配置；设置窗口只保存用户编辑过的参数，避免其他标签的旧值覆盖正在使用的设置。
- WorkBuddy 任务监听默认使用当前用户的 `~/.workbuddy/projects`；按新机器的真实目录扫描，不依赖开发机器的用户名。
- WorkBuddy 通过应用标识唤起，不固定安装路径；未安装、未登录或本地授权接口不可用时给出明确错误。该通道依赖 WorkBuddy 客户端接口，升级后仍需做兼容检查。
- 应用已包含 arm64 原生识别、SQLite 资料库、截图/键鼠/OCR 辅助程序和本地 TTS 引擎；运行时不要求安装 Node、Python、Homebrew 或 Xcode。下载模型与准备系统语音资源仍需要网络。

## 验证边界

已在 M2、macOS 26.5.1 上验证正式应用启动、真实音频输入、监听开关恢复、WorkBuddy Hy3 账号调用、设置保存与恢复；原生程序动态依赖均来自系统库及框架。尚未在第二台实体 Mac 上验收，因此本包可用于跨机试装，不代表已经完成所有机型的兼容认证。

0.3.0 新增加密记忆与界面已在正式安装路径检查；桌面实操仍待解锁、首次权限及真实应用验收，见[本批交付说明](workbunny-0.3.0-陪伴与行动基础.md)。
