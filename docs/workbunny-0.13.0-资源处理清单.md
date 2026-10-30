# 0.13.0 素材核查、保留与移出清单

核查日：2026-10-30。按“免费发行、源代码公开、尽可能保留有许可的素材”处理。**代码的MIT许可不覆盖第三方素材，非商用和README公示也不替代授权。**

本轮结果：公开包保留四个官方模型、18个有明确许可依据的动作；17个裸文件分发受限的既有动作移出公开源码树和安装包；60个许可待核实动作按用户要求保留在本机个人库并公示。既有92个动作均有完整的本地保留副本，另外补充了同一CC0来源的三个手势；本机个人库可继续使用原动作，公开包只加载自己的18个动作。

## 角色模型

| 中文显示名 | 文件 | 处理与依据 |
| --- | --- | --- |
| 可可 | AvatarSample_D.vrm | 保留随包；内嵌条件允许再分发，并遵循官方AvatarSample条款 |
| 阿雅 | AvatarSample_E.vrm | 同上 |
| 琪琪 | AvatarSample_F.vrm | 同上 |
| 美莉 | AvatarSample_G.vrm | 同上 |
| 婷婷（个人旧模型） | 58.vrm / Maple | 不随包；内嵌元数据为 `Redistribution_Prohibited`。本机原文件保留，用户可自行取得有权使用的VRM后从“外观→导入个人模型”导入 |

