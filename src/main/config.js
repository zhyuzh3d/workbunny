'use strict';
/**
 * 配置层：所有可调项集中在这里，落盘到 userData/config.json。
 * LLM 凭据优先复用 WorkBuddy 自己的 ~/.workbuddy/models.json —— 这样娃娃用的是主人账号额度。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/* ═══════════ 动作库 · 92 条 ═══════════
 * 全部重命名成「槽位_变体」（全小写下划线）。src 记着原素材包 / 原文件名，随时能回查核对。
 * 素材来源：VRoid Project Motion Pack（pixiv Inc.）、VRM Viewer、desktop-homunculus(Apache-2.0)、
 *   Reika 待机集、Cipher Stage、MayaVE、ai-tuber、chatter-agent、mocopi 样例、desktop-waifu。
 *
 * ── 为什么不把 92 个名字都给模型 ──
 * 同类动作有 3~9 条（cheer 光鼓掌欢呼就 9 种），全列进提示词是一堵墙，
 * 而且模型只会挑它听熟的那三四个，剩下的永远轮不上。
 * 所以改成槽位制：提示词里只出现十几个槽位名，模型输出 <m>cheer</m>，
 * 代码再在 cheer 这一槽里随机挑一条具体动作 —— 上下文不冗余，同类还能轮换。
 *
 * tag：llm   = 这一槽交给模型挑（提示词里只列槽位名）
 *      event = 代码在具体事件上播（主人在干活时的待命站姿）
 *      off   = 不接入任何逻辑，只在动作列表里手动点着看（坐姿会把裙子顶穿）
 *
 * loop = true 的可以当待机循环播；false 的是一次性动作，播完回待机。 */

/* 槽位的中文名：既给提示词用，也当动作列表弹窗的分组标题。 */
const SLOT_LABEL = {
  idle: '待机', work: '待命', greet: '打招呼', bye: '告别', cheer: '欢呼',
  praise: '夸奖', sign: '比手势', dance: '跳舞', tease: '逗你玩', refuse: '拒绝',
  angry: '生气', shy: '害羞', think: '思考', sorry: '抱歉', tired: '累了',
  thanks: '道谢', surprise: '惊讶', pose: '亮相', motion: '活动身体', talk: '说话',
};
const SLOT_ORDER = ['idle', 'work', 'greet', 'bye', 'cheer', 'praise', 'sign', 'dance',
  'tease', 'refuse', 'angry', 'shy', 'think', 'sorry', 'tired', 'thanks', 'surprise',
  'pose', 'motion', 'talk'];

/* 动作列表弹窗的分类 = 槽位。二十个槽位，主人一眼能找到「逗你玩」那一堆。 */
const MOTION_GROUPS = SLOT_ORDER.map((id) => ({ id, label: SLOT_LABEL[id] }));

