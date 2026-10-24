/**
 * 独立窗口（设置 / 动作列表）的逻辑。
 *
 * 为什么搬出来：以前这两个是角色窗口里的抽屉和侧栏 —— 设置表单一长就把娃娃的脸挡掉
 * 一半，动作列表摊开 92 条更是把画面挤成一条缝。它们本来就不是"表演的一部分"，
 * 该有自己的窗口：娃娃在她的窗口里照常站着，主人在这边慢慢挑。
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

const $ = (id) => document.getElementById(id);
const log = (m) => { try { window.pet.log('[panel] ' + m); } catch {} };

/* ── 权限 ── */
let asrStat = { speech: null, mic: null, note: '' };
const SPEECH_ZH = { 0: '待授权', 1: '被限制', 2: '已拒绝', 3: '已授权' };
const MIC_ZH = { granted: '已授权', denied: '已拒绝', restricted: '被限制', 'not-determined': '待授权', unknown: '未知' };
function paintPerm(st) {
  if (st) asrStat = { ...asrStat, ...st };
  const sEl = $('permSpeech');
  const mEl = $('permMic');
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

/* ── 设置 ── */
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
  const row = $('sizeRow');
  if (!row) return;
  for (const b of row.children) b.classList.toggle('on', Math.abs(Number(b.dataset.k) - viewScale) < 0.01);
}
async function setScale(k) {
  viewScale = Number(k) || 1;
  paintScale();
  await window.pet.scale(viewScale);
}

function fillForm() {
  const c = cfg;
  $('setName').value = c.buddy.name || '';
  $('setUrl').value = c.llm.baseURL || '';
  $('setModel').value = c.llm.model || '';
  $('setKey').value = c.llm.apiKey ? '••••••••' : '';
  $('setTtsOn').checked = !!c.tts.enabled;
  $('setTtsUrl').value = c.tts.baseURL || '';
  $('setTtsKey').value = c.tts.apiKey ? '••••••••' : '';
  $('setTtsInstr').value = c.tts.instructions || '';
  $('setOnDone').checked = !!c.monitor.speakOnDone;
  $('setOnLong').checked = c.monitor.speakOnLong !== false;
  $('setOnStall').checked = c.monitor.speakOnStall !== false;
  $('setOnRest').checked = c.monitor.speakOnRest !== false;
  $('setGap').value = Math.round((c.monitor.minGapMs || 40000) / 1000);
  $('probeOut').classList.add('hidden');
  paintAvatars();
  paintScale();
}

async function save() {
  const keyEl = $('setKey');
  const ttsKeyEl = $('setTtsKey');
  const patch = {
    buddy: { name: $('setName').value.trim() || 'baby' },
    llm: {
      baseURL: $('setUrl').value.trim(),
      model: $('setModel').value.trim(),
    },
    tts: {
      enabled: $('setTtsOn').checked,
      baseURL: $('setTtsUrl').value.trim(),
      instructions: $('setTtsInstr').value.trim(),
    },
    monitor: {
      speakOnDone: $('setOnDone').checked,
      speakOnLong: $('setOnLong').checked,
      speakOnStall: $('setOnStall').checked,
      speakOnRest: $('setOnRest').checked,
      minGapMs: Math.max(10, Number($('setGap').value) || 40) * 1000,
    },
  };
  if (keyEl.value && !keyEl.value.includes('•')) patch.llm.apiKey = keyEl.value.trim();
  if (ttsKeyEl.value && !ttsKeyEl.value.includes('•')) patch.tts.apiKey = ttsKeyEl.value.trim();
  cfg = await window.pet.config(patch);
  const b = $('saveBtn');
  const old = b.textContent;
  b.textContent = '记下了 ✓';
  setTimeout(() => { b.textContent = old; }, 1400);
}

/* ── 动作列表 ── */
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

/* ── 启动 ── */
(async function boot() {
  const init = await window.pet.panelInit();
  cfg = init.config;
  AVATAR_LIST = init.avatars || [];
  MOTIONS = init.motions || [];
  MOTION_GROUPS = init.motionGroups || [];
  avatarKey = init.avatar || (AVATAR_LIST[0] && AVATAR_LIST[0].key) || '';
  viewScale = (cfg.window && cfg.window.scale) || 1;

  if (which === 'settings') {
    fillForm();
    paintPerm(init.asr || null);
    $('sizeRow').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (b) setScale(Number(b.dataset.k));
    });
    $('saveBtn').addEventListener('click', save);
    $('probeBtn').addEventListener('click', async () => {
      const out = $('probeOut');
      out.classList.remove('hidden');
      out.textContent = '自检中…';
      const r = await window.pet.probe();
      out.textContent = [
        `模型  ${r.llm.ok ? '✓' : '✗'}  ${r.llm.ms}ms  ${r.llm.ok ? r.llm.text : r.llm.error}`,
        `语音  ${r.tts.ok ? '✓' : '✗'}  ${r.tts.ms}ms  ${r.tts.ok ? Math.round(r.tts.bytes / 1024) + 'KB' : r.tts.error}`,
        `识别  ${r.asr.ok ? '✓ 已就绪' : '✗ 缺少 bin/asr'}`,
        `监控  ${r.monitor.file ? '✓ ' + (r.monitor.snap?.title || r.monitor.snap?.sessionId || '') : '✗ 没找到会话'}`,
      ].join('\n');
    });
    $('permCheck').addEventListener('click', async () => {
      $('permTip').textContent = '正在请求权限…系统弹窗请点允许';
      paintPerm(await window.pet.asrStatus({ request: true }));
    });
    $('permOpenSpeech').addEventListener('click', () => window.pet.openPrivacy('speech'));
    $('permOpenMic').addEventListener('click', () => window.pet.openPrivacy('mic'));
    $('openMotions').addEventListener('click', () => window.pet.open('motions'));
  } else {
    buildMotionList();
    $('mSearch').addEventListener('input', (e) => { filter = e.target.value || ''; buildMotionList(); });
    $('mIdle').addEventListener('click', () => { curMotion = ''; window.pet.panelMotion('__idle__'); buildMotionList(); });
  }
  // 关掉窗口前把焦点还回去，别让输入框吞掉后面的按键
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement) document.activeElement.blur(); });
})().catch((e) => {
  document.body.innerHTML = '<div class="empty">面板没起来：' + String((e && e.message) || e) + '</div>';
});

window.__panel = () => ({ which, motions: MOTIONS.length, groups: MOTION_GROUPS.length, avatar: avatarKey, scale: viewScale });
