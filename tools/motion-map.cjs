'use strict';
/**
 * 动作库重整：把 10 个包里精选出的 92 条动作，全部按「语义」重新命名，
 * 一对一记录原包名 + 原文件名（对不上号时能立刻回查）。
 *
 * 命名规则：<槽位>_<变体>，全小写下划线，文件名即 key（assets/motions/<key>.vrma）。
 * 槽位不是装饰：它决定这条动作什么时候会被用（见 MOTION_SLOTS）。
 */
const SRC = '../vrma-library';

/* [ 源目录, 原文件名, 新 key ] */
const MAP = [
  // ── VRoid Project Motion Pack（pixiv Inc. 免费配布，发布须署名）──────────
  ['ready/vroid-project', 'VRMA_07.vrma', 'shy_face'],
  ['ready/vroid-project', 'greeting.vrma', 'greet_yeah'],
  ['ready/vroid-project', 'greeting2.vrma', 'greet_wave'],
  ['ready/vroid-project', 'hello.vrma', 'greet_turn'],
  ['ready/vroid-project', 'model_pose.vrma', 'pose_model'],
  ['ready/vroid-project', 'motion_pose.vrma', 'motion_cute'],
  ['ready/vroid-project', 'peace_sign.vrma', 'sign_peace'],
  ['ready/vroid-project', 'shoot.vrma', 'praise_shoot'],
  ['ready/vroid-project', 'show_full_body.vrma', 'pose_show'],
  ['ready/vroid-project', 'spin.vrma', 'pose_spin'],

  // ── VRM Viewer 表情包 ────────────────────────────────────────────────
  ['ready/vrm-viewer', 'Angry.vrma', 'angry_pout'],
  ['ready/vrm-viewer', 'Blush.vrma', 'surprise_scratch'],
  ['ready/vrm-viewer', 'Clapping.vrma', 'cheer_clap_vr'],
  ['ready/vrm-viewer', 'Goodbye.vrma', 'bye_goodbye'],
  ['ready/vrm-viewer', 'Jump.vrma', 'cheer_jump_vr'],
  ['ready/vrm-viewer', 'LookAround.vrma', 'idle_look'],
  ['ready/vrm-viewer', 'Relax.vrma', 'tired_stretch_vr'],
  ['ready/vrm-viewer', 'Sad.vrma', 'sorry_sad'],
  ['ready/vrm-viewer', 'Sleepy.vrma', 'tired_sleep'],
  ['ready/vrm-viewer', 'Surprised.vrma', 'surprise_vr'],
  ['ready/vrm-viewer', 'Thinking.vrma', 'think_lady'],

  // ── desktop-homunculus（Apache-2.0）──────────────────────────────────
  ['ready/homunculus', 'grabbed.vrma', 'sorry_grab'],
  ['ready/homunculus', 'idle-maid.vrma', 'work_maid'],
  ['ready/homunculus', 'idle-sitting.vrma', 'work_sit'],

  // ── Reika 待机集（chuckynuttys/timeline）──────────────────────────────
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle01_breathing.vrma', 'idle_breath'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle05_Stretch.vrma', 'tired_reach'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle06_JumpAround.vrma', 'cheer_hop'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle07_SpinningJump.vrma', 'motion_spinjump'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle08_ComeUpWithAnIdea.vrma', 'think_idea'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle14_Dance02.vrma', 'tease_cat'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle35_FingerSnap.vrma', 'praise_snap'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle36_Yay.vrma', 'cheer_yay'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle37_Tsundere.vrma', 'angry_tsundere'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle41_CuteShyPose.vrma', 'shy_cute'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle44_GreetingBow.vrma', 'thanks_bow_reika'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle47_Scaring.vrma', 'tease_scare'],
  ['raw2/chuckynuttys__timeline', 'reika_KA_Idle90_HandsOnHipsConfident.vrma', 'angry_hip'],

  // ── Cipher Stage（Enigma-EE）─────────────────────────────────────────
  ['raw2/Enigma-EE__Cipher_Stage', 'StandingIdle.vrma', 'idle_stand'],
  ['raw2/Enigma-EE__Cipher_Stage', 'StandingIdle01.vrma', 'idle_stand2'],
  ['raw2/Enigma-EE__Cipher_Stage', 'Surprised.vrma', 'surprise_cipher'],
  ['raw2/Enigma-EE__Cipher_Stage', 'ZombieNeckBite.vrma', 'tease_zombie'],
  ['raw2/Enigma-EE__Cipher_Stage', 'clapping.vrma', 'cheer_clap_cipher'],
  ['raw2/Enigma-EE__Cipher_Stage', 'excited.vrma', 'dance_excited'],
  ['raw2/Enigma-EE__Cipher_Stage', 'headbutt.vrma', 'tease_headbutt'],
  ['raw2/Enigma-EE__Cipher_Stage', 'sittingThumbsUp.vrma', 'praise_thumb'],
  ['raw2/Enigma-EE__Cipher_Stage', 'sittinglaughing.vrma', 'tired_sitnap'],
  ['raw2/Enigma-EE__Cipher_Stage', 'thankful.vrma', 'thanks_cipher'],

  // ── MayaVE 表情动作（gitphilosopher）──────────────────────────────────
  ['raw2/gitphilosopher__MayaVE', 'angry.vrma', 'angry_arms'],
  ['raw2/gitphilosopher__MayaVE', 'bashful.vrma', 'shy_bashful'],
  ['raw2/gitphilosopher__MayaVE', 'catwalk.vrma', 'tease_catwalk'],
  ['raw2/gitphilosopher__MayaVE', 'clapping.vrma', 'cheer_clap_maya'],
  ['raw2/gitphilosopher__MayaVE', 'crying.vrma', 'sorry_cry'],
  ['raw2/gitphilosopher__MayaVE', 'cute_think.vrma', 'think_cute'],
  ['raw2/gitphilosopher__MayaVE', 'excited.vrma', 'dance_excited_maya'],
  ['raw2/gitphilosopher__MayaVE', 'greeting.vrma', 'bye_wave'],
  ['raw2/gitphilosopher__MayaVE', 'hand_raise.vrma', 'greet_hand'],
  ['raw2/gitphilosopher__MayaVE', 'hard_nod.vrma', 'tired_nod'],
  ['raw2/gitphilosopher__MayaVE', 'head_shake.vrma', 'refuse_head'],
  ['raw2/gitphilosopher__MayaVE', 'idle_lalala.vrma', 'idle_lalala'],
  ['raw2/gitphilosopher__MayaVE', 'macarena_dance.vrma', 'dance_macarena'],
  ['raw2/gitphilosopher__MayaVE', 'rejected.vrma', 'refuse_reject'],
  ['raw2/gitphilosopher__MayaVE', 'shrug.vrma', 'refuse_shrug'],
  ['raw2/gitphilosopher__MayaVE', 'sigh.vrma', 'sorry_sigh'],
  ['raw2/gitphilosopher__MayaVE', 'thankful.vrma', 'thanks_maya'],
  ['raw2/gitphilosopher__MayaVE', 'wave.vrma', 'bye_wave_maya'],
  ['raw2/gitphilosopher__MayaVE', 'waving.vrma', 'refuse_waving'],
  ['raw2/gitphilosopher__MayaVE', 'weight_shift.vrma', 'idle_shift'],
  ['raw2/gitphilosopher__MayaVE', 'yawn.vrma', 'tired_yawn'],

  // ── ai-tuber 姿势（LongbowXXX）───────────────────────────────────────
  ['raw2/LongbowXXX__ai-tuber', 'fear_pose.vrma', 'refuse_fear'],
  ['raw2/LongbowXXX__ai-tuber', 'idle_pose.vrma', 'idle_pose'],
  ['raw2/LongbowXXX__ai-tuber', 'no_pose.vrma', 'refuse_no'],
  ['raw2/LongbowXXX__ai-tuber', 'punch_pose.vrma', 'tease_punch'],

  // ── chatter-agent（schwarz9791）──────────────────────────────────────
  ['raw2/schwarz9791__chatter-agent', 'cheer.vrma', 'cheer_arms'],
  ['raw2/schwarz9791__chatter-agent', 'droop.vrma', 'sorry_droop'],
  ['raw2/schwarz9791__chatter-agent', 'idle_loop.vrma', 'idle_loop'],
  ['raw2/schwarz9791__chatter-agent', 'model-walk.vrma', 'motion_walk'],
  ['raw2/schwarz9791__chatter-agent', 'startle.vrma', 'refuse_startle'],
  ['raw2/schwarz9791__chatter-agent', 'stomp.vrma', 'angry_stomp'],
  ['raw2/schwarz9791__chatter-agent', 'sway.vrma', 'shy_sway'],
  ['raw2/schwarz9791__chatter-agent', 'think.vrma', 'think_ultra'],

  // ── mocopi 动捕采样（tfuru）──────────────────────────────────────────
  ['raw2/tfuru__vrma-loader-sample', 'MCPM_20230806_154241.vrma', 'idle_walk_mocopi'],

  // ── desktop-waifu（yv-was-taken）─────────────────────────────────────
  ['raw2/yv-was-taken__desktop-waifu', 'Arm Stretching.vrma', 'tired_armstretch'],
  ['raw2/yv-was-taken__desktop-waifu', 'Cross Jumps.vrma', 'cheer_cross'],
  ['raw2/yv-was-taken__desktop-waifu', 'Female Standing Pose.vrma', 'tease_stand'],
  ['raw2/yv-was-taken__desktop-waifu', 'Femme Peek Around Corner.vrma', 'tease_peek'],
  ['raw2/yv-was-taken__desktop-waifu', 'Joyful Jump.vrma', 'cheer_joy'],
  ['raw2/yv-was-taken__desktop-waifu', 'Running.vrma', 'motion_run'],
  ['raw2/yv-was-taken__desktop-waifu', 'Situp To Idle.vrma', 'motion_situp2'],
  ['raw2/yv-was-taken__desktop-waifu', 'Situps.vrma', 'motion_situp'],
  ['raw2/yv-was-taken__desktop-waifu', 'Spinning.vrma', 'motion_spin'],
  ['raw2/yv-was-taken__desktop-waifu', 'talking.vrma', 'talk_talk'],
  ['raw2/yv-was-taken__desktop-waifu', 'thinking.vrma', 'think_dw'],
];

module.exports = { MAP, SRC };