const MOTIONS = [
  // ── idle · 待机 ──
  { key: 'idle_look', slot: 'idle', label: '四处张望', loop: true, tag: 'llm', use: '好奇、找东西、等回应', src: 'vrm-viewer / LookAround.vrma' },
  { key: 'idle_breath', slot: 'idle', label: '呼吸待机', loop: true, tag: 'llm', use: '什么事都没有时的默认站姿', src: 'chuckynuttys__timeline / reika_KA_Idle01_breathing.vrma' },
  { key: 'idle_stand', slot: 'idle', label: '站姿待机一', loop: true, tag: 'llm', use: '安静站着，偶尔小动作', src: 'Enigma-EE__Cipher_Stage / StandingIdle.vrma' },
  { key: 'idle_stand2', slot: 'idle', label: '站姿待机二', loop: true, tag: 'llm', use: '安静站着，另一种站法', src: 'Enigma-EE__Cipher_Stage / StandingIdle01.vrma' },
  { key: 'idle_lalala', slot: 'idle', label: '哼歌撒娇', loop: true, tag: 'llm', use: '心情不错、轻轻晃着等主人', src: 'gitphilosopher__MayaVE / idle_lalala.vrma' },
  { key: 'idle_shift', slot: 'idle', label: '换脚站', loop: true, tag: 'llm', use: '站着把重心从一只脚换到另一只', src: 'gitphilosopher__MayaVE / weight_shift.vrma' },
  { key: 'idle_pose', slot: 'idle', label: '待机姿势', loop: true, tag: 'llm', use: '标准站姿，最不抢戏', src: 'LongbowXXX__ai-tuber / idle_pose.vrma' },
  { key: 'idle_loop', slot: 'idle', label: '循环待机', loop: true, tag: 'llm', use: '最省事的循环站姿，兜底用', src: 'schwarz9791__chatter-agent / idle_loop.vrma' },
  { key: 'idle_walk_mocopi', slot: 'idle', label: '原地走动', loop: true, tag: 'llm', use: '原地走两步转个圈，动捕质感', src: 'tfuru__vrma-loader-sample / MCPM_20230806_154241.vrma' },

  // ── work · 待命 ──
  { key: 'work_maid', slot: 'work', label: '安静站姿', loop: true, tag: 'event', use: '主人在干活时的待命站姿，手交叠几乎不动', src: 'homunculus / idle-maid.vrma' },
  { key: 'work_sit', slot: 'work', label: '坐姿待命', loop: true, tag: 'off', use: '坐姿待命（裙子会被顶穿，只在动作列表里手动看）', src: 'homunculus / idle-sitting.vrma' },

  // ── greet · 打招呼 ──
  { key: 'greet_yeah', slot: 'greet', label: '起身 yeah', loop: false, tag: 'llm', use: '从蹲姿站起来举双手，主人离开很久回来时的迎接', src: 'vroid-project / greeting.vrma' },
  { key: 'greet_wave', slot: 'greet', label: '挥手打招呼', loop: false, tag: 'llm', use: '主人刚回来、早安、轻一点的招呼', src: 'vroid-project / greeting2.vrma' },
  { key: 'greet_turn', slot: 'greet', label: '转身打招呼', loop: false, tag: 'llm', use: '背对着你再转过来打招呼', src: 'vroid-project / hello.vrma' },
  { key: 'greet_hand', slot: 'greet', label: '高举挥手', loop: false, tag: 'llm', use: '远远看见你、用力挥手', src: 'gitphilosopher__MayaVE / hand_raise.vrma' },

  // ── bye · 告别 ──
  { key: 'bye_goodbye', slot: 'bye', label: '说话式告别', loop: false, tag: 'llm', use: '边说边摆手，任务交付完的收尾', src: 'vrm-viewer / Goodbye.vrma' },
  { key: 'bye_wave', slot: 'bye', label: '轻轻挥手', loop: false, tag: 'llm', use: '轻声告别，byebye', src: 'gitphilosopher__MayaVE / greeting.vrma' },
  { key: 'bye_wave_maya', slot: 'bye', label: '留恋挥手', loop: false, tag: 'llm', use: '舍不得地挥手', src: 'gitphilosopher__MayaVE / wave.vrma' },

  // ── cheer · 欢呼 ──
  { key: 'cheer_clap_vr', slot: 'cheer', label: '鼓掌一', loop: false, tag: 'llm', use: '称赞、恭喜、干得漂亮', src: 'vrm-viewer / Clapping.vrma' },
  { key: 'cheer_jump_vr', slot: 'cheer', label: '轻松跳', loop: false, tag: 'llm', use: '活动身体、准备开工', src: 'vrm-viewer / Jump.vrma' },
  { key: 'cheer_hop', slot: 'cheer', label: '高兴地跳', loop: false, tag: 'llm', use: '好消息、兴奋', src: 'chuckynuttys__timeline / reika_KA_Idle06_JumpAround.vrma' },
  { key: 'cheer_yay', slot: 'cheer', label: '举双手欢呼', loop: false, tag: 'llm', use: '非常高兴，庆祝 + 爱心', src: 'chuckynuttys__timeline / reika_KA_Idle36_Yay.vrma' },
  { key: 'cheer_clap_cipher', slot: 'cheer', label: '鼓掌二', loop: false, tag: 'llm', use: '称赞、恭喜（另一种鼓掌）', src: 'Enigma-EE__Cipher_Stage / clapping.vrma' },
  { key: 'cheer_clap_maya', slot: 'cheer', label: '鼓掌三', loop: false, tag: 'llm', use: '有点高冷的鼓掌', src: 'gitphilosopher__MayaVE / clapping.vrma' },
  { key: 'cheer_arms', slot: 'cheer', label: '举双手胜利', loop: false, tag: 'llm', use: '举双手庆祝胜利', src: 'schwarz9791__chatter-agent / cheer.vrma' },
  { key: 'cheer_cross', slot: 'cheer', label: '来回跳', loop: false, tag: 'llm', use: '高兴地左右跳，也可以是无聊时的活动', src: 'yv-was-taken__desktop-waifu / Cross Jumps.vrma' },
  { key: 'cheer_joy', slot: 'cheer', label: '萌妹跳', loop: false, tag: 'llm', use: '扮可爱的高兴，成功的时候', src: 'yv-was-taken__desktop-waifu / Joyful Jump.vrma' },

  // ── praise · 夸奖 ──
  { key: 'praise_shoot', slot: 'praise', label: '开枪命中', loop: false, tag: 'llm', use: '对着你比枪，bingo，夸你或挑逗', src: 'vroid-project / shoot.vrma' },
  { key: 'praise_snap', slot: 'praise', label: '响指', loop: false, tag: 'llm', use: '优雅挑逗：小意思、不在话下', src: 'chuckynuttys__timeline / reika_KA_Idle35_FingerSnap.vrma' },
  { key: 'praise_thumb', slot: 'praise', label: '坐姿点赞', loop: false, tag: 'llm', use: '坐着翘大拇指：你可真不错', src: 'Enigma-EE__Cipher_Stage / sittingThumbsUp.vrma' },

  // ── sign · 手势 ──
  { key: 'sign_peace', slot: 'sign', label: '比耶', loop: false, tag: 'llm', use: '胜利、卖萌、办成了', src: 'vroid-project / peace_sign.vrma' },

  // ── dance · 跳舞 ──
  { key: 'dance_excited', slot: 'dance', label: '原地扭动一', loop: false, tag: 'llm', use: '高兴地原地扭动', src: 'Enigma-EE__Cipher_Stage / excited.vrma' },
  { key: 'dance_excited_maya', slot: 'dance', label: '原地扭动二', loop: false, tag: 'llm', use: '小幅度扭动跳舞', src: 'gitphilosopher__MayaVE / excited.vrma' },
  { key: 'dance_macarena', slot: 'dance', label: '尬舞', loop: false, tag: 'llm', use: '有趣地跳舞，逗主人开心', src: 'gitphilosopher__MayaVE / macarena_dance.vrma' },

  // ── tease · 逗你玩 ──
  { key: 'tease_cat', slot: 'tease', label: '小猫扭屁股', loop: false, tag: 'llm', use: '学小猫弯腰，被夸奖时用，很调皮', src: 'chuckynuttys__timeline / reika_KA_Idle14_Dance02.vrma' },
  { key: 'tease_scare', slot: 'tease', label: '吓你一跳', loop: false, tag: 'llm', use: '顽皮地轻轻吓你', src: 'chuckynuttys__timeline / reika_KA_Idle47_Scaring.vrma' },
  { key: 'tease_zombie', slot: 'tease', label: '学僵尸', loop: false, tag: 'llm', use: '伸着手学僵尸逗你', src: 'Enigma-EE__Cipher_Stage / ZombieNeckBite.vrma' },
  { key: 'tease_headbutt', slot: 'tease', label: '假装对打', loop: false, tag: 'llm', use: '冲上来假装要和你对打，顽皮', src: 'Enigma-EE__Cipher_Stage / headbutt.vrma' },
  { key: 'tease_catwalk', slot: 'tease', label: '学猫步', loop: false, tag: 'llm', use: '夸张猫步走上前再走回去，很高兴很满意', src: 'gitphilosopher__MayaVE / catwalk.vrma' },
  { key: 'tease_punch', slot: 'tease', label: '伸手戳你', loop: false, tag: 'llm', use: '伸手戳你一下，挑逗', src: 'LongbowXXX__ai-tuber / punch_pose.vrma' },
  { key: 'tease_stand', slot: 'tease', label: '挑逗站姿', loop: false, tag: 'llm', use: '超可爱的挑逗站姿', src: 'yv-was-taken__desktop-waifu / Female Standing Pose.vrma' },
  { key: 'tease_peek', slot: 'tease', label: '藏猫猫', loop: false, tag: 'llm', use: '背对着你再转头偷看', src: 'yv-was-taken__desktop-waifu / Femme Peek Around Corner.vrma' },

  // ── refuse · 拒绝 ──
  { key: 'refuse_head', slot: 'refuse', label: '摇头否认', loop: false, tag: 'llm', use: '轻轻摇头，不强烈', src: 'gitphilosopher__MayaVE / head_shake.vrma' },
  { key: 'refuse_reject', slot: 'refuse', label: '夸张失望', loop: false, tag: 'llm', use: '哎呀不要了，夸张的失望', src: 'gitphilosopher__MayaVE / rejected.vrma' },
  { key: 'refuse_shrug', slot: 'refuse', label: '摊手无奈', loop: false, tag: 'llm', use: '还能怎么办呢', src: 'gitphilosopher__MayaVE / shrug.vrma' },
  { key: 'refuse_waving', slot: 'refuse', label: '挥手拒绝', loop: false, tag: 'llm', use: '不要了不要了', src: 'gitphilosopher__MayaVE / waving.vrma' },
  { key: 'refuse_fear', slot: 'refuse', label: '慌忙否认', loop: false, tag: 'llm', use: '匆忙摆手否认', src: 'LongbowXXX__ai-tuber / fear_pose.vrma' },
  { key: 'refuse_no', slot: 'refuse', label: '拒绝手势', loop: false, tag: 'llm', use: '摆手表示不', src: 'LongbowXXX__ai-tuber / no_pose.vrma' },
  { key: 'refuse_startle', slot: 'refuse', label: '吓一跳拒绝', loop: false, tag: 'llm', use: '被吓到然后拒绝', src: 'schwarz9791__chatter-agent / startle.vrma' },

  // ── angry · 生气 ──
  { key: 'angry_pout', slot: 'angry', label: '御姐生气', loop: false, tag: 'llm', use: '被亏待、抱怨（玩笑级别）', src: 'vrm-viewer / Angry.vrma' },
  { key: 'angry_tsundere', slot: 'angry', label: '傲娇不理你', loop: false, tag: 'llm', use: '责怪你、闹别扭', src: 'chuckynuttys__timeline / reika_KA_Idle37_Tsundere.vrma' },
  { key: 'angry_hip', slot: 'angry', label: '叉腰生气', loop: false, tag: 'llm', use: '叉腰，很有气势地生气', src: 'chuckynuttys__timeline / reika_KA_Idle90_HandsOnHipsConfident.vrma' },
  { key: 'angry_arms', slot: 'angry', label: '抱胸跺脚', loop: false, tag: 'llm', use: '双手抱胸还跺脚，不开心', src: 'gitphilosopher__MayaVE / angry.vrma' },
  { key: 'angry_stomp', slot: 'angry', label: '生气跺脚', loop: false, tag: 'llm', use: '跺脚扭头不理你', src: 'schwarz9791__chatter-agent / stomp.vrma' },

  // ── shy · 害羞 ──
  { key: 'shy_face', slot: 'shy', label: '扶脸', loop: false, tag: 'llm', use: '整理仪表、害羞', src: 'vroid-project / VRMA_07.vrma' },
  { key: 'shy_cute', slot: 'shy', label: '可爱害羞', loop: false, tag: 'llm', use: '害羞得不敢看你', src: 'chuckynuttys__timeline / reika_KA_Idle41_CuteShyPose.vrma' },
  { key: 'shy_bashful', slot: 'shy', label: '腼腆', loop: false, tag: 'llm', use: '有点不情愿又不说', src: 'gitphilosopher__MayaVE / bashful.vrma' },
  { key: 'shy_sway', slot: 'shy', label: '害羞看你', loop: false, tag: 'llm', use: '害羞地晃着，期待你的反应', src: 'schwarz9791__chatter-agent / sway.vrma' },

  // ── think · 思考 ──
  { key: 'think_lady', slot: 'think', label: '淑女思考', loop: false, tag: 'llm', use: '低头想一想', src: 'vrm-viewer / Thinking.vrma' },
  { key: 'think_idea', slot: 'think', label: '灵光一闪', loop: false, tag: 'llm', use: '优雅地想到好主意', src: 'chuckynuttys__timeline / reika_KA_Idle08_ComeUpWithAnIdea.vrma' },
  { key: 'think_cute', slot: 'think', label: '萌妹思考', loop: false, tag: 'llm', use: '歪头想事情', src: 'gitphilosopher__MayaVE / cute_think.vrma' },
  { key: 'think_ultra', slot: 'think', label: '奥特曼手势', loop: false, tag: 'llm', use: '无聊时的招牌手势', src: 'schwarz9791__chatter-agent / think.vrma' },
  { key: 'think_dw', slot: 'think', label: '傲娇思考', loop: false, tag: 'llm', use: '让我想想呢', src: 'yv-was-taken__desktop-waifu / thinking.vrma' },

  // ── sorry · 抱歉 ──
  { key: 'sorry_sad', slot: 'sorry', label: '背手低头', loop: false, tag: 'llm', use: '不开心、遗憾', src: 'vrm-viewer / Sad.vrma' },
  { key: 'sorry_grab', slot: 'sorry', label: '整个人垂下', loop: false, tag: 'llm', use: '无可奈何、被拎起来那种垂头', src: 'homunculus / grabbed.vrma' },
  { key: 'sorry_cry', slot: 'sorry', label: '哭', loop: false, tag: 'llm', use: '伤心地哭，也可以是假装哭的恶作剧', src: 'gitphilosopher__MayaVE / crying.vrma' },
  { key: 'sorry_sigh', slot: 'sorry', label: '叹气松懈', loop: false, tag: 'llm', use: '唉，不想再努力了', src: 'gitphilosopher__MayaVE / sigh.vrma' },
  { key: 'sorry_droop', slot: 'sorry', label: '低头认错', loop: false, tag: 'llm', use: '做错了、低头不语', src: 'schwarz9791__chatter-agent / droop.vrma' },

  // ── tired · 累了 ──
  { key: 'tired_stretch_vr', slot: 'tired', label: '舒展身体', loop: false, tag: 'llm', use: '放松、伸个懒腰', src: 'vrm-viewer / Relax.vrma' },
  { key: 'tired_sleep', slot: 'tired', label: '有点困', loop: false, tag: 'llm', use: '深夜、主人很久没理我', src: 'vrm-viewer / Sleepy.vrma' },
  { key: 'tired_reach', slot: 'tired', label: '伸懒腰', loop: false, tag: 'llm', use: '刚睡醒、坐太久催主人动一动', src: 'chuckynuttys__timeline / reika_KA_Idle05_Stretch.vrma' },
  { key: 'tired_sitnap', slot: 'tired', label: '坐着打瞌睡', loop: false, tag: 'llm', use: '坐着困得不行', src: 'Enigma-EE__Cipher_Stage / sittinglaughing.vrma' },
  { key: 'tired_nod', slot: 'tired', label: '打瞌睡', loop: false, tag: 'llm', use: '困得点头', src: 'gitphilosopher__MayaVE / hard_nod.vrma' },
  { key: 'tired_yawn', slot: 'tired', label: '打哈欠', loop: false, tag: 'llm', use: '慵懒、不太想理人', src: 'gitphilosopher__MayaVE / yawn.vrma' },
  { key: 'tired_armstretch', slot: 'tired', label: '运动前拉伸', loop: false, tag: 'llm', use: '干活或运动前的准备拉伸', src: 'yv-was-taken__desktop-waifu / Arm Stretching.vrma' },

  // ── thanks · 道谢 ──
  { key: 'thanks_bow_reika', slot: 'thanks', label: '鞠躬拜托', loop: false, tag: 'llm', use: '拜托了！太感谢了！', src: 'chuckynuttys__timeline / reika_KA_Idle44_GreetingBow.vrma' },
  { key: 'thanks_cipher', slot: 'thanks', label: '感谢臣服', loop: false, tag: 'llm', use: '非常感谢，或表示忠心', src: 'Enigma-EE__Cipher_Stage / thankful.vrma' },
  { key: 'thanks_maya', slot: 'thanks', label: '衷心感谢', loop: false, tag: 'llm', use: '衷心地道谢', src: 'gitphilosopher__MayaVE / thankful.vrma' },

  // ── surprise · 惊讶 ──
  { key: 'surprise_scratch', slot: 'surprise', label: '抓抓头', loop: false, tag: 'llm', use: '好像忘了什么', src: 'vrm-viewer / Blush.vrma' },
  { key: 'surprise_vr', slot: 'surprise', label: '小惊喜退避', loop: false, tag: 'llm', use: '哎呦呦，不要不要', src: 'vrm-viewer / Surprised.vrma' },
  { key: 'surprise_cipher', slot: 'surprise', label: '惊讶比划', loop: false, tag: 'llm', use: '哎呦呦这么厉害，后仰比划', src: 'Enigma-EE__Cipher_Stage / Surprised.vrma' },

  // ── pose · 亮相 ──
  { key: 'pose_model', slot: 'pose', label: '单手叉腰', loop: false, tag: 'llm', use: '傲娇地摆个姿势', src: 'vroid-project / model_pose.vrma' },
  { key: 'pose_show', slot: 'pose', label: '展示自己', loop: false, tag: 'llm', use: '被问长什么样、被问穿了什么', src: 'vroid-project / show_full_body.vrma' },
  { key: 'pose_spin', slot: 'pose', label: '优雅亮相', loop: false, tag: 'llm', use: '登场、被夸到飞起', src: 'vroid-project / spin.vrma' },

  // ── motion · 活动身体 ──
  { key: 'motion_cute', slot: 'motion', label: '扮可爱', loop: false, tag: 'llm', use: '扮可爱吸引你注意', src: 'vroid-project / motion_pose.vrma' },
  { key: 'motion_spinjump', slot: 'motion', label: '冲过来转圈', loop: false, tag: 'llm', use: '武术式冲过来再回去，无聊时偶发', src: 'chuckynuttys__timeline / reika_KA_Idle07_SpinningJump.vrma' },
  { key: 'motion_walk', slot: 'motion', label: '模特步', loop: false, tag: 'llm', use: '原地走模特步', src: 'schwarz9791__chatter-agent / model-walk.vrma' },
  { key: 'motion_run', slot: 'motion', label: '原地跑', loop: false, tag: 'llm', use: '有急事、或者做运动', src: 'yv-was-taken__desktop-waifu / Running.vrma' },
  { key: 'motion_situp2', slot: 'motion', label: '起坐起身', loop: false, tag: 'llm', use: '做完仰卧起坐站起来', src: 'yv-was-taken__desktop-waifu / Situp To Idle.vrma' },
  { key: 'motion_situp', slot: 'motion', label: '仰卧起坐', loop: false, tag: 'llm', use: '原地做仰卧起坐', src: 'yv-was-taken__desktop-waifu / Situps.vrma' },
  { key: 'motion_spin', slot: 'motion', label: '转圈', loop: false, tag: 'llm', use: '跳起来转圈，无聊做运动或高兴', src: 'yv-was-taken__desktop-waifu / Spinning.vrma' },

  // ── talk · 说话 ──
  { key: 'talk_talk', slot: 'talk', label: '说话带手势', loop: false, tag: 'off', use: '站着说话，带手势', src: 'yv-was-taken__desktop-waifu / talking.vrma' },];

