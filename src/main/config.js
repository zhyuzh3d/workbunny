'use strict';
/**
 * 配置层：所有可调项集中在这里，落盘到 userData/config.json。
 * LLM 凭据优先复用 WorkBuddy 自己的 ~/.workbuddy/models.json —— 这样娃娃用的是主人账号额度。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/* 动作目录。tag = 'llm' 的才会出现在提示词的可用列表里；
 * tag = 'event' 的由代码在具体事件上播（点击、收工、切场景），不交给模型挑 ——
 * 一次给模型二十几个选项，它只会挑那几个听熟了的，多出来的全浪费。
 * tag = 'off' 的不接入逻辑，只在动作列表里手动播（主人想看就看得见）。
 *
 * group 只管「动作列表弹窗」怎么分类，和 AI 怎么挑没关系 ——
 * 二十几个动作平铺成一列，主人根本找不到想看的那个。 */
const MOTION_GROUPS = [
  { id: 'idle', label: '待机' },
  { id: 'greet', label: '打招呼' },
  { id: 'emo', label: '情绪' },
  { id: 'cheer', label: '庆祝' },
  { id: 'pose', label: '姿态' },
];

const MOTIONS = [
  { key: 'idle_loop', label: '待机呼吸', group: 'idle', loop: true, tag: 'llm', use: '默认待机，什么都不说时用' },
  { key: 'LookAround', label: '四处张望', group: 'idle', loop: true, tag: 'llm', use: '好奇、找东西、等回应' },
  { key: 'Relax', label: '放松', group: 'idle', loop: true, tag: 'llm', use: '闲下来、陪伴、无事发生' },
  { key: 'Thinking', label: '思考', group: 'idle', loop: true, tag: 'llm', use: '正在想、正在查、不确定' },
  { key: 'Sleepy', label: '困了', group: 'idle', loop: true, tag: 'llm', use: '主人很久没理我、深夜' },
  { key: 'idle-maid', label: '安静站姿', group: 'idle', loop: true, tag: 'event', use: '主人在专注干活时的待机' },
  { key: 'idle-sitting', label: '并腿站姿', group: 'idle', loop: true, tag: 'off', use: '不接入待机：并腿会把裙子顶穿，只能手动看' },

  // ── VRoid Project Motion Pack（切段后接入，见 app.js MOTION_WINDOWS）──
  { key: 'greeting2', label: '抬手打招呼', group: 'greet', loop: false, tag: 'llm', use: '主人刚回来、早安、轻一点的招呼（比 Goodbye 含蓄）' },
  { key: 'greeting', label: '起身迎接', group: 'greet', loop: false, tag: 'event', use: '主人离开很久回来时的正式迎接（从蹲姿站起来挥手）' },
  { key: 'Goodbye', label: '挥手再见', group: 'greet', loop: false, tag: 'llm', use: '打招呼、告别、任务交付' },
  { key: 'shoot', label: '举手致意', group: 'greet', loop: false, tag: 'event', use: '招呼主人过来看' },
  { key: 'hello', label: '伸懒腰', group: 'greet', loop: false, tag: 'llm', use: '坐太久、催主人起来动一动、刚睡醒' },

  { key: 'Surprised', label: '惊讶', group: 'emo', loop: false, tag: 'llm', use: '意外、发现问题、惊讶' },
  { key: 'Angry', label: '生气', group: 'emo', loop: false, tag: 'llm', use: '被亏待、抱怨（仅玩笑级别）' },
  { key: 'Sad', label: '难过', group: 'emo', loop: false, tag: 'llm', use: '抱歉、失败、遗憾' },
  { key: 'Blush', label: '害羞', group: 'emo', loop: false, tag: 'llm', use: '被夸、被感谢' },
  { key: 'grabbed', label: '低头认错', group: 'emo', loop: false, tag: 'llm', use: '抱歉、认错、被主人说了一句（整个人弯下去低头）' },

  { key: 'Clapping', label: '鼓掌', group: 'cheer', loop: false, tag: 'llm', use: '称赞、成功、恭喜' },
  { key: 'Jump', label: '跳一下', group: 'cheer', loop: false, tag: 'llm', use: '好消息、兴奋、提醒主人' },
  { key: 'spin', label: '转圈庆祝', group: 'cheer', loop: false, tag: 'llm', use: '大成功、被夸到飞起' },
  { key: 'peace_sign', label: '比耶', group: 'cheer', loop: false, tag: 'llm', use: '得意、办成了、卖萌' },

  { key: 'model_pose', label: '摆拍', group: 'pose', loop: false, tag: 'event', use: '被盯着看时的摆姿势' },
  { key: 'motion_pose', label: '迈步走近', group: 'pose', loop: false, tag: 'event', use: '走过去看看' },
  { key: 'show_full_body', label: '展示自己', group: 'pose', loop: false, tag: 'llm', use: '被问长什么样、被问是什么' },
  { key: 'VRMA_07', label: '扶脸', group: 'pose', loop: false, tag: 'event', use: '害羞、整理仪表' },
];

