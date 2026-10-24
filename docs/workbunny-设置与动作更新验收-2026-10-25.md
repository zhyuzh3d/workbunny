# workbunny v0.2.14 更新与验收

## 名称与数据

应用名、包名、可执行文件、窗口标题、托盘、签名证书、开发和安装脚本、文档内容及文件名统一为 workbunny。

- 安装位置：`~/Applications/workbunny.app`
- 标识：`cn.haminn.workbunny`
- 数据目录：`~/Library/Application Support/workbunny`
- 签名：`workbunny Dev`，后续更新沿用同一证书。

已迁移当前用户配置、历史数据、模型和音色文件，修正配置中的模型绝对路径。迁移前后 3 个 GGUF 文件的大小与修改时间一致，未重新下载。旧安装已退出并移出应用目录；迁移前版本和配置保存在私有备份目录。

## 模型与语音设置

智力提供 WorkBuddy、DeepSeek 官方、Grok 官方；移除 NVIDIA 选项，保留已有磁盘数据。DeepSeek、Grok 的获取按钮位于模型列表上方，WorkBuddy 位于下方，可获取当前账号列表，失败保留上次列表。服务商各自保存密钥、模型和思考选择；选择保存后进入实际调用，修复了 WorkBuddy 原先固定使用 Hy3 的问题。

思考等级优先读取模型元数据：WorkBuddy 的 `reasoning.supportedEfforts`、DeepSeek 的 `effort.supported_levels`、Grok 的 `capabilities.reasoning_effort`。不支持的参数不发送；未知模型使用模型默认。Grok 多代理模型的相应选项显示代理数量。

参考：[DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[Grok 模型列表](https://docs.x.ai/developers/rest-api-reference/inference/models)、[Grok 多代理参数](https://docs.x.ai/developers/model-capabilities/text/multi-agent)。WorkBuddy 列表通过已登录应用的本地授权通道读取；它依赖当前客户端接口，后续升级需留意兼容性。

语音中的远程入口改为“局域网 CHP”，使用信息文档发现 TTS 能力、输出格式、模型和音色。地址或密钥改变后清空旧菜单，重新获取；选择音色立即生效。失败沿用既有系统语音回退，并同步引擎选中状态。

本机连接为 `http://192.168.124.31:8189`。实际返回 CHP 3.2.0、Qwen3-TTS 0.6B CustomVoice、12 个音色。当前 CHP 协议只播报服务端已加载的模型，不支持请求中切换模型，因此模型栏展示真实服务模型，不提供无效切换。访问密钥由主进程保存，信息请求用 Bearer，合成请求放在 `chp_params.password`，不写入 URL 或日志。

协议依据：[haminn-chp 102364862d2ba0be8b10ac8a89504c4aaefa6975](https://github.com/zhyuzh3d/haminn-chp/tree/102364862d2ba0be8b10ac8a89504c4aaefa6975)。只匹配 `txt-2-sph/v1`，当前接收 24 kHz、单声道、16 位 PCM WAV。CHP 本次采用整句 WAV；本地 Qwen 的既有流式播放继续保留。

连接故障定位到本机网络权限：命令行可连接，但应用报网络不可达。修正复制 Electron 时重复的主程序 UUID，并通过系统设置刷新本应用的已有局域网许可后，正式应用连接成功。未修改系统权限数据库。依据：[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。

## 动作面板与播放规则

- 按实际调用的 20 个分类分组，可展开查看，移除搜索。
- 默认全部勾选。取消勾选立即保存，同时禁止预览和自动播放该动作。
- 最后一个空闲动作不可取消；主进程保存接口也验证这一约束。
- 空动作、未知动作、禁用动作和没有可用成员的分类，均使用已启用的随机空闲动作。
- 当前动作被禁用时切回允许的空闲动作；模型提示词不再列出已禁用全部成员的分类。
- “全部启用”恢复完整动作列表。

运行时在唯一的 `playMotion` 入口再次校验，覆盖对话、任务事件、待机轮换和手动预览，避免只在列表中隐藏动作。

## 显示与交互

保留现有 MSAA，为透明裁剪材质启用 Alpha-to-Coverage，改善发丝等纹理边缘，不增加全屏后处理或渲染分辨率。正式应用日志确认 MSAA 4x、16 个裁剪材质启用；当前屏幕 DPR 为 1。未做截图对比，具体观感仍需用户查看。

监听圆点是独立开关，不会误触文字输入；状态、提示与实际监听开关同步。设置标签改为“听力”“智力”和“语音”，“100% 半身”保留原取景方式；缩放保持窗口底部中心锚点，屏幕上方空间不足时限制窗口高度。移除额外焦点描边，保留选中颜色与正常边框。

## 验收证据与边界

- 语音调度、模型列表、CHP 协议、音频、动作策略等回归检查通过；动作界面检查涵盖默认全选、20 类分组、最后空闲保护、禁用预览和恢复全选。
- 正式安装版本：0.2.14；92 个动作加载，角色启动无错误，语音识别与麦克风授权正常。
- 正式应用获取 WorkBuddy 32 个对话模型；当前账号 Hy3 实际返回“连接成功”，本次消耗 0 额度。
- 正式应用获取 CHP 12 个音色，Serena 试听成功，合成约 2.08 秒，170844 字节，音频已交给角色窗口播放。
- 正式应用临时仅保留一个空闲动作，空分类与空动作均回到该动作；验证后恢复原来的用户勾选状态。
- DeepSeek、Grok 按官方协议和响应样本验证；本机未配置两家的有效 API Key，未声称完成真实账号调用。

0.2.14 在上述协议和播放实测基础上更新“智力”标签及各服务商按钮位置；对应界面流程检查通过。