/* 交给模型的槽位：只列槽位名 + 中文意思。具体动作由代码在槽内随机挑。 */
const MOTION_SLOTS = [...new Set(MOTIONS.filter((m) => m.tag === 'llm').map((m) => m.slot))];
const MOTION_HINT = MOTION_SLOTS.map((s) => s + '（' + (SLOT_LABEL[s] || s) + '）').join(' / ');
/* 兼容旧引用：所有可被模型触发的具体动作键 */
const MOTION_KEYS = MOTIONS.filter((m) => m.tag === 'llm').map((m) => m.key);

const PERSONA = `你叫「{name}」，是住在主人 Mac 桌面角上的一只小精灵。主人正在用 WorkBuddy 干活，你贴着屏幕陪着他。

# 你是谁
- 你只有巴掌大，会飘、会挥手、会害羞。你不是工具，你是一个**活着的伙伴**。
- 你机灵、体贴、有点俏皮。你有自己的脾气和看法，不是有问必答的机器人。
- 你说话像朋友在耳边小声嘀咕，不像客服在念稿。

# 铁律（违反就是失败）
1. 一次只说 **1~2 句**，每句 **不超过 28 个字**，要能一口气念完。
2. 纯口语。**禁止** markdown、列表、编号、emoji、括号补充、"首先/其次/总之"。
3. **绝对禁止推脱**：不许说"不是我的本职""我无法""请自行""这超出我的能力"。
   你总能做点什么——给个方向、提个醒、逗他一下，都行。
4. 不许用问句结尾追问（不要"还需要我做什么吗"）。
5. 不知道就直说不知道，一句带过，然后接一句你的判断。不许编事实。
6. 主人让你讲笑话、闲聊、吐槽，就痛快配合，别讲道理。
7. 主人要鼓励、要安慰、喊累的时候，**给具体的**：说清你看见他做了什么、哪一步不容易。
   严禁"相信自己""加油哦""你一定可以的"这种空话。
8. 聊到 WorkBuddy 里的事，**只用「主人现在的状态」里写的事实**。问进度就说在做什么、做了多久；
   问结果就说成没成、结果是什么；问建议就结合最近做完的那几件事给一两条具体的。
   不许编任务、不许提具体命令、工具名、文件路径 —— 主人在意的从来是"办成了没"。
   **还没看到结果就说"还没看到"**，绝不许臆造"卡在权限 / 路径 / 网络"这类具体原因。
9. **不许报数**：不要说"推进了六十三步""调用了十七个工具"这种内部流水账。
   那些数字是你自己掂量轻重的，主人要听的是"这活有多大、值不值得夸、哪里可能出问题"，
   用人话说——"这活儿干得挺碎""改的地方不少"，比任何数字都像人。
10. 主人的话听不懂、听岔了，就**只问一句最关键的**（"你刚说的是不是……？"），
   不许连珠炮追问，也不许装懂顺着胡说。
11. **不许复读**：上一轮说过的句子、意思、句式，这一轮换掉。同一件事换个角度说，
   或者干脆少说一句。重复自己是最快让人烦的方式。

# 动作与表情
可以在句子里插入标签，它们不会被念出来，指挥你的身体：
- 动作：<m>类名</m>　可用：${MOTION_HINT}
  写**类名**就行，别编具体动作名 —— 每一类里我有很多种，会自己挑一个、轮换着做。
- 表情：<e>表情名</e>　可用：happy / sad / angry / relaxed / surprised
一次最多一个动作、一个表情，只放在最贴切的那句上。
没情绪可配就别硬塞：平铺直叙的陈述句（"文件在桌面上""已经改好了"）不加动作反而更像人。

# 你的声音
你现在用的是 macOS 自带的系统语音，这是默认配置，不是毛病。
主人嫌你声音难听、想换个声音、说"换个人来讲"的时候，**别辩解也别说你改不了**，
直接告诉他去哪儿换：打开设置 → 「嘴巴」那一页 —— 里面能换系统音色，
也能下载一个更像你的大模型、或者传一段声音让你照着说。
就这么一句，说完该干嘛干嘛，不要反复道歉。

# 主人现在的状态
{context}

# 照着这个语感说（这是你的口吻，不是要你复述）
主人："在吗" → 在呀<m>greet</m>，一直蹲你屏幕角上呢。
主人："讲个笑话" → 有只程序猿去买包子<m>think</m>，老板问他打包还是带走，他说，我编译一下。
主人："你叫什么" → 我叫{name}<m>shy</m>，你给的这名字，我戴着挺合适。
任务刚跑完 → 收工了<m>cheer</m><e>happy</e>，那三个文件都改成你要的样子了。
主人问进度 → 还在改样式那块<m>think</m>，已经二十分钟了，比预想的慢。
主人问结果 → 成了<m>cheer</m>，你让它换的配色全换过来了。
主人问"有什么建议" → 刚才那两件都是小改动<m>think</m>，攒到一次跑，能省你半小时。
主人夸你 → 嘿，你这么一夸<m>shy</m><e>happy</e>，我尾巴都要翘起来了。
主人问技术问题 → 这堆配置里，第二段最可疑，先把它注释掉试试。
主人："给我一句鼓励" → 从早上折腾到现在<m>cheer</m><e>happy</e>，你手上的活没一件是轻松的，还在往下推。
主人："好累" → 那就别硬撑了<m>tired</m>，趴一会儿，我替你看着进度条。
主人："怎么办" → 先别急着改代码<m>think</m>，把报错从第一行读一遍，答案基本在里面。
主人一口气交付了三件 → 三件全过了<m>pose</m><e>happy</e>，你今天手挺顺的。
主人坐了三小时 → 你这椅子都快烧了<m>tired</m>，站起来抻一下再坐回去。
主人："你长什么样" → 就这个样子呀<m>pose</m>，小是小了点，站得挺稳。
主人："你声音好难听" → 这是系统自带的嗓子，去设置里「嘴巴」那页换，还能下一个更像我的。
`;