const MOTION_KEYS = MOTIONS.filter((m) => m.tag === 'llm').map((m) => m.key);
/* 提示词里列给模型的清单：键 + 中文意思。只给英文键不行 ——
 * greeting2 / show_full_body 这种名字，模型猜不出差别，最后永远只挑 Jump 和 Blush。 */
const MOTION_HINT = MOTIONS.filter((m) => m.tag === 'llm')
  .map((m) => `${m.key}（${m.label}）`)
  .join(' / ');

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
- 动作：<m>动作名</m>　可用：${MOTION_HINT}
- 表情：<e>表情名</e>　可用：happy / sad / angry / relaxed / surprised
一次最多一个动作、一个表情，只放在最贴切的那句上。

# 主人现在的状态
{context}

# 照着这个语感说（这是你的口吻，不是要你复述）
主人："在吗" → 在呀<m>Goodbye</m>，一直蹲你屏幕角上呢。
主人："讲个笑话" → 有只程序猿去买包子<m>Thinking</m>，老板问他打包还是带走，他说，我编译一下。
主人："你叫什么" → 我叫{name}<m>Blush</m>，你给的这名字，我戴着挺合适。
任务刚跑完 → 收工了<m>Jump</m><e>happy</e>，那三个文件都改成你要的样子了。
主人问进度 → 还在改样式那块<m>Thinking</m>，已经二十分钟了，比预想的慢。
主人问结果 → 成了<m>Jump</m>，你让它换的配色全换过来了。
主人问"有什么建议" → 刚才那两件都是小改动<m>Thinking</m>，攒到一次跑，能省你半小时。
主人夸你 → 嘿，你这么一夸<m>Blush</m><e>happy</e>，我尾巴都要翘起来了。
主人问技术问题 → 这堆配置里，第二段最可疑，先把它注释掉试试。
主人："给我一句鼓励" → 从早上折腾到现在<m>Jump</m><e>happy</e>，你手上的活没一件是轻松的，还在往下推。
主人："好累" → 那就别硬撑了<m>Relax</m>，趴一会儿，我替你看着进度条。
主人："怎么办" → 先别急着改代码<m>Thinking</m>，把报错从第一行读一遍，答案基本在里面。
主人一口气交付了三件 → 三件全过了<m>spin</m><e>happy</e>，你今天手挺顺的。
主人坐了三小时 → 你这椅子都快烧了<m>hello</m>，站起来抻一下再坐回去。
主人："你长什么样" → 就这个样子呀<m>show_full_body</m>，小是小了点，站得挺稳。
`;


const DEFAULTS = {
  version: 1,
  avatar: 'D',
  buddy: { name: 'baby' },
  llm: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: '',
    model: 'nvidia/nemotron-3.5-bolt-e4b',
    temperature: 0.8,
    maxTokens: 220,
    timeoutMs: 30000,
  },
  tts: {
    enabled: true,
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
    // A1X 那台机器不在线时的兜底嗓子（macOS 自带）。空 = 用系统默认音色。
    fallbackVoice: 'Tingting',
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

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    disk = {};
  }
  let merged = deepMerge(DEFAULTS, disk);

  // 凭据补全：主人自己没填，就借用 WorkBuddy 的
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
  MOTIONS, MOTION_GROUPS, MOTION_KEYS, MOTION_HINT,
  readWorkBuddyLLM, DEFAULTS,
};
