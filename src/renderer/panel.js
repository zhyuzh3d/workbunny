/**
 * 独立窗口（设置 / 动作库）的逻辑。
 *
 * 为什么搬出来：以前这两个是角色窗口里的抽屉和侧栏 —— 设置表单一长就把娃娃的脸挡掉
 * 一半，动作库摊开 92 条更是把画面挤成一条缝。它们本来就不是"表演的一部分"，
 * 该有自己的窗口：娃娃在她的窗口里照常站着，主人在这边慢慢挑。
 *
 * ── 设置分四页 ──
 * 按"她身上哪一部分"分，不按技术模块分：主人想的是"她的脸/耳朵/脑子/嘴"，
 * 不是"llm 配置 / tts 配置"。每页只显示当前选择真正需要的控件 ——
 * 选了系统语音，就不该同时冒出一大片 API 地址把人吓退。
 *
 * 这里不碰 3D。点一个动作是把 key 发给主进程，由主进程转给角色窗口去演。
 */
const which = new URLSearchParams(location.search).get('p') === 'motions' ? 'motions' : 'settings';
document.body.dataset.p = which;

let cfg = null;
let AVATAR_LIST = [];
let MOTIONS = [];
let MOTION_GROUPS = [];
let avatarKey = '';
let viewScale = 1;
let curMotion = '';
let BRAIN = { providers: [], thinkingLevels: [], workbuddyModels: [] };
let TTSI = { engines: [], systemVoices: [], qwen: {}, dl: {} };

const $ = (id) => document.getElementById(id);
const log = (m) => { try { window.pet.log('[panel] ' + m); } catch {} };

/* ═══════════ tab 切换 ═══════════ */
function showTab(t) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.t === t);
  for (const p of document.querySelectorAll('.pb[data-page]')) p.classList.toggle('on', p.dataset.page === t);
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (b) showTab(b.dataset.t);
});

/* ═══════════ 权限 ═══════════ */
let asrStat = { speech: null, mic: null, note: '' };
const SPEECH_ZH = { 0: '待授权', 1: '被限制', 2: '已拒绝', 3: '已授权' };
const MIC_ZH = { granted: '已授权', denied: '已拒绝', restricted: '被限制', 'not-determined': '待授权', unknown: '未知' };
function paintPerm(st) {
  if (st) asrStat = { ...asrStat, ...st };
  const sEl = $('permSpeech'), mEl = $('permMic');
  const speech = asrStat.speech;
  const micOk = asrStat.mic === true || asrStat.micSystem === 'granted';
  const pending = asrStat.note === 'pending';
  if (sEl) {
    if (speech === 3) { sEl.textContent = '已授权'; sEl.className = 'pill ok'; }
    else if (speech === -1) { sEl.textContent = '不可用'; sEl.className = 'pill bad'; }
    else if (pending || speech === 0) { sEl.textContent = '待授权'; sEl.className = 'pill wait'; }
    else { sEl.textContent = SPEECH_ZH[speech] || '未知'; sEl.className = 'pill bad'; }
  }
  if (mEl) {
    if (micOk) { mEl.textContent = '已授权'; mEl.className = 'pill ok'; }
    else if (asrStat.micSystem) {
      mEl.textContent = MIC_ZH[asrStat.micSystem] || asrStat.micSystem;
      mEl.className = asrStat.micSystem === 'denied' ? 'pill bad' : 'pill wait';
    } else if (asrStat.mic === false) { mEl.textContent = '未授权'; mEl.className = 'pill bad'; }
    else { mEl.textContent = '—'; mEl.className = 'pill'; }
  }
  const ok = speech === 3 && micOk;
  const tip = $('permTip');
  if (tip) {
    tip.textContent = ok
      ? '都通了。按 ⌘⇧Space 或点她脚下那条就开始说话。'
      : (pending ? '系统弹窗正在等你点「允许」。点完这里会自动变绿。'
        : '第一次要允许两项：语音识别 + 麦克风。允许后如果还是灰的，把开关关掉再打开一次。');
  }
}