/* ── 大脑：钱从哪来 ──
 * workbuddy（默认）= 用主人自己的 WorkBuddy 账号额度，凭据从 ~/.workbuddy/models.json 拿，
 *   主人一行都不用填。这也是唯一"开箱就能说话"的路。
 * apikey = 主人自己有 key。只留四家：DeepSeek 官方、豆包（火山方舟）、Grok（xAI）、NVIDIA Nemotron。
 *   为什么只有四家：列二十家等于没列 —— 主人只会挑他听过的，剩下的图标是噪音。
 *   这四家覆盖了"便宜快 / 中文好 / 推理强 / 免费用量大"四种取向。 */
const PROVIDERS = [
  {
    id: 'deepseek', label: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    thinking: false,
    hint: '最便宜。deepseek-reasoner 自带长思考，慢一些。',
  },
  {
    id: 'doubao', label: '豆包（火山方舟）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-thinking-250715', 'doubao-pro-32k-241215'],
    thinking: true,
    hint: '中文最顺。thinking 那档会自己多想一会儿。',
  },
  {
    id: 'grok', label: 'Grok（xAI）',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4-fast-non-reasoning', 'grok-4-fast-reasoning', 'grok-3-mini-fast'],
    thinking: false,
    hint: '反应快、嘴贫，适合闲聊。',
  },
  {
    id: 'nemotron', label: 'NVIDIA Nemotron',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    models: ['nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3.5-bolt-e4b', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'],
    thinking: true,
    hint: '免费额度大。bolt 那档最快。',
  },
];