依据：[官方AvatarSample使用条件](https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z)、[Maple原作品页](https://booth.pm/ja/items/1948102)。四个官方模型不是CC0，不把它们重新标成MIT或CC0；本项目不提供角色模型收费转售或角色制作服务，不暗示作者背书。角色按钮、悬浮提示采用上述中文名。

## 公开包保留的动作

| 文件 | 中文动作 | 许可 | 来源 |
| --- | --- | --- | --- |
| `idle_pose.vrma` | 待机姿势 | CC0-1.0 | LongbowXXX__ai-tuber |
| `idle_loop.vrma` | 循环待机 | Apache-2.0 | schwarz9791__chatter-agent |
| `work_maid.vrma` | 安静站姿 | CC-BY-4.0 AND MIT | homunculus |
| `work_sit.vrma` | 坐姿待命 | CC-BY-4.0 AND MIT | homunculus |
| `cheer_arms.vrma` | 举双手胜利 | CC0-1.0 | schwarz9791__chatter-agent |
| `tease_punch.vrma` | 伸手戳你 | CC0-1.0 | LongbowXXX__ai-tuber |
| `refuse_fear.vrma` | 慌忙否认 | CC0-1.0 | LongbowXXX__ai-tuber |
| `refuse_no.vrma` | 拒绝手势 | CC0-1.0 | LongbowXXX__ai-tuber |
| `refuse_startle.vrma` | 吓一跳拒绝 | CC0-1.0 | schwarz9791__chatter-agent |
| `angry_stomp.vrma` | 生气跺脚 | CC0-1.0 | schwarz9791__chatter-agent |
| `shy_sway.vrma` | 害羞看你 | CC0-1.0 | schwarz9791__chatter-agent |
| `think_ultra.vrma` | 奥特曼手势 | CC0-1.0 | schwarz9791__chatter-agent |
| `sorry_grab.vrma` | 整个人垂下 | CC-BY-4.0 AND MIT | homunculus |
| `sorry_droop.vrma` | 低头认错 | CC0-1.0 | schwarz9791__chatter-agent |
| `motion_walk.vrma` | 模特步 | CC0-1.0 | schwarz9791__chatter-agent |
| `greet_sachi.vrma` | 轻轻挥手 | CC0-1.0 | LongbowXXX__ai-tuber |
| `praise_sachi.vrma` | 点头赞同 | CC0-1.0 | LongbowXXX__ai-tuber |
| `sign_sachi.vrma` | 胜利手势 | CC0-1.0 | LongbowXXX__ai-tuber |

许可依据：

- Sachi VRMA 1：作者明确声明 [CC0](https://booth.pm/ja/items/6412084)，ai-tuber README明确指向该素材包。本轮共保留/补充七个姿势。
- chatter-agent 七个原创动作：其 [NOTICE](https://github.com/schwarz9791/chatter-agent/blob/e5e5f955e65196833ac2fdbe5a4abaf4a5fb9ac3/chatter-mascot/Assets/StreamingAssets/NOTICE.txt) 明确将该目录生成的动作以CC0发布。
- idle_loop：同一NOTICE明确原作者kazakago及Apache-2.0许可，不以chatter-agent的代码许可推断。
- Homunculus三个动作：[资源包声明](https://github.com/not-elm/desktop-homunculus/blob/30d11a5ad72f97f405117086839acd0ea87e1c49/mods/assets/package.json) 指明MIT AND CC-BY-4.0，根README说明创作资源适用CC-BY-4.0；已附署名、来源、修改说明及完整许可。

对既有资源，下载固定提交的原件，处理Git LFS及JSON/GLB两种容器后核对BIN、节点、访问器、buffer view和动画通道；明确许可的15个既有动作核对一致。新增三姿势仅进行相同的JSON→GLB和规范版本整理，保留原动画。逐文件证据、上游提交与SHA-256见 [机器可读清单](assets-audit.json)。

## 因裸文件分发限制而移出公开发行的动作（17项）

“移出”仅指当前公开源码树和安装包，未销毁本机原件。这些文件与许可未确认的资源分开处理。

| 原本项目文件 | 中文动作 | 来源线索与处理依据 |
| --- | --- | --- |
| `idle_stand.vrma` | 站姿待机一 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`StandingIdle.vrma`） |
| `idle_stand2.vrma` | 站姿待机二 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`StandingIdle01.vrma`） |
| `greet_yeah.vrma` | 起身 yeah | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`greeting.vrma`） |
| `cheer_clap_cipher.vrma` | 鼓掌二 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`clapping.vrma`） |
| `praise_shoot.vrma` | 开枪命中 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`shoot.vrma`） |
| `praise_thumb.vrma` | 坐姿点赞 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`sittingThumbsUp.vrma`） |
| `sign_peace.vrma` | 比耶 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`peace_sign.vrma`） |
| `dance_excited.vrma` | 原地扭动一 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`excited.vrma`） |
| `tease_zombie.vrma` | 学僵尸 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`ZombieNeckBite.vrma`） |
| `tease_headbutt.vrma` | 假装对打 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`headbutt.vrma`） |
| `shy_face.vrma` | 扶脸 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`VRMA_07.vrma`） |
| `tired_sitnap.vrma` | 坐着打瞌睡 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`sittinglaughing.vrma`） |
| `thanks_cipher.vrma` | 感谢臣服 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`thankful.vrma`） |
| `surprise_cipher.vrma` | 惊讶比划 | Cipher Stage的THIRD-PARTY-NOTICES明确该目录来自Mixamo；不公开分发原始动作文件（原文件：`Surprised.vrma`） |
| `pose_model.vrma` | 单手叉腰 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`model_pose.vrma`） |
| `pose_show.vrma` | 展示自己 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`show_full_body.vrma`） |
| `pose_spin.vrma` | 优雅亮相 | 既有记录标为VRoid Motion Pack；按其禁止可提取形式再分发条款处理（原文件：`spin.vrma`） |

依据：[VRoid官方动作包条款](https://booth.pm/ja/items/5512385)、[Cipher Stage素材来源声明](https://github.com/Enigma-EE/Cipher_Stage/blob/cfd7362a8fbaccaf0ad973891cb6399472f261fd/THIRD-PARTY-NOTICES.md)、[Adobe的Mixamo分发说明](https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400?lang=en)。VRoid组的来源记录与官方七类动作相符，但官方原件下载需要登录，本轮没有冒充完成官方原包的字节核验；其余三个同组文件单列为待核实，没有武断认定也适用同一禁止条款。

本项目目前通过“可直接提取的VRMA文件”交付动作，因此不依赖对“封装游戏中嵌入内容”的宽泛解释，也不靠压缩、改扩展名或打包ASAR绕过来源条款。没有为本轮改写任何第三方素材的许可。

## 保留在个人库、公开征求来源线索的动作（60项）

这些资源没有被判定为“确定禁止”。一部分仓库有MIT声明但未明确说明动作版权归属，一部分明确保留第三方素材各自许可，还有一些无许可文件。按用户要求保留本机使用与研究线索；**README公示不构成授权，作者沉默不构成同意**，也不将其混入“许可已确认”安装包。

欢迎原作者、权利人或了解来源的贡献者通过 [素材反馈Issue](https://github.com/zhyuzh3d/workbunny/issues/new?template=asset-rights.md) 提供原始发布页、许可或署名要求，我们将据此补充署名、更正、恢复公开收录、替换或停止收录。无需公开购买凭据或上传受限原件。

| 本项目文件 | 中文动作 | 可追溯仓库/原文件 |
| --- | --- | --- |
| `idle_look.vrma` | 四处张望 | `vrm-viewer / LookAround.vrma` |
| `idle_breath.vrma` | 呼吸待机 | `chuckynuttys__timeline / reika_KA_Idle01_breathing.vrma` |
| `idle_lalala.vrma` | 哼歌撒娇 | `gitphilosopher__MayaVE / idle_lalala.vrma` |
| `idle_shift.vrma` | 换脚站 | `gitphilosopher__MayaVE / weight_shift.vrma` |
| `idle_walk_mocopi.vrma` | 原地走动 | `tfuru__vrma-loader-sample / MCPM_20230806_154241.vrma` |
| `greet_wave.vrma` | 挥手打招呼 | `vroid-project / greeting2.vrma` |
| `greet_turn.vrma` | 转身打招呼 | `vroid-project / hello.vrma` |
| `greet_hand.vrma` | 高举挥手 | `gitphilosopher__MayaVE / hand_raise.vrma` |
| `bye_goodbye.vrma` | 说话式告别 | `vrm-viewer / Goodbye.vrma` |
| `bye_wave.vrma` | 轻轻挥手 | `gitphilosopher__MayaVE / greeting.vrma` |
| `bye_wave_maya.vrma` | 留恋挥手 | `gitphilosopher__MayaVE / wave.vrma` |
| `cheer_clap_vr.vrma` | 鼓掌一 | `vrm-viewer / Clapping.vrma` |
| `cheer_jump_vr.vrma` | 轻松跳 | `vrm-viewer / Jump.vrma` |
| `cheer_hop.vrma` | 高兴地跳 | `chuckynuttys__timeline / reika_KA_Idle06_JumpAround.vrma` |
| `cheer_yay.vrma` | 举双手欢呼 | `chuckynuttys__timeline / reika_KA_Idle36_Yay.vrma` |
| `cheer_clap_maya.vrma` | 鼓掌三 | `gitphilosopher__MayaVE / clapping.vrma` |
| `cheer_cross.vrma` | 来回跳 | `yv-was-taken__desktop-waifu / Cross Jumps.vrma` |
| `cheer_joy.vrma` | 萌妹跳 | `yv-was-taken__desktop-waifu / Joyful Jump.vrma` |
| `praise_snap.vrma` | 响指 | `chuckynuttys__timeline / reika_KA_Idle35_FingerSnap.vrma` |
| `dance_excited_maya.vrma` | 原地扭动二 | `gitphilosopher__MayaVE / excited.vrma` |
| `dance_macarena.vrma` | 尬舞 | `gitphilosopher__MayaVE / macarena_dance.vrma` |
| `tease_cat.vrma` | 小猫扭屁股 | `chuckynuttys__timeline / reika_KA_Idle14_Dance02.vrma` |
| `tease_scare.vrma` | 吓你一跳 | `chuckynuttys__timeline / reika_KA_Idle47_Scaring.vrma` |
| `tease_catwalk.vrma` | 学猫步 | `gitphilosopher__MayaVE / catwalk.vrma` |
| `tease_stand.vrma` | 挑逗站姿 | `yv-was-taken__desktop-waifu / Female Standing Pose.vrma` |
| `tease_peek.vrma` | 藏猫猫 | `yv-was-taken__desktop-waifu / Femme Peek Around Corner.vrma` |
| `refuse_head.vrma` | 摇头否认 | `gitphilosopher__MayaVE / head_shake.vrma` |
| `refuse_reject.vrma` | 夸张失望 | `gitphilosopher__MayaVE / rejected.vrma` |
| `refuse_shrug.vrma` | 摊手无奈 | `gitphilosopher__MayaVE / shrug.vrma` |
| `refuse_waving.vrma` | 挥手拒绝 | `gitphilosopher__MayaVE / waving.vrma` |
| `angry_pout.vrma` | 御姐生气 | `vrm-viewer / Angry.vrma` |
| `angry_tsundere.vrma` | 傲娇不理你 | `chuckynuttys__timeline / reika_KA_Idle37_Tsundere.vrma` |
| `angry_hip.vrma` | 叉腰生气 | `chuckynuttys__timeline / reika_KA_Idle90_HandsOnHipsConfident.vrma` |
| `angry_arms.vrma` | 抱胸跺脚 | `gitphilosopher__MayaVE / angry.vrma` |
| `shy_cute.vrma` | 可爱害羞 | `chuckynuttys__timeline / reika_KA_Idle41_CuteShyPose.vrma` |
| `shy_bashful.vrma` | 腼腆 | `gitphilosopher__MayaVE / bashful.vrma` |
| `think_lady.vrma` | 淑女思考 | `vrm-viewer / Thinking.vrma` |
| `think_idea.vrma` | 灵光一闪 | `chuckynuttys__timeline / reika_KA_Idle08_ComeUpWithAnIdea.vrma` |
| `think_cute.vrma` | 萌妹思考 | `gitphilosopher__MayaVE / cute_think.vrma` |
| `think_dw.vrma` | 傲娇思考 | `yv-was-taken__desktop-waifu / thinking.vrma` |
| `sorry_sad.vrma` | 背手低头 | `vrm-viewer / Sad.vrma` |
| `sorry_cry.vrma` | 哭 | `gitphilosopher__MayaVE / crying.vrma` |
| `sorry_sigh.vrma` | 叹气松懈 | `gitphilosopher__MayaVE / sigh.vrma` |
| `tired_stretch_vr.vrma` | 舒展身体 | `vrm-viewer / Relax.vrma` |
| `tired_sleep.vrma` | 有点困 | `vrm-viewer / Sleepy.vrma` |
| `tired_reach.vrma` | 伸懒腰 | `chuckynuttys__timeline / reika_KA_Idle05_Stretch.vrma` |
| `tired_nod.vrma` | 打瞌睡 | `gitphilosopher__MayaVE / hard_nod.vrma` |
| `tired_yawn.vrma` | 打哈欠 | `gitphilosopher__MayaVE / yawn.vrma` |
| `tired_armstretch.vrma` | 运动前拉伸 | `yv-was-taken__desktop-waifu / Arm Stretching.vrma` |
| `thanks_bow_reika.vrma` | 鞠躬拜托 | `chuckynuttys__timeline / reika_KA_Idle44_GreetingBow.vrma` |
| `thanks_maya.vrma` | 衷心感谢 | `gitphilosopher__MayaVE / thankful.vrma` |
| `surprise_scratch.vrma` | 抓抓头 | `vrm-viewer / Blush.vrma` |
| `surprise_vr.vrma` | 小惊喜退避 | `vrm-viewer / Surprised.vrma` |
| `motion_cute.vrma` | 扮可爱 | `vroid-project / motion_pose.vrma` |
| `motion_spinjump.vrma` | 冲过来转圈 | `chuckynuttys__timeline / reika_KA_Idle07_SpinningJump.vrma` |
| `motion_run.vrma` | 原地跑 | `yv-was-taken__desktop-waifu / Running.vrma` |
| `motion_situp2.vrma` | 起坐起身 | `yv-was-taken__desktop-waifu / Situp To Idle.vrma` |
| `motion_situp.vrma` | 仰卧起坐 | `yv-was-taken__desktop-waifu / Situps.vrma` |
| `motion_spin.vrma` | 转圈 | `yv-was-taken__desktop-waifu / Spinning.vrma` |
| `talk_talk.vrma` | 说话带手势 | `yv-was-taken__desktop-waifu / talking.vrma` |

其中，VRM Viewer的仓库有MIT许可，但README要求使用者确认模型/动作权利；MayaVE README明确第三方动画遵循其自身许可；Reika/timeline与mocopi样例缺少足够清晰的素材许可。未把“能在GitHub下载”当作原作者已授权再分发。

## 本地保存和公开构建

个人资源位于用户应用数据目录的 `avatars/` 和 `motions/`，与安装包及数据库分开；不进入导出设置、记忆备份或公开发行包。设置“外观”可导入自包含的VRM，拒绝链接文件及依赖外部文件的模型；重名保留旧文件，使用摘要后缀区分，导入后会即时出现在角色列表。应用升级不会覆盖该个人目录。

`tools/package.sh` 正常公开构建只复制许可清单中允许的资源，并核验散列；个人库、未知素材和婷婷都不会被复制。运行时只向模型和动作面板公布确实能加载的动作，减少动作后不会留下可点击的失效按钮，并始终要求至少一个可用空闲动作。

当前源码树已去掉受限/未核实的素材字节，但历史Git提交可能仍含旧文件。本轮不擅自重写已有历史；对外提供无 `.git`、无个人文件的干净源码快照。以后若清理公开Git历史，应单独备份和制定迁移流程，不能把本次文件移出误称为历史已清除。