/* ═══════════ 外貌 ═══════════ */
function paintAvatars() {
  const row = $('avRow');
  if (!row) return;
  if (row.childElementCount !== AVATAR_LIST.length) {
    row.innerHTML = '';
    for (const info of AVATAR_LIST) {
      const b = document.createElement('button');
      b.dataset.key = info.key;
      b.textContent = info.label || info.key;
      b.title = [info.label, info.title && info.title !== info.label ? `（${info.title}）` : '',
        info.author ? `· ${info.author}` : ''].join(' ').trim();
      b.addEventListener('click', () => pickAvatar(info.key));
      row.appendChild(b);
    }
  }
  for (const b of row.children) b.classList.toggle('on', b.dataset.key === avatarKey);
}

async function pickAvatar(k) {
  if (k === avatarKey) return;
  avatarKey = k;
  paintAvatars();
  cfg = await window.pet.config({ avatar: k });   // 主进程会把换形象这件事转给角色窗口
  log('换形象 ' + k);
}

function paintScale() {
  for (const b of $('sizeRow').children) b.classList.toggle('on', Math.abs(Number(b.dataset.k) - viewScale) < 0.01);
}
async function setScale(k) {
  viewScale = Number(k) || 1;
  paintScale();
  await window.pet.scale(viewScale);
}

/* ═══════════ 大脑 ═══════════ */
function fillSelect(el, items, cur) {
  el.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.label;
    el.appendChild(o);
  }
  if (cur) el.value = cur;
  if (el.selectedIndex < 0) el.selectedIndex = 0;
}

function paintBrain() {
  const b = cfg.brain || {};
  const src = b.source || 'workbuddy';
  for (const x of $('brainSrc').children) x.classList.toggle('on', x.dataset.s === src);
  $('brainWb').classList.toggle('on', src === 'workbuddy');
  $('brainKey').classList.toggle('on', src === 'apikey');

  // WorkBuddy：模型列表来自 ~/.workbuddy/models.json，第一项是「自动」
  const wb = [{ id: '', label: '自动（挑最快的那个）' }].concat(
    (BRAIN.workbuddyModels || []).map((m) => ({ id: m.id, label: m.label })));
  fillSelect($('wbModel'), wb, b.model || '');
  fillSelect($('wbThink'), BRAIN.thinkingLevels, b.thinking || 'auto');

  // 自己的 key：只有四家
  fillSelect($('bkProvider'), BRAIN.providers.map((p) => ({ id: p.id, label: p.label })), b.provider || 'deepseek');
  paintProvider();
}

function paintProvider() {
  const b = cfg.brain || {};
  const p = (BRAIN.providers || []).find((x) => x.id === (b.provider || 'deepseek')) || BRAIN.providers[0];
  if (!p) return;
  $('bkHint').textContent = p.hint || '';
  const models = p.models.map((m) => ({ id: m, label: m })).concat([{ id: '__custom__', label: '自己填模型 id…' }]);
  const cur = b.modelId || '';
  const known = p.models.includes(cur);
  fillSelect($('bkModel'), models, known ? cur : '__custom__');
  $('bkCustomRow').classList.toggle('on', !known);
  if (!known) $('bkCustom').value = cur;
  $('bkKey').value = b.apiKey ? '••••••••' : '';
  // 不支持思考强度的那几家，就别摆一个没用的下拉
  const th = $('bkThink');
  fillSelect(th, BRAIN.thinkingLevels, b.thinking || 'auto');
  th.parentElement.classList.toggle('dim', !p.thinking);
  th.disabled = !p.thinking;
}

/* ═══════════ 嘴巴 ═══════════ */
const ENGINE_HINT = {
  system: 'macOS 自带，离线、立刻出声。嫌不好听就下载下面那个大模型。',
  qwen: '下载 1.7B 的最小量化版（约 1.4GB），音色更像她，还能用你上传的一段声音克隆。',
  remote: '自己有 TTS 服务时填这里。连不上会自动退回系统语音，不会哑。',
};
function paintTts() {
  const t = cfg.tts || {};
  const eng = t.engine || 'system';
  const row = $('ttsEngine');
  if (!row.childElementCount) {
    for (const e of TTSI.engines) {
      const b = document.createElement('button');
      b.dataset.e = e.id;
      b.textContent = e.label;
      b.addEventListener('click', () => { ttsDraft.engine = e.id; paintTts(); });
      row.appendChild(b);
    }
  }
  for (const b of row.children) b.classList.toggle('on', b.dataset.e === ttsDraft.engine);
  $('ttsHint').textContent = ENGINE_HINT[ttsDraft.engine] || '';
  $('ttsSystem').classList.toggle('on', ttsDraft.engine === 'system');
  $('ttsQwen').classList.toggle('on', ttsDraft.engine === 'qwen');
  $('ttsRemote').classList.toggle('on', ttsDraft.engine === 'remote');

  fillSelect($('sysVoice'), (TTSI.systemVoices || []).map((v) => ({ id: v.id, label: v.id + '　' + v.lang })), ttsDraft.voice);
  $('sysRate').value = ttsDraft.rate;
  $('sysRateVal').textContent = ttsDraft.rate;

  paintQwen();
}