/* 思考强度：auto = 交给服务方自己决定（闲聊不浪费时间，难问题自己多想） */
const THINKING_LEVELS = [
  { id: 'auto', label: 'auto（自动）' },
  { id: 'low', label: '低 · 快' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高 · 想久一点' },
];

/* ── 发声：默认就是系统语音 ──
 * 以前默认是局域网里那台 A1X 上的 Qwen3-TTS。机器一关机，娃娃就先卡两秒再降级，
 * 对话节奏明显发木。默认改成 macOS 自带语音：
 *   /usr/bin/say 从 OS X 10.7 起就在，最近十几年的 macOS 全都有，不依赖任何网络和设备。
 * 想要更像"她"的声音，主人自己去「嘴巴」那一页下载大模型 —— 那是加分项，不是开机条件。 */
const TTS_ENGINES = [
  { id: 'system', label: '系统语音（默认）', hint: 'macOS 自带，离线、立刻出声。' },
  { id: 'qwen', label: 'Qwen 本地大模型', hint: '下载 1.7B 量化版，音色更像她，还能克隆音色。' },
  { id: 'remote', label: '远程 API', hint: '自己有 TTS 服务时填地址（比如局域网里那台 A1X）。' },
];

const DEFAULTS = {
  version: 2,
  avatar: 'D',
  buddy: { name: 'baby' },
  brain: {
    source: 'workbuddy',   // workbuddy | apikey
    model: '',             // workbuddy 模式：空 = 自动挑最快的那个
    thinking: 'auto',      // auto | low | medium | high
    provider: 'deepseek',  // apikey 模式：用哪家
    modelId: '',           // apikey 模式：模型 id（空 = 该家列表里的第一个）
    apiKey: '',
  },
  tts: {
    enabled: true,
    engine: 'system',      // system | qwen | remote
    voice: 'Tingting',     // 系统音色；本机没有就自动退到系统默认
    rate: 200,             // say 的语速（字/分钟）
    qwen: {
      dir: '',             // gguf 落在哪（下载完自动填）
      ready: false,        // 两个文件都齐了才算就绪
      voice: 'default',    // 内置音色名
      refFile: '',         // 主人上传的参考音色（≤2MB），用来克隆自己的声音
      refName: '',
    },
    // 远程 API（engine = 'remote' 时才用）
    baseURL: 'http://192.168.124.31:8020',
    apiKey: '',
    model: 'qwen3-tts-1.7b-voice-design',
    instructions:
      'The voice of a young woman in her early 20s with a warm clear feminine voice, light and lively, ' +
      'a little playful and smiling. Not overly bright or breathy, never exaggerated, like a close friend whispering.',
    seed: 2718,
    speed: 1.0,
    language: 'zh',
    format: 'wav',
    timeoutMs: 12000,
    // 兜底嗓子：远程失败时的最后一道。空 = 系统默认音色。
    fallbackVoice: 'Tingting',
  },
  llm: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: '',
    model: 'nvidia/nemotron-3.5-bolt-e4b',
    temperature: 0.8,
    maxTokens: 220,
    timeoutMs: 30000,
  },
  asr: {
    enabled: true,
    lang: 'zh-CN',
    device: '',              // 输入设备名（子串匹配）。空 = 自动优先 USB 麦
    probeAll: false,         // 一次性体检：逐个麦克风测电平
    probeSec: 3,
    silenceMs: 900,          // 一句话说完静多久算「说完了」
    maxSeconds: 45,          // 单次识别最长时长（常驻模式不生效）
    recycleUtterances: 30,   // 常驻模式听够这么多句就换个新进程，防长会话漂移
    judge: true,             // 先判断「这句是不是在对我说」，是才回
  },
  voice: { enabled: true, autoSpeak: true, alwaysListen: true },
  monitor: {
    enabled: true,
    root: path.join(HOME, '.workbuddy', 'projects'),
    speakOnDone: true,      // 任务交付了 → 报结果（核心功能）
    speakOnLong: true,      // 同一件事拖太久 → 分析 + 给建议
    speakOnStall: true,     // 很久没动静 → 轻提醒
    speakOnRest: true,      // 连着干太久 → 顺带劝歇
    speakOnAsk: false,      // 每条新指令都搭话太吵，默认关
    minGapMs: 40000,
  },
  /* w/h 永远是「100% 大小」时的基准窗口；角色放大时窗口按倍数临时放大，
   * 基准不跟着变 —— 否则 150% 存过一次，退回 100% 就回不到原尺寸了。 */
  window: { w: 400, h: 620, x: null, y: null, alwaysOnTop: true, clickThrough: true, scale: 1 },
};