function paintQwen() {
  const q = TTSI.qwen || {};
  const pill = $('qwenPill');
  const ready = !!q.ready;
  pill.textContent = ready ? '已就绪' : (q.dir ? '未下载' : '未下载');
  pill.className = 'pill ' + (ready ? 'ok' : 'wait');
  const names = (TTSI.qwen && TTSI.qwen.voices) || [{ id: 'default', label: '默认' }];
  fillSelect($('qwenVoice'), names, ttsDraft.qwenVoice || 'default');
  if (!ready) $('qwenVoice').disabled = true;
  else $('qwenVoice').disabled = false;
  const ref = (cfg.tts && cfg.tts.qwen && cfg.tts.qwen.refName) || '';
  $('qwenRefName').textContent = ref ? `当前参考音色：${ref}` : '还没上传。传一段她说话的声音（≤2MB），就能照着克隆。';
  if (!q.hasRuntime) {
    $('qwenTip').textContent = '注意：跑这个模型需要 llama.cpp 里的 llama-tts。没装的话下完也用不了，会退回系统语音。';
  }
}

let dlTimer = null;
function paintDl(st) {
  const total = (TTSI.qwen && TTSI.dl && TTSI.dl.total) || 1;
  const pct = st.running || st.done ? Math.min(100, Math.round((st.bytes / total) * 100)) : (TTSI.qwen.ready ? 100 : 0);
  $('qwenBar').style.width = pct + '%';
  $('qwenGo').textContent = st.running ? `下载中 ${pct}%` : (TTSI.qwen.ready ? '重新下载' : '下载模型');
  $('qwenGo').disabled = !!st.running;
  $('qwenStop').disabled = !st.running;
  if (st.err) $('qwenTip').textContent = '下载中断：' + st.err;
  else if (st.running) $('qwenTip').textContent = `正在下第 ${st.done + 1} 个文件：${st.file}`;
  else if (TTSI.qwen.ready) $('qwenTip').textContent = '模型齐了，选个音色就能用。';
  if (st.running) dlTimer = setTimeout(refreshDl, 1200);
}
async function refreshDl() {
  const st = await window.pet.ttsDlState();
  paintDl(st);
  if (!st.running) {
    const info = await window.pet.ttsInfo();
    TTSI.qwen = info.qwen;
    if (info.qwen.ready) cfg = await window.pet.config({ tts: { qwen: { dir: info.qwen.dir, ready: true } } });
    paintQwen();
  }
}

/* ═══════════ 保存 ═══════════ */
/* 界面上的草稿：改了先记在这儿，点保存才真的写进配置。
 * 这样主人来回切引擎试听，不会把半成品写进去。 */
let ttsDraft = { engine: 'system', voice: 'Tingting', rate: 200, qwenVoice: 'default' };

function fillForm() {
  const c = cfg;
  $('setName').value = c.buddy.name || '';
  $('setAlways').checked = !!(c.voice && c.voice.alwaysListen);
  $('setJudge').checked = !(c.asr && c.asr.judge === false);
  $('setTtsOn').checked = !!c.tts.enabled;
  const t = c.tts || {};
  ttsDraft = {
    engine: t.engine || 'system',
    voice: t.voice || 'Tingting',
    rate: t.rate || 200,
    qwenVoice: (t.qwen && t.qwen.voice) || 'default',
  };
  $('rmUrl').value = t.baseURL || '';
  $('rmKey').value = t.apiKey ? '••••••••' : '';
  $('rmModel').value = t.model || '';
  $('rmInstr').value = t.instructions || '';
  paintAvatars();
  paintScale();
  paintBrain();
  paintTts();
}

async function save() {
  const b = cfg.brain || {};
  const src = b.source || 'workbuddy';
  const keyEl = $('bkKey');
  const rmKey = $('rmKey');
  const patch = {
    buddy: { name: $('setName').value.trim() || 'baby' },
    voice: { alwaysListen: $('setAlways').checked },
    asr: { judge: $('setJudge').checked },
    brain: {
      source: src,
      thinking: (src === 'workbuddy' ? $('wbThink') : $('bkThink')).value,
      model: src === 'workbuddy' ? $('wbModel').value : b.model,
      provider: src === 'apikey' ? $('bkProvider').value : b.provider,
      modelId: src === 'apikey' ? (($('bkModel').value === '__custom__') ? $('bkCustom').value.trim() : $('bkModel').value) : b.modelId,
      apiKey: src === 'apikey' && keyEl.value && !keyEl.value.includes('•') ? keyEl.value.trim() : b.apiKey,
    },
    tts: {
      enabled: $('setTtsOn').checked,
      engine: ttsDraft.engine,
      voice: ttsDraft.voice,
      rate: Number(ttsDraft.rate) || 200,
      qwen: { voice: ttsDraft.qwenVoice },
      baseURL: $('rmUrl').value.trim(),
      model: $('rmModel').value.trim(),
      instructions: $('rmInstr').value.trim(),
    },
  };
  if (rmKey.value && !rmKey.value.includes('•')) patch.tts.apiKey = rmKey.value.trim();
  cfg = await window.pet.config(patch);
  const btn = $('saveBtn');
  const old = btn.textContent;
  btn.textContent = '记下了 ✓';
  setTimeout(() => { btn.textContent = old; }, 1400);
  log(`保存 engine=${patch.tts.engine} brain=${patch.brain.source}`);
}

/* ═══════════ 动作库 ═══════════ */
let filter = '';
function buildMotionList() {
  const box = $('motionList');
  if (!box) return;
  box.innerHTML = '';
  const q = filter.trim().toLowerCase();
  let n = 0;
  const groups = MOTION_GROUPS.length ? MOTION_GROUPS : [{ id: '', label: '' }];
  for (const g of groups) {
    const items = MOTIONS.filter((m) => (m.slot || '') === g.id)
      .filter((m) => !q || (m.label + ' ' + m.key + ' ' + (m.use || '')).toLowerCase().includes(q));
    if (!items.length) continue;
    const h = document.createElement('div');
    h.className = 'mGroup';
    h.textContent = `${g.label}　${items.length}`;
    box.appendChild(h);
    for (const m of items) {
      n++;
      const b = document.createElement('button');
      b.className = 'mItem' + (m.key === curMotion ? ' on' : '');
      b.dataset.key = m.key;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = m.label || m.key;
      // 一句话说明挂在下边：主人不用先记住 92 个名字才知道该点哪个
      if (m.use) {
        const us = document.createElement('span');
        us.className = 'us';
        us.textContent = m.use;
        nm.appendChild(us);
      }
      b.appendChild(nm);
      if (m.loop) {
        const lp = document.createElement('span');
        lp.className = 'lp';
        lp.textContent = '↻';
        b.appendChild(lp);
      }
      b.addEventListener('click', () => {
        curMotion = m.key;
        for (const x of box.querySelectorAll('button.mItem')) x.classList.toggle('on', x.dataset.key === m.key);
        window.pet.panelMotion(m.key);
        log('手动 ' + m.key);
      });
      box.appendChild(b);
    }
  }
  if (!n) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '没找到「' + filter + '」。';
    box.appendChild(e);
  }
  const c = $('mCount');
  if (c) c.textContent = `共 ${MOTIONS.length} 条`;
}