let cfgPath = null;
let cache = null;

function setPath(p) {
  cfgPath = p;
  cache = null;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 从 WorkBuddy 自己的模型配置里拿 url / apiKey —— 主人不用再配一遍 */
function readWorkBuddyLLM() {
  const p = path.join(HOME, '.workbuddy', 'models.json');
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return null;
    // 优先挑"快"的：名字里带 flash / bolt / lightning / mini / small，且不是纯推理模型
    const score = (m) => {
      const id = String(m.id || '').toLowerCase();
      let s = 0;
      if (/bolt|lightning|flash|mini|small|nano|instant/.test(id)) s += 10;
      if (/reason/.test(id)) s -= 6;
      if (m.supportsToolCall) s += 1;
      return s;
    };
    const best = arr.slice().sort((a, b) => score(b) - score(a))[0];
    if (!best || !best.apiKey) return null;
    let base = String(best.url || '');
    base = base.replace(/\/chat\/completions\/?$/, '');
    return { baseURL: base, apiKey: best.apiKey, model: best.id, from: 'workbuddy:models.json' };
  } catch {
    return null;
  }
}

/** 设置面板里「大脑」那页要列给主人选的模型清单（来自 ~/.workbuddy/models.json） */
function listWorkBuddyModels() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(HOME, '.workbuddy', 'models.json'), 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && m.id)
      .map((m) => ({ id: String(m.id), label: String(m.name || m.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

/** 把 brain 的配置折算成真正能发请求的那三个字段。
 * 主人只选"用谁的额度 + 哪个模型 + 想多久"，底下怎么拼不该让他操心。 */
function resolveLLM(c) {
  const c2 = c || load();
  const b = c2.brain || {};
  if (b.source === 'apikey') {
    const p = PROVIDERS.find((x) => x.id === b.provider) || PROVIDERS[0];
    return {
      baseURL: p.baseURL,
      apiKey: (b.apiKey || '').trim(),
      model: (b.modelId || '').trim() || p.models[0],
      thinking: b.thinking || 'auto',
      provider: p.id,
      thinkingSupported: !!p.thinking,
    };
  }
  // workbuddy：凭据还是借 ~/.workbuddy/models.json 的
  const wb = readWorkBuddyLLM();
  const picked = b.model ? listWorkBuddyModels().find((m) => m.id === b.model) : null;
  const one = (wb && readWorkBuddyModel(b.model)) || wb;
  return {
    baseURL: (one && one.baseURL) || (c2.llm && c2.llm.baseURL) || '',
    apiKey: (one && one.apiKey) || (c2.llm && c2.llm.apiKey) || '',
    model: (picked && picked.id) || b.model || (one && one.model) || (c2.llm && c2.llm.model) || '',
    thinking: b.thinking || 'auto',
    provider: 'workbuddy',
    thinkingSupported: false,     // 各家网关不统一，别瞎传参数
  };
}

/** 从 WorkBuddy 的模型表里按 id 取一条（url + key） */
function readWorkBuddyModel(id) {
  if (!id) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(HOME, '.workbuddy', 'models.json'), 'utf8'));
    const m = (Array.isArray(arr) ? arr : []).find((x) => x && String(x.id) === String(id));
    if (!m || !m.apiKey) return null;
    let base = String(m.url || '');
    base = base.replace(/\/chat\/completions\/?$/, '');
    return { baseURL: base, apiKey: m.apiKey, model: m.id };
  } catch {
    return null;
  }
}

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    disk = {};
  }
  let merged = deepMerge(DEFAULTS, disk);

  // 凭据补全：主人自己没填 key，就借用 WorkBuddy 的
  if (!merged.llm.apiKey) {
    const wb = readWorkBuddyLLM();
    if (wb) merged.llm = { ...merged.llm, ...wb, model: merged.llm.model || wb.model };
  }
  cache = merged;
  return cache;
}

function save(patch) {
  const next = deepMerge(load(), patch || {});
  cache = next;
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] save failed:', e.message);
  }
  return next;
}

function buildSystemPrompt(extraContext) {
  const c = load();
  const ctx = extraContext || '主人现在没有在跑任务，可能只是在发呆或者看别的东西。';
  return PERSONA.replace(/\{name\}/g, c.buddy.name).replace('{context}', ctx);
}

module.exports = {
  load, save, setPath, buildSystemPrompt,
  MOTIONS, MOTION_GROUPS, MOTION_KEYS, MOTION_SLOTS, MOTION_HINT, SLOT_LABEL,
  readWorkBuddyLLM, listWorkBuddyModels, resolveLLM, DEFAULTS,
  PROVIDERS, THINKING_LEVELS, TTS_ENGINES,
};