/* ═══════════ 启动 ═══════════ */
(async function boot() {
  const init = await window.pet.panelInit();
  cfg = init.config;
  AVATAR_LIST = init.avatars || [];
  MOTIONS = init.motions || [];
  MOTION_GROUPS = init.motionGroups || [];
  avatarKey = init.avatar || (AVATAR_LIST[0] && AVATAR_LIST[0].key) || '';
  viewScale = (cfg.window && cfg.window.scale) || 1;

  if (which === 'settings') {
    BRAIN = await window.pet.brainInfo();
    TTSI = await window.pet.ttsInfo();
    fillForm();
    paintPerm(init.asr || null);
    showTab('look');

    $('sizeRow').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (b) setScale(Number(b.dataset.k));
    });
    $('brainSrc').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-s]');
      if (!b) return;
      cfg.brain = { ...(cfg.brain || {}), source: b.dataset.s };
      paintBrain();
    });
    $('bkProvider').addEventListener('change', () => {
      cfg.brain = { ...(cfg.brain || {}), provider: $('bkProvider').value, modelId: '' };
      paintProvider();
    });
    $('bkModel').addEventListener('change', () => {
      const v = $('bkModel').value;
      $('bkCustomRow').classList.toggle('on', v === '__custom__');
    });
    // 嘴巴：改了立刻同步到配置里，这样「试听」听到的就是刚选的那个
    const live = (patch) => window.pet.config(patch).then((c) => { cfg = c; });
    $('sysVoice').addEventListener('change', async () => {
      ttsDraft.voice = $('sysVoice').value;
      await live({ tts: { voice: ttsDraft.voice, engine: 'system' } });
    });
    $('sysRate').addEventListener('input', () => {
      ttsDraft.rate = Number($('sysRate').value);
      $('sysRateVal').textContent = ttsDraft.rate;
    });
    $('sysRate').addEventListener('change', () => live({ tts: { rate: ttsDraft.rate } }));
    $('qwenVoice').addEventListener('change', async () => {
      ttsDraft.qwenVoice = $('qwenVoice').value;
      await live({ tts: { engine: 'qwen', qwen: { voice: ttsDraft.qwenVoice } } });
    });
    $('qwenGo').addEventListener('click', async () => {
      const r = await window.pet.ttsDownload();
      if (r.started) { paintDl({ running: true, done: 0, bytes: 0, file: TTSI.qwen.files[0] || '' }); refreshDl(); }
      else $('qwenTip').textContent = r.reason || '没能开始下载';
    });
    $('qwenStop').addEventListener('click', async () => {
      window.pet.ttsCancel();
      $('qwenTip').textContent = '正在取消…';
    });
    $('qwenRef').addEventListener('click', async () => {
      const r = await window.pet.ttsPickRef();
      if (!r.ok) { $('qwenRefName').textContent = r.error ? ('没用上：' + r.error) : '没选文件。'; return; }
      cfg = await window.pet.config({ tts: { engine: 'qwen', qwen: { voice: 'clone' } } });
      ttsDraft.engine = 'qwen'; ttsDraft.qwenVoice = 'clone';
      paintTts();
    });

    $('permCheck').addEventListener('click', async () => {
      $('permTip').textContent = '正在请求权限…系统弹窗请点允许';
      paintPerm(await window.pet.asrStatus({ request: true }));
    });
    $('permOpenSpeech').addEventListener('click', () => window.pet.openPrivacy('speech'));
    $('permOpenMic').addEventListener('click', () => window.pet.openPrivacy('mic'));

    $('saveBtn').addEventListener('click', save);
    $('testBtn').addEventListener('click', async () => {
      $('sfNote').textContent = '正在试听…';
      const r = await window.pet.ttsTest();
      $('sfNote').textContent = r.ok
        ? `用的是 ${r.engine === 'system' ? '系统语音' : r.engine}${r.voice ? ' · ' + r.voice : ''}（${r.ms}ms）`
        : ('试听失败：' + r.error);
    });
  } else {
    buildMotionList();
    $('mSearch').addEventListener('input', (e) => { filter = e.target.value || ''; buildMotionList(); });
    $('mIdle').addEventListener('click', () => { curMotion = ''; window.pet.panelMotion('__idle__'); buildMotionList(); });
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement) document.activeElement.blur(); });
})().catch((e) => {
  document.body.innerHTML = '<div class="empty">面板没起来：' + String((e && e.message) || e) + '</div>';
});

window.__panel = () => ({ which, motions: MOTIONS.length, groups: MOTION_GROUPS.length, avatar: avatarKey, scale: viewScale });
