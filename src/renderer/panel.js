import '../shared/motion-core.js';
import { mountPortability } from './portability-ui.js';
import { autoGrow } from './auto-grow.js';
import { createSelfSettings } from './self-settings.js';
import { paintCredential } from './credential-input.js';
/**
 * 独立窗口（设置 / 动作库）的逻辑。
 *
 * 为什么搬出来：以前这两个是角色窗口里的抽屉和侧栏 —— 设置表单一长就把娃娃的脸挡掉
 * 一半，动作库摊开 92 条更是把画面挤成一条缝。它们本来就不是"表演的一部分"，
 * 该有自己的窗口：娃娃在她的窗口里照常站着，主人在这边慢慢挑。
 *
 * 设置分为外观、设定、场景、听力、智力、语音。每页只显示需要的控件 ——
 * 选了系统语音，就不该同时冒出一大片 API 地址把人吓退。
 *
 * 这里不碰 3D。点一个动作是把 key 发给主进程，由主进程转给角色窗口去演。
 */
const which = new URLSearchParams(location.search).get('p') === 'motions' ? 'motions' : 'settings';
document.body.dataset.p = which;
document.title = which === 'motions' ? 'Workbunny-动作库' : 'Workbunny-设置';

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
const selfSettings = createSelfSettings(window.pet, { save: () => save(), getConfig: () => cfg });
const log = (m) => { try { window.pet.log('[panel] ' + m); } catch {} };

// Keep unsaved fields separate from the latest main-process snapshot. An older
// acknowledgement must not erase a newer edit; unrelated tabs are never saved.
const edits = new Map();
let editRevision = 0, writeTail = Promise.resolve(), pendingWrites = 0;
function edit(path, value) { edits.set(path, { value, revision: ++editRevision }); }
function readPath(value, path) { return path.split('.').reduce((o, k) => o?.[k], value); }
function putPath(value, path, item) {
  const parts = path.split('.'); let target = value;
  for (const key of parts.slice(0, -1)) target = target[key] ||= {};
  target[parts.at(-1)] = item;
}
function leafPaths(value, prefix = '') {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? prefix + '.' + key : key;
    return item && typeof item === 'object' && !Array.isArray(item) ? leafPaths(item, path) : [path];
  });
}
function persist(patch, paths = leafPaths(patch), operation) {
  pendingWrites++;
  const versions = new Map(paths.map(path => [path, edits.get(path)?.revision]));
  const result = writeTail.then(async () => {
    const saved = operation ? await operation() : await window.pet.config(patch);
    const current = saved.config || saved;
    for (const [path, revision] of versions) {
      if (revision !== undefined && edits.get(path)?.revision === revision) edits.delete(path);
    }
    syncTts(current, paths);
    return current;
  });
  writeTail = result.catch(() => {});
  return result.finally(() => { pendingWrites--; });
}
addEventListener('beforeunload', event => {
  if (!pendingWrites) return;
  event.returnValue = false;
  writeTail.then(() => setTimeout(() => window.close(), 0));
});
function draftPatch(prefix) {
  const patch = {}, paths = [];
  for (const [path, item] of edits) {
    if (prefix && path !== prefix && !path.startsWith(prefix + '.')) continue;
    putPath(patch, path, path === 'brain' ? collectBrain() : item.value); paths.push(path);
  }
  return { patch, paths };
}
function pendingValue(path, fallback) {
  return edits.has(path) ? edits.get(path).value : readPath(cfg, path) ?? fallback;
}
const SCENE_SCOPE_TEXT = {
  private: '私聊：可按需参考私聊、生活与工作资料。',
  life: '生活：可按需参考生活与工作资料。',
  work: '工作：仅参考工作资料。',
};
function paintSceneProfile(source = cfg) {
  const configured = source?.memory?.scene;
  let scene = pendingValue('memory.scene', configured || 'life');
  if (!Object.hasOwn(SCENE_SCOPE_TEXT, scene)) scene = 'life';
  for (const button of $('panelScene').querySelectorAll('[data-scene]')) {
    const active = button.dataset.scene === scene;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('panelSceneScope').textContent = SCENE_SCOPE_TEXT[scene];
  const path = 'memory.scene';
  const status = $('panelSceneProfileStatus');
  status.classList.remove('bad', 'dirty');
  if (edits.has(path)) { status.textContent = '正在切换场景…'; status.classList.add('dirty'); }
  else status.textContent = '';
}
function changePanelScene(scene) {
  if (!Object.hasOwn(SCENE_SCOPE_TEXT, scene)) return;
  const path = 'memory.scene', prior = pendingValue(path, cfg?.memory?.scene || 'life');
  if (scene === prior) return;
  edit(path, scene);
  const revision = edits.get(path).revision;
  paintSceneProfile();
  $('panelSceneProfileStatus').textContent = '正在切换场景…';
  $('panelSceneProfileStatus').classList.remove('bad', 'dirty');
  persist({ memory: { scene } }, [path]).then(() => {
    if (!edits.has(path)) $('panelSceneProfileStatus').textContent = '';
  }).catch(error => {
    if (edits.get(path)?.revision === revision) {
      edits.delete(path);
      paintSceneProfile();
      $('panelSceneProfileStatus').textContent = `场景切换失败，已恢复原设置。${error.message || ''}`;
      $('panelSceneProfileStatus').classList.add('bad');
    }
  });
}

/* ═══════════ tab 切换 ═══════════ */
function showTab(t) {
  document.body.dataset.tab = t;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.t === t);
  for (const p of document.querySelectorAll('.pb[data-page]')) p.classList.toggle('on', p.dataset.page === t);
  if (t === 'persona') selfSettings.resize();
  if (t === 'look') autoGrow($('avatarDescription'), 2);
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
    else { sEl.textContent = (asrStat.mode === 'single' ? ['待授权', '被拒绝', '受限制', '可用'][speech] : SPEECH_ZH[speech]) || '未知'; sEl.className = 'pill bad'; }
    if (asrStat.note === 'installing') { sEl.textContent = '准备中'; sEl.className = 'pill wait'; }
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
    tip.textContent = asrStat.mode === 'single' && ok && asrStat.onDevice === false && !cfg.asr.allowNetwork ? '当前语言需要联网识别；请明确允许联网，或继续使用文字输入。' : asrStat.mode === 'single' && ok && asrStat.available === false ? '系统识别暂不可用，请检查听写资源和网络后重试。' : asrStat.note === 'installing' ? '正在准备本机语音资源，完成后自动开始识别。' : ok
      ? '麦克风已就绪，开启自动聆听即可。'
      : (pending ? '系统弹窗正在等你点「允许」。点完这里会自动变绿。'
        : '第一次要允许两项：语音识别 + 麦克风。允许后如果还是灰的，把开关关掉再打开一次。');
  }
}

/* ═══════════ 外貌 ═══════════ */
let avatarEditorKey = '', expandedAvatarKey = '';
const avatarDescriptionDrafts = new Map();
function avatarButton(info, personal = false) {
  const button = document.createElement('button');
  button.dataset.key = info.key; button.type = 'button';
  button.className = personal ? 'avatarPick' : '';
  button.setAttribute('aria-pressed', String(info.key === avatarKey));
  button.title = [info.label || info.key, info.author].filter(Boolean).join(' · ');
  if (personal) {
    const name = document.createElement('span'); name.className = 'avatarName'; name.textContent = info.label || info.key;
    const state = document.createElement('span'); state.className = 'avatarUse'; state.textContent = info.key === avatarKey ? '使用中' : '点击使用';
    button.append(name, state);
  } else button.textContent = info.label || info.key;
  button.classList.toggle('on', info.key === avatarKey);
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); pickAvatar(info.key).catch(error => { $('avatarImportStatus').textContent = error.message; }); };
  return button;
}
function paintAvatars() {
  const row = $('avRow'), personal = $('personalAvatars'), editor = $('avatarEditor');
  if (!row || !personal || !editor) return;
  // A single editor follows the expanded model; using a model remains a separate action.
  $('stockAvatarEditor').append(editor);
  row.replaceChildren(); personal.replaceChildren();
  for (const info of AVATAR_LIST.filter(a => !a.personal)) row.append(avatarButton(info));
  const custom = AVATAR_LIST.filter(a => a.personal);
  if (!custom.some(a => a.key === expandedAvatarKey)) expandedAvatarKey = '';
  for (const info of custom) {
    const card = document.createElement('details'); card.className = 'avatarCard'; card.dataset.key = info.key;
    card.classList.toggle('active', info.key === avatarKey);
    const summary = document.createElement('summary'), fold = document.createElement('span');
    fold.className = 'avatarFold'; fold.textContent = '编辑'; summary.append(avatarButton(info, true), fold); card.append(summary);
    card.open = expandedAvatarKey === info.key;
    if (card.open) card.append(editor);
    card.ontoggle = () => {
      if (!card.isConnected) return;
      if (card.open) {
        expandedAvatarKey = info.key;
        for (const other of personal.querySelectorAll('.avatarCard')) if (other !== card) other.open = false;
        $('stockAppearanceDetails').open = false; card.append(editor); paintAvatarDetails();
      } else if (expandedAvatarKey === info.key) {
        expandedAvatarKey = ''; $('stockAvatarEditor').append(editor); paintAvatarDetails();
      }
    };
    personal.append(card);
  }
  if (!custom.length) {
    const empty = document.createElement('div'); empty.className = 'avatarEmpty';
    empty.textContent = '还没有定制外形，导入VRM文件后会显示在这里。'; personal.append(empty);
  }
  paintAvatarDetails();
}

function paintAvatarDetails() {
  const key = expandedAvatarKey || avatarKey, item = AVATAR_LIST.find(a => a.key === key), field = $('avatarDescription');
  if (field && (avatarEditorKey !== key || document.activeElement !== field)) field.value = avatarDescriptionDrafts.get(key) ?? cfg.avatarDescriptions?.[key] ?? item?.description ?? '';
  if (field) { field.dataset.key = key; autoGrow(field, 2); }
  const personal = !!item?.personal;
  if ($('deleteAvatar')) { $('deleteAvatar').disabled = !personal; $('deleteAvatar').hidden = !personal; }
  if ($('stockAppearanceDetails')) $('stockAppearanceDetails').hidden = !!AVATAR_LIST.find(a => a.key === avatarKey)?.personal;
  if (avatarEditorKey !== key) {
    avatarEditorKey = key;
    $('avatarDescriptionStatus').textContent = '';
  }
}

async function pickAvatar(k) {
  if (k === avatarKey) return;
  const previous = avatarKey;
  avatarKey = k; paintAvatars(); edit('avatar', k);
  const revision = edits.get('avatar').revision;
  try { await persist({ avatar: k }); log('换形象 ' + k); }
  catch (error) {
    if (edits.get('avatar')?.revision === revision) edits.delete('avatar');
    if (avatarKey === k) { avatarKey = cfg.avatar || previous; paintAvatars(); }
    throw error;
  }
}

let speakerState = { ready: false, enrolling: false, samples: 0 }, speakerRequestBusy = false;
function paintSpeaker(status) {
  if (!$('speakerEnabled') || !status) return;
  speakerState = status;
  $('speakerEnabled').checked = !!status.enabled;
  $('speakerEnabled').disabled = status.enrolling || speakerRequestBusy;
  $('speakerProgress').hidden = !status.enrolling;
  $('speakerProgress').setAttribute('aria-valuenow', String(status.percent || 0));
  $('speakerProgress').querySelector('i').style.width = (status.percent || 0) + '%';
  $('speakerToggle').hidden = !status.ready;
  $('speakerEnroll').disabled = speakerRequestBusy && !status.enrolling;
  $('speakerEnroll').textContent = status.enrolling ? '取消朗读' : status.ready ? '重新朗读' : '开始朗读';
  $('speakerReset').hidden = !status.samples || status.enrolling || speakerRequestBusy;
  $('speakerStatus').textContent = status.enrolling ? status.phase === 'waiting' ? '正在听，请开始朗读。' : `已听到你的声音 · ${status.seconds || 0} 秒 · 停下后自动完成` : status.note ? status.note : status.latest?.status === 'device-changed'
    ? '麦克风变了，请重新朗读。' : status.ready ? '已记住你的声音，可开启下方开关。' : '点击开始，再自然读完。';
}

function paintScale() {
  for (const b of $('sizeRow').children) b.classList.toggle('on', Math.abs(Number(b.dataset.k) - viewScale) < 0.01);
}
async function setScale(k) {
  viewScale = Number(k) || 1;
  paintScale();
  edit('window.scale', viewScale);
  await persist({ window: { scale: viewScale } }, ['window.scale'], () => window.pet.scale(Number(k)));
}

/* ═══════════ 大脑 ═══════════ */
function fillSelect(el, items, cur) {
  el.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.label;
    o.disabled = !!it.disabled;
    el.appendChild(o);
  }
  if (cur !== undefined && cur !== null) el.value = cur;
  if (el.selectedIndex < 0) el.selectedIndex = 0;
}

let brainDraft = null;
const KEY_MASK = globalThis.BunnyCredential.MASK;
function initBrainDraft() {
  const b = cfg.brain || {};
  brainDraft = {
    source: b.source === 'apikey' ? b.provider : 'workbuddy',
    workbuddy: { modelId: b.model || 'hy3', thinking: b.thinking || 'low' },
    profiles: JSON.parse(JSON.stringify(b.profiles || {})),
  };
  if (!['workbuddy', 'deepseek', 'openai', 'grok'].includes(brainDraft.source)) brainDraft.source = 'workbuddy';
}
function draftProfile() {
  if (brainDraft.source === 'workbuddy') return brainDraft.workbuddy;
  return brainDraft.profiles[brainDraft.source] ||= {};
}
function stashBrain() {
  const p = draftProfile();
  if ($('brainModel').value) p.modelId = $('brainModel').value;
  p.thinking = $('brainThinking').value;
  $('brainThinking').disabled = brainDraft.source !== 'workbuddy' && !brainCatalog().models.length;
  if (brainDraft.source !== 'workbuddy') {
    p.baseURL = $('brainURL').value.trim();
    const value = $('brainKeyInput').value;
    if (value !== KEY_MASK) { p.apiKey = value.trim(); p.hasApiKey = !!p.apiKey; }
  }
}
const brainPending = new Set();
function brainCatalog(id = brainDraft.source) {
  const cached = BRAIN.catalogs?.[id];
  if (id !== 'workbuddy') return cached?.at && cached.current ? cached : {at:0,models:[]};
  if (cached) return cached;
  const items = id === 'workbuddy' ? BRAIN.workbuddyModels : (BRAIN.providers.find(p => p.id === id)?.models || []).map(id => ({ id, label: id }));
  return { at: 0, models: items.map(m => ({ ...m, thinking: m.thinking || (id === 'workbuddy' ? BRAIN.workbuddyThinking : BRAIN.thinkingByModel?.[m.id]) || [{ id: 'auto', label: '模型默认' }] })) };
}
function paintThinking() {
  const p = draftProfile();
  $('brainThinkingRow').querySelector('span').textContent = brainDraft.source === 'grok' && /^grok-4\.20-multi-agent(?:$|-)/.test(p.modelId) ? '协作规模' : '思考';
  const options = brainDraft.source === 'workbuddy' ? brainCatalog().models.find(m => m.id === p.modelId)?.thinking || [{ id: 'auto', label: '模型默认' }] : ['none', 'low', 'medium', 'high'].map(id => ({ id, label: id }));
  fillSelect($('brainThinking'), options, p.thinking === 'off' ? 'none' : p.thinking || (brainDraft.source === 'workbuddy' ? 'auto' : 'none'));
  p.thinking = $('brainThinking').value;
  $('brainThinking').disabled = brainDraft.source !== 'workbuddy' && !brainCatalog().models.length;
  $('brainThinkingRow').classList.toggle('hidden', options.length < 2);
}
function paintModelFetch() {
  const busy = brainPending.has(brainDraft.source), list = brainCatalog();
  $('brainModelsBtn').disabled = busy;
  $('brainModelsBtn').textContent = busy ? '正在获取…' : '获取模型列表';
  $('brainModelsMeta').textContent = list.at ? `${list.models.length} 个模型 · 上次获取 ${new Date(list.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '尚未获取模型';
}
function paintBrain() {
  if (!brainDraft) initBrainDraft();
  const id = brainDraft.source, p = draftProfile(), wb = id === 'workbuddy';
  $('brainSource').value = id;
  $('brainWb').classList.toggle('on', wb);
  $('brainKey').classList.toggle('on', !wb);
  $('brainModelRow').insertAdjacentElement(wb ? 'afterend' : 'beforebegin', $('brainModelsActions'));
  $('brainModelRow').classList.toggle('externalModel', !wb);
  $('brainModelsActions').classList.toggle('beforeModel', !wb);
  const provider = BRAIN.providers.find(x => x.id === id);
  const models = brainCatalog().models.slice();
  if (!p.modelId) p.modelId = models[0]?.id || '';
  if (wb && p.modelId && !models.some(x => x.id === p.modelId)) models.push({ id: p.modelId, label: p.modelId + '（已保存）' });
  fillSelect($('brainModel'), models.length ? models : [{id:'',label:'请先获取模型列表'}], p.modelId);
  $('brainModel').disabled = !models.length;
  if (!wb && models.length) p.modelId = $('brainModel').value;
  $('brainURL').value = p.baseURL || provider?.baseURL || '';
  paintCredential($('brainKeyInput'), p.apiKey || (p.hasApiKey ? KEY_MASK : ''), {preview:p.apiKeyPreview});
  $('brainHint').textContent = wb ? '使用当前登录账号的模型。思考选项按所选模型提供；额度以 WorkBuddy 账号为准。' : provider?.hint || '';
  paintThinking(); paintModelFetch(); paintBrainHint();
}
function paintBrainHint() {
  const model = $('brainModel').value, id = brainDraft.source;
  let text = id === 'workbuddy' ? '使用已登录的 WorkBuddy。' : '填写密钥，获取模型后选择并保存。';
  if (id === 'grok' && /^grok-4\.(?:[567]|20)(?:$|-)/.test(model) && $('brainThinking').value === 'none') text = '此模型不能关闭思考，none 使用最低的 low。';
  if (id === 'deepseek' && $('brainThinking').value === 'medium') text = '此模型的 medium 按官方规则使用 high。';
  if (id === 'openai' && /^(?:gpt-5(?:-|$)|o[134](?:[.-]|$))/.test(model) && $('brainThinking').value === 'none') text = '此模型不能关闭思考，none 使用最低的 low。';
  $('brainHint').textContent = text;
}
async function refreshBrainModels() {
  stashBrain();
  const source = brainDraft.source, keyAtStart = $('brainKeyInput').value, urlAtStart = $('brainURL').value;
  brainPending.add(source); paintModelFetch();
  $('brainStatus').textContent = '正在获取当前账号可用模型…';
  try {
    const r = await window.pet.brainModels(collectBrain());
    if (!r.ok) throw new Error(r.error);
    if (brainDraft.source !== source) return;
    if ($('brainKeyInput').value !== keyAtStart || $('brainURL').value !== urlAtStart) {
      $('brainStatus').textContent = '密钥已更改，请使用新密钥重新获取列表。'; return;
    }
    BRAIN.catalogs ||= {}; BRAIN.catalogs[source] = {...r.catalog,current:true};
    const p = draftProfile();
    if (!r.catalog.models.some(m => m.id === p.modelId)) { p.modelId = r.catalog.models[0]?.id || ''; p.thinking = 'auto'; }
    edit('brain', true); paintBrain();
    $('brainStatus').textContent = `已获取 ${r.catalog.models.length} 个模型。选择模型和思考后保存，才会用于对话。`;
  } catch (e) {
    if (brainDraft.source === source) $('brainStatus').textContent = '获取失败：' + e.message;
  } finally { brainPending.delete(source); paintModelFetch(); }
}

function collectBrain() {
  stashBrain();
  const profiles = {};
  for (const [id, p] of Object.entries(brainDraft.profiles)) {
    if (!BRAIN.providers.some(provider => provider.id === id)) continue;
    profiles[id] = { modelId: p.modelId, thinking: p.thinking || 'none', baseURL: p.baseURL || BRAIN.providers.find(x => x.id === id)?.baseURL };
    if (typeof p.apiKey === 'string') profiles[id].apiKey = p.apiKey;
  }
  return { source: brainDraft.source === 'workbuddy' ? 'workbuddy' : 'apikey',
    model: brainDraft.workbuddy.modelId || 'hy3', thinking: brainDraft.workbuddy.thinking,
    provider: brainDraft.source === 'workbuddy' ? (cfg.brain.provider || 'deepseek') : brainDraft.source,
    profiles };
}

/* ═══════════ 嘴巴 ═══════════ */
const ENGINE_HINT = {
  system: 'macOS 自带，离线可用。',
  qwen: '本地运行，支持中英文。',
  http: '继续使用已有接口。',
  doubao: '填写 API Key，选择模型和音色后试听。',
  remote: '使用同一局域网的 CHP 服务；不可用时回退系统语音。',
};
function paintTts() {
  const t = cfg.tts || {};
  const eng = t.engine || 'system';
  const row = $('ttsEngine');
  if (!row.childElementCount) {
    for (const e of TTSI.engines.filter(e => !e.legacy || cfg.tts.http?.profile?.url)) {
      const b = document.createElement('button');
      b.dataset.e = e.id;
      b.textContent = e.label;
      b.addEventListener('click', async () => {
        edit('tts.engine', e.id); ttsDraft.engine = e.id; paintTts();
        if (e.id === 'http' && !cfg.tts.http?.profile?.url) { $('sfNote').textContent = '请先填写接口，点击“保存并使用”后生效。'; return; }
        try { await persist(e.id === 'doubao' ? { tts: { engine: e.id, doubao: doubaoPatch() } } : { tts: { engine: e.id } }); }
        catch (err) { $('sfNote').textContent = '切换失败：' + err.message; }
      });
      row.appendChild(b);
    }
  }
  for (const b of row.children) b.classList.toggle('on', b.dataset.e === ttsDraft.engine);
  for (const b of row.children) if (b.dataset.e === 'qwen') { b.disabled = TTSI.qwen?.available === false; b.title = TTSI.qwen?.reason || ''; }
  $('ttsHint').textContent = ENGINE_HINT[ttsDraft.engine] || '';
  $('ttsCurrent').textContent = cfg.tts.enabled ? ({ system: '系统语音', qwen: 'Qwen 本地', remote: 'CHP', http: '已有接口', doubao: '豆包语音' }[ttsDraft.engine] || '系统语音') : '语音已关闭';
  $('ttsSystem').classList.toggle('on', ttsDraft.engine === 'system');
  $('ttsQwen').classList.toggle('on', ttsDraft.engine === 'qwen');
  $('ttsRemote').classList.toggle('on', ttsDraft.engine === 'remote');
  $('ttsDoubao').classList.toggle('on', ttsDraft.engine === 'doubao');
  paintDoubao();
  $('ttsHTTP').classList.toggle('on', ttsDraft.engine === 'http');

  fillSelect($('sysVoice'), (TTSI.systemVoices || []).map((v) => ({ id: v.id, label: v.label || v.id + '　' + v.lang })), ttsDraft.voice);
  $('sysRate').value = ttsDraft.rate;
  $('sysRateVal').textContent = ttsDraft.rate;

  paintChp();
  paintQwen();
  paintDl(TTSI.dl || {});
}

function doubaoPatch() {
  const patch = {};
  for (const [id, key] of [['doubaoURL', 'url'], ['doubaoModel', 'model'], ['doubaoVoice', 'voice'], ['doubaoKey', 'apiKey']]) {
    const value = $(id).value.trim(); if (value !== KEY_MASK) patch[key] = value;
  }
  return patch;
}
let doubaoCatalogVisible = false;
function paintDoubao() {
  const defaults = TTSI.doubao || {}, c = cfg.tts.doubao || {};
  fillSelect($('doubaoModel'), defaults.models || [], pendingValue('tts.doubao.model', c.model || 'seed-tts-2.0'));
  paintCredential($('doubaoKey'), pendingValue('tts.doubao.apiKey', c.hasApiKey ? KEY_MASK : ''), {preview:c.apiKeyPreview});
  $('doubaoURL').value = pendingValue('tts.doubao.url', c.url || defaults.url || '');
  $('doubaoVoice').value = pendingValue('tts.doubao.voice', c.voice || '');
  const cloned = $('doubaoModel').value === 'seed-icl-2.0';
  $('doubaoFetch').disabled = cloned;
  $('doubaoVoiceRow').hidden = cloned || !doubaoCatalogVisible;
  const voices = [{ id: '', label: '选择音色，或在下方手填' }, ...(defaults.voices || [])];
  fillSelect($('doubaoVoices'), voices, voices.some(v => v.id === $('doubaoVoice').value) ? $('doubaoVoice').value : '');
  $('doubaoStatus').textContent = cloned ? '填写你的复刻音色编号后试听。' : doubaoCatalogVisible ? '已载入官方公共音色，试听确认是否可用。' : '选择音色后，点击底部试听。';
}
let chpCatalog = null, chpGeneration = 0, chpPending = false;
function chpPatch() {
  const patch = { baseURL: $('rmUrl').value.trim() };
  if (!$('rmKey').value.includes('•')) patch.apiKey = $('rmKey').value.trim();
  return patch;
}
function paintChp() {
  $('chpFetch').disabled = chpPending;
  $('chpFetch').textContent = chpPending ? '正在获取…' : '获取模型与音色';
  fillSelect($('rmModel'), chpCatalog ? [{ id: chpCatalog.model, label: chpCatalog.model }] : [{ id: '', label: '请先获取模型' }], chpCatalog?.model);
  $('chpModelNote').textContent = chpCatalog ? `服务端加载 · ${chpCatalog.file || chpCatalog.model}` : '模型由 CHP 服务端加载。';
  const savedVoice = ttsDraft.chpVoice || cfg.tts.chp?.voice;
  fillSelect($('rmVoice'), chpCatalog?.voices || [{ id: savedVoice || '', label: savedVoice ? savedVoice + '（已保存，获取音色可刷新）' : '请先获取音色' }], savedVoice);
  $('rmVoice').disabled = !chpCatalog?.voices?.length;
}
async function fetchChp() {
  const generation = ++chpGeneration, patch = chpPatch();
  chpPending = true; chpCatalog = null; paintChp();
  $('chpStatus').textContent = '正在连接 CHP 并获取语音能力…';
  try {
    const result = await window.pet.chpDiscover(patch);
    if (generation !== chpGeneration) return;
    if (!result.ok) throw new Error(result.error);
    chpCatalog = result.catalog;
    const oldVoice = cfg.tts.chp?.voice;
    const voice = chpCatalog.voices.some(v => v.id === oldVoice) ? oldVoice : chpCatalog.voices[0].id;
    edit('tts.chp.voice', voice);
    await persist({ tts: { ...patch, chp: { voice } } });
    if (generation !== chpGeneration) return;
    $('chpStatus').textContent = `已连接${chpCatalog.version ? ' · CHP ' + chpCatalog.version : ''} · ${chpCatalog.voices.length} 个音色`;
  } catch (e) {
    if (generation === chpGeneration) { chpCatalog = null; $('chpStatus').textContent = '获取失败：' + e.message; }
  } finally { if (generation === chpGeneration) { chpPending = false; paintChp(); } }
}
function invalidateChp() {
  chpGeneration++; chpPending = false; chpCatalog = null; paintChp();
  $('chpStatus').textContent = '连接信息已更改，请重新获取模型与音色。';
}

function paintQwen() {
  const q = TTSI.qwen || {};
  const pill = $('qwenPill');
  const ready = !!q.ready;
  pill.textContent = ready ? '模型就绪' : (q.downloaded ? '缺少引擎' : '待下载');
  pill.className = 'pill ' + (ready ? 'ok' : 'wait');
  const names = ready && q.voices?.length ? q.voices : [{ id: '', label: q.downloaded ? '语音引擎未就绪' : '请先下载模型' }];
  fillSelect($('qwenVoice'), names, ttsDraft.qwenVoice || 'serena');
  $('qwenVoice').disabled = !ready || !q.voices?.length;
  if (!q.hasRuntime) {
    $('qwenTip').textContent = '本地语音引擎缺失，请重新安装应用。';
  }
}
let dlTimer = null;
function paintDl(st) {
  if (TTSI.qwen?.available === false) { $('qwenGo').disabled = true; $('qwenTip').textContent = TTSI.qwen.reason; $('qwenVoice').disabled = true; return; }

  clearTimeout(dlTimer);
  TTSI.dl = st;
  const total = st.total || 1329512960;
  const pct = st.running || st.done ? Math.min(100, Math.round((st.bytes / total) * 100)) : (TTSI.qwen.ready ? 100 : 0);
  $('qwenBar').style.width = pct + '%';
  $('qwenGo').textContent = st.running ? (st.phase === 'selecting' ? '正在选择下载源…' : st.phase === 'verifying' ? '正在校验…' : `下载中 ${pct}%`) : (TTSI.qwen.downloaded ? '获取音色' : '下载模型');
  $('qwenGo').disabled = !!st.running;
  $('qwenDelete').disabled = !TTSI.qwen.hasFiles && !TTSI.qwen.downloaded && !st.running;
  if (st.err) $('qwenTip').textContent = '下载中断：' + st.err;
  else if (st.running) $('qwenTip').textContent = st.phase === 'selecting' ? '正在检测可用下载地址…' : `${st.source || '本地文件'} · ${st.phase === 'verifying' ? '校验完整性' : '下载'} ${st.done + 1}/${st.count || 1} · ${(st.bytes / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`;
  else if (TTSI.qwen.ready) $('qwenTip').textContent = '模型已就绪。选择音色后，可在下方试听。';
  else if (!TTSI.qwen.hasRuntime) $('qwenTip').textContent = '本地语音引擎缺失，请重新安装应用。';
  else $('qwenTip').textContent = '语音引擎已安装。点击下载模型，完成后会自动校验。';
  if (st.running) dlTimer = setTimeout(refreshDl, 1200);
}
async function refreshDl() {
  const st = await window.pet.ttsDlState();
  paintDl(st);
  if (!st.running) {
    await refreshVoices();
  }
}
async function refreshVoices(announce = false) {
  TTSI = await window.pet.ttsInfo();
  if (TTSI.config) syncTts(TTSI.config); else paintTts();
  if (announce) $('sfNote').textContent = TTSI.qwen.ready
    ? '已刷新音色。'
    : (TTSI.qwen.downloaded ? '语音引擎未就绪。' : '请先下载模型。');
}

/* ═══════════ 保存 ═══════════ */
/* 语音设置即时生效，主进程的实际配置是唯一来源。 */
let ttsDraft = { engine: 'system', voice: '', rate: 200, qwenVoice: 'serena' };
function syncTts(c, acknowledged = []) {
  if ((Number(c.settingsRevision) || 0) < (Number(cfg?.settingsRevision) || 0)) return;
  const previous = cfg, previousFallback = cfg?.tts?.lastFallback?.at;
  cfg = c;
  ttsDraft = {
    engine: pendingValue('tts.engine', 'system'), voice: pendingValue('tts.voice', ''),
    rate: pendingValue('tts.rate', 200), qwenVoice: pendingValue('tts.qwen.voice', 'serena'),
    chpVoice: pendingValue('tts.chp.voice', ''),
  };
  for (const [id, path, fallback] of [['setName', 'buddy.name', 'baby'], ['setOwnerName', 'buddy.ownerName', '主人'], ['rmUrl', 'tts.baseURL', '']])
    if (!edits.has(path)) $(id).value = readPath(c, path) ?? fallback;
  paintSceneProfile(c);
  if (!edits.has('tts.apiKey')) paintCredential($('rmKey'), c.tts.hasApiKey ? KEY_MASK : '', {preview:c.tts.apiKeyPreview});
  $('setAlways').checked = pendingValue('voice.alwaysListen', false);
  $('setJudge').checked = pendingValue('asr.judge', true);
  $('setWakeOnly').checked = pendingValue('asr.wakeOnly', false);
  if (!edits.has('asr.wakeAliases')) $('setWakeAliases').value = (c.asr.wakeAliases || []).join('，');
  $('setTtsOn').checked = pendingValue('tts.enabled', true);
  if (!edits.has('avatar') && (previous?.avatar !== c.avatar || acknowledged.includes('avatar'))) {
    avatarKey = AVATAR_LIST.find(a => a.key === c.avatar || a.file === c.avatar || a.label === c.avatar)?.key || avatarKey;
    paintAvatars();
  }
  if (!edits.has('window.scale')) { viewScale = c.window?.scale || 1; paintScale(); }
  if (!edits.has('brain') && (JSON.stringify(previous?.brain) !== JSON.stringify(c.brain) || acknowledged.includes('brain'))) {
    initBrainDraft(); paintBrain();
  }
  paintTts();
  selfSettings.paint();
  if (c.tts.engine === 'system' && c.tts.lastFallback?.at && c.tts.lastFallback.at !== previousFallback)
    $('sfNote').textContent = '已切换到系统默认语音：' + c.tts.lastFallback.reason;
}

function fillForm() {
  const c = cfg;
  $('setName').value = c.buddy.name || '';
  void selfSettings.load();
  $('setOwnerName').value = c.buddy.ownerName || '主人';
  selfSettings.paint();
  $('setAlways').checked = !!(c.voice && c.voice.alwaysListen);
  $('setJudge').checked = !(c.asr && c.asr.judge === false);
  $('setWakeOnly').checked = !!c.asr?.wakeOnly;
  $('setWakeAliases').value = (c.asr?.wakeAliases || []).join('，');
  $('setTtsOn').checked = !!c.tts.enabled;
  const t = c.tts || {};
  ttsDraft = {
    engine: t.engine || 'system',
    voice: t.voice || '',
    rate: t.rate || 200,
    qwenVoice: (t.qwen && t.qwen.voice) || 'serena',
    chpVoice: t.chp?.voice || '',
  };
  $('rmUrl').value = t.baseURL || '';
  paintCredential($('rmKey'), t.hasApiKey ? KEY_MASK : '', {preview:t.apiKeyPreview});
  chpCatalog = TTSI.chp || null;
  paintAvatars();
  paintScale();
  paintBrain();
  paintSceneProfile(c);
  paintTts();
}

async function save() {
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    if (edits.has('brain') && brainDraft.source !== 'workbuddy' && !$('brainModel').value) throw new Error('请先获取模型列表并选择模型');
    const { patch, paths } = draftPatch();
    await selfSettings.saveInputs();
    await persist(patch, paths);
    $('sfNote').textContent = edits.size ? '当前设置已保存，新的编辑尚未保存。' : '设置已保存并生效。';
    btn.textContent = '已保存 ✓';
    setTimeout(() => { btn.textContent = '保存'; }, 1400);
  } finally { btn.disabled = false; }
}

/* ═══════════ 动作库 ═══════════ */
let motionSaving = false;
const motionCollapsed = new Set();
async function setDisabledMotions(disabled) {
  if (motionSaving) return;
  motionSaving = true; buildMotionList();
  try {
    cfg = await window.pet.config({ motions: { disabled } });
    if (disabled.includes(curMotion)) curMotion = '';
    $('mStatus').textContent = '已保存 · 至少保留一个空闲动作';
  } catch (e) { $('mStatus').textContent = e.message; }
  finally { motionSaving = false; buildMotionList(); }
}
function motionButton(label, action) {
  const button = document.createElement('button'); button.className = 'mini'; button.textContent = label;
  button.disabled = motionSaving; button.onclick = action; return button;
}
function motionField(parent, label, value, type = 'text') {
  const row = document.createElement('label'); row.className = 'motionField';
  const caption = document.createElement('span'); caption.textContent = label;
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  if (type === 'checkbox') { input.checked = !!value; input.setAttribute('role', 'switch'); } else input.value = value ?? '';
  input.setAttribute('aria-label', label); row.append(caption, input); parent.append(row); return input;
}
function applyMotionView(view) {
  MOTIONS = view.motions || MOTIONS; MOTION_GROUPS = view.categories || MOTION_GROUPS;
  const select = $('mImportGroup'), previous = select.value; select.replaceChildren();
  for (const group of MOTION_GROUPS) { const option = document.createElement('option'); option.value = group.id; option.textContent = group.label; select.append(option); }
  if (MOTION_GROUPS.some(g => g.id === previous)) select.value = previous;
}
async function motionOperation(change) {
  if (motionSaving) return;
  motionSaving = true; $('mStatus').textContent = '正在保存…';
  try { applyMotionView(await window.pet.motionEdit(change)); $('mStatus').textContent = '动作库已保存'; return true; }
  catch (error) { $('mStatus').textContent = error.message; return false; }
  finally { motionSaving = false; buildMotionList(); }
}
function motionIcon(symbol, label, action) {
  const button = motionButton(symbol, action); button.classList.add('motionIcon'); button.title = label; button.setAttribute('aria-label', label); return button;
}
function openMotionEditor(entity, category = false) {
  const body = $('motionDialogBody'); body.replaceChildren(); $('motionDialogStatus').textContent = '';
  $('motionDialogTitle').textContent = category ? '编辑分类' : '编辑动作';
  const label = motionField(body, '名称', entity.label), meaning = motionField(body, '含义', category ? entity.description : entity.use, 'textarea');
  label.maxLength = category ? 40 : 80; meaning.maxLength = category ? 240 : 300;
  let slot, loop, idle;
  if (!category) {
    const row = document.createElement('label'); row.className = 'motionField'; row.textContent = '分类';
    slot = document.createElement('select'); slot.setAttribute('aria-label', '所属分类'); fillSelect(slot, MOTION_GROUPS.map(g => ({ id:g.id, label:g.label })), entity.slot); row.append(slot); body.append(row);
    loop = motionField(body, '循环播放', entity.loop, 'checkbox'); idle = motionField(body, '可作待机', entity.idle, 'checkbox');
  }
  const expected = Object.fromEntries((category ? ['label','description'] : ['label','use','slot','loop','idle']).map(k=>[k,entity[k]]));
  $('motionDialogSave').onclick = async () => {
    $('motionDialogSave').disabled = $('motionDialogClose').disabled = true;
    try {
      const ok = await motionOperation(category ? { type:'category-update', id:entity.id, label:label.value, description:meaning.value, expected }
        : { type:'motion-update', key:entity.key, label:label.value, use:meaning.value, slot:slot.value, loop:loop.checked, idle:idle.checked, expected });
      if (ok) $('motionDialog').close(); else $('motionDialogStatus').textContent = $('mStatus').textContent;
    } finally { $('motionDialogSave').disabled = $('motionDialogClose').disabled = false; }
  };
  $('motionDialogClose').onclick = () => $('motionDialog').close();
  $('motionDialog').showModal(); label.focus();
}
function deleteMotion(motion) {
  if (confirm(motion.personal ? '删除这个动作？文件会移到废纸篓。' : '移除这个动作？之后可恢复内置动作。')) void motionOperation({ type:'motion-delete', key:motion.key });
}
function buildMotionList() {
  const box = $('motionList'); if (!box) return; const scroll = box.scrollTop; box.replaceChildren();
  const disabled = new Set(cfg.motions?.disabled || []);
  const idleCount = MOTIONS.filter(m => m.idle && !disabled.has(m.key) && m.weight > 0).length;
  for (const group of MOTION_GROUPS) {
    const items = MOTIONS.filter(m => m.slot === group.id), details = document.createElement('details');
    details.className = 'motionGroup'; details.dataset.slot = group.id; details.open = !motionCollapsed.has(group.id);
    details.ontoggle = () => details.open ? motionCollapsed.delete(group.id) : motionCollapsed.add(group.id);
    const title = document.createElement('summary'), caption = document.createElement('span'); caption.className = 'motionGroupName'; caption.textContent = `${group.label} · ${items.length}`; title.append(caption);
    const categoryEdit = motionIcon('✎', '编辑分类' + group.label, event => { event.preventDefault(); event.stopPropagation(); openMotionEditor(group, true); });
    const categoryToggle = motionIcon('⏻', '启用或停用分类' + group.label, event => {
      event.preventDefault(); event.stopPropagation(); const next = new Set(cfg.motions?.disabled || []), turnOn = items.every(m=>next.has(m.key));
      for (const m of items) turnOn ? next.delete(m.key) : next.add(m.key); void setDisabledMotions([...next]);
    });
    categoryToggle.setAttribute('aria-pressed', String(items.some(m=>!disabled.has(m.key)))); categoryToggle.disabled ||= !items.length;
    const categoryDelete = motionIcon('×', '删除分类' + group.label, event => { event.preventDefault(); event.stopPropagation(); if(confirm('删除分类？其中动作会移入其他分类。')) void motionOperation({type:'category-delete',id:group.id}); });
    title.append(categoryEdit,categoryToggle,categoryDelete); details.append(title);
    const total = items.filter(m=>!disabled.has(m.key)).reduce((n,m)=>n+Number(m.weight??1),0), inputs = new Map();
    const repaintRatios = weights => {
      for (const [key, controls] of inputs) { const value = weights[key] ?? 0; controls.slider.value = value; controls.value.textContent = `${Math.round(value)}%`; }
    };
    for (const motion of items) {
      const enabled = !disabled.has(motion.key), row = document.createElement('div'); row.className = 'motionRow' + (enabled ? '' : ' disabled'); row.dataset.motion = motion.key;
      const preview = document.createElement('button'); preview.className = 'mItem' + (motion.key === curMotion ? ' on' : ''); preview.dataset.key = motion.key; preview.disabled = !enabled; preview.title = motion.use || motion.label;
      const name = document.createElement('span'); name.className = 'nm'; name.textContent = motion.label; preview.append(name);
      preview.onclick = () => { curMotion = motion.key; window.pet.panelMotion(motion.key); for(const b of box.querySelectorAll('.mItem')) b.classList.toggle('on',b.dataset.key === curMotion); };
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = 100; slider.step = 1; slider.className = 'motionRatio'; slider.disabled = !enabled || motionSaving; slider.setAttribute('aria-label', motion.label + '概率百分比');
      const probability = document.createElement('span'); probability.className = 'motionChance'; const value = enabled && total ? motion.weight / total * 100 : 0; slider.value = value; probability.textContent = `${Math.round(value)}%`;
      inputs.set(motion.key, {slider,value:probability});
      slider.oninput = () => { const weights = globalThis.BunnyMotion.probabilities(MOTIONS.map(m=>({...m,enabled:!disabled.has(m.key)})),motion.key,Number(slider.value)); repaintRatios(weights); };
      slider.onchange = () => void motionOperation({type:'motion-probability',key:motion.key,percent:Number(slider.value)});
      const editButton = motionIcon('✎', '编辑动作' + motion.label, () => openMotionEditor(motion));
      const toggle = motionIcon('⏻', (enabled ? '停用' : '启用') + motion.label, () => { const next = new Set(cfg.motions?.disabled || []); enabled ? next.add(motion.key) : next.delete(motion.key); void setDisabledMotions([...next]); });
      toggle.setAttribute('aria-pressed',String(enabled)); toggle.disabled ||= !!motion.idle && enabled && idleCount === 1 && motion.weight > 0;
      const remove = motionIcon('×', '删除动作' + motion.label, () => deleteMotion(motion));
      row.append(preview,slider,probability,editButton,toggle,remove); details.append(row);
    }
    if (!items.length) { const empty = document.createElement('p'); empty.className='note'; empty.textContent='还没有动作，可以导入VRMA。'; details.append(empty); }
    box.append(details);
  }
  box.scrollTop = scroll;
  $('mCount').textContent = `启用 ${MOTIONS.filter(m=>!disabled.has(m.key)).length}/${MOTIONS.length}`;
  $('mAll').disabled = motionSaving || disabled.size === 0;
}

/* ═══════════ 启动 ═══════════ */
(async function boot() {
  const init = await window.pet.panelInit();
  cfg = init.config;
  AVATAR_LIST = init.avatars || [];
  MOTIONS = init.motions || [];
  MOTION_GROUPS = init.motionGroups || [];
  avatarKey = init.avatar || (AVATAR_LIST[0] && AVATAR_LIST[0].key) || '';
  viewScale = (cfg.window && cfg.window.scale) || 0.5;

  if (which === 'settings') {
    await mountPortability(window.pet);
    $('importAvatar').onclick = async () => {
      try { const r = await window.pet.avatarImport(); if (r.cancelled) return; AVATAR_LIST = r.avatars; paintAvatars(); await pickAvatar(r.key); $('avatarImportStatus').textContent = '已导入个人模型，仅本机使用。'; }
      catch (e) { $('avatarImportStatus').textContent = e.message; }
    };
    $('stockAppearanceDetails').ontoggle = () => {
      if (!$('stockAppearanceDetails').open) return;
      expandedAvatarKey = '';
      for (const card of $('personalAvatars').querySelectorAll('.avatarCard')) card.open = false;
      $('stockAvatarEditor').append($('avatarEditor')); paintAvatarDetails();
    };
    $('avatarDescription').addEventListener('input', () => { const field = $('avatarDescription'); avatarDescriptionDrafts.set(field.dataset.key, field.value); autoGrow(field, 2); });
    addEventListener('resize', () => autoGrow($('avatarDescription'), 2));
    $('avatarDescription').addEventListener('change', async () => {
      const key = $('avatarDescription').dataset.key, description = $('avatarDescription').value;
      avatarDescriptionDrafts.set(key, description);
      try { const saved = await window.pet.config({ avatarDescriptions: { [key]: description } }); if ((saved.settingsRevision || 0) >= (cfg.settingsRevision || 0)) cfg = saved; if (avatarDescriptionDrafts.get(key) === description) avatarDescriptionDrafts.delete(key); if (avatarEditorKey === key) $('avatarDescriptionStatus').textContent = '已保存'; }
      catch (error) { if (avatarEditorKey === key) $('avatarDescriptionStatus').textContent = error.message; }
    });
    $('describeAvatar').onclick = async () => {
      $('avatarDescriptionStatus').textContent = '正在识别角色外观…';
      try { const key = avatarEditorKey; if (key !== avatarKey) await pickAvatar(key); const r = await window.pet.avatarDescribeRequest(key); if (!r.ok) $('avatarDescriptionStatus').textContent = r.error; }
      catch (error) { $('avatarDescriptionStatus').textContent = error.message; }
    };
    $('deleteAvatar').onclick = async () => {
      const key = avatarEditorKey, item = AVATAR_LIST.find(a => a.key === key);
      if (!item?.personal || !confirm('删除这个个人模型？文件会移到废纸篓，内置模型不会受影响。')) return;
      try { const r = await window.pet.avatarDelete(key); AVATAR_LIST = r.avatars; avatarKey = r.avatar; paintAvatars(); $('avatarImportStatus').textContent = '个人模型已移到废纸篓。'; }
      catch (error) { $('avatarImportStatus').textContent = error.message; }
    };
    BRAIN = await window.pet.brainInfo();
    TTSI = await window.pet.ttsInfo();
    if (TTSI.config) cfg = TTSI.config;
    fillForm();
    window.pet.on((ev) => {
      if (ev.type === 'config' && ev.config && (Number(ev.config.settingsRevision) || 0) >= (Number(cfg.settingsRevision) || 0)) { syncTts(ev.config); paintAvatarDetails(); }
      if (ev.type === 'avatars' && Array.isArray(ev.avatars)) { AVATAR_LIST = ev.avatars; paintAvatars(); }
      if (ev.type === 'speaker-status') paintSpeaker(ev);
      if (ev.type === 'avatar-description' && ev.key === avatarEditorKey) {
        if (ev.ok) { cfg.avatarDescriptions ||= {}; cfg.avatarDescriptions[ev.key] = ev.description; paintAvatarDetails(); }
        $('avatarDescriptionStatus').textContent = ev.ok ? '已识别并保存' : '自动识别未完成：' + ev.error + '，也可以手工填写。';
      }
    });
    paintPerm(init.asr || null);
    showTab(init.storage?.ok === false ? 'data' : init.connection?.ready === false && cfg.brain.source !== 'apikey' ? 'brain' : 'look');

    $('sizeRow').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (b) setScale(Number(b.dataset.k)).catch(e => { $('sfNote').textContent = e.message; });
    });
    $('brainSource').addEventListener('change', () => {
      stashBrain();
      brainDraft.source = $('brainSource').value;
      edit('brain', true);
      paintBrain();
      $('brainStatus').textContent = '切换的是草稿，点保存后用于对话。';
    });
    $('brainModelsBtn').addEventListener('click', refreshBrainModels);
    $('openWorkBuddy').addEventListener('click', async () => {
      const result = await window.pet.workbuddyOpen();
      $('brainStatus').textContent = result.ok ? 'WorkBuddy 已打开。登录后获取模型列表。' : result.error;
    });
    const connectionEdited = () => { stashBrain(); edit('brain', true); BRAIN.catalogs ||= {}; delete BRAIN.catalogs[brainDraft.source]; fillSelect($('brainModel'),[{id:'',label:'请先获取模型列表'}],''); $('brainModel').disabled = true; paintThinking(); paintModelFetch(); $('brainHint').textContent = '填写密钥，获取模型后选择并保存。'; $('brainStatus').textContent = '地址或密钥已更改，请重新获取模型列表。'; };
    $('brainKeyInput').addEventListener('input', connectionEdited);
    $('brainThinking').addEventListener('change', () => { edit('brain', true); paintBrainHint(); });
    $('brainURL').addEventListener('input', connectionEdited);
    $('panelScene').addEventListener('click', event => {
      const button = event.target.closest('button[data-scene]');
      if (button) changePanelScene(button.dataset.scene);
    });
    for (const [id, path] of [['setName', 'buddy.name'], ['setOwnerName', 'buddy.ownerName']])
      $(id).addEventListener('input', () => edit(path, $(id).value));
    $('setAlways').addEventListener('change', () => edit('voice.alwaysListen', $('setAlways').checked));
    $('setWakeAliases').addEventListener('input', () => edit('asr.wakeAliases', $('setWakeAliases').value.split(/[,，、]/).map(s=>s.trim()).filter(Boolean)));
    $('setJudge').addEventListener('change', () => edit('asr.judge', $('setJudge').checked));
    $('setWakeOnly').addEventListener('change', async () => {
      try { await persist({asr:{wakeOnly:$('setWakeOnly').checked}}); } catch(error) { $('setWakeOnly').checked = !!cfg.asr.wakeOnly; $('permTip').textContent = error.message; }
    });
    if (window.pet.speakerStatus) paintSpeaker(await window.pet.speakerStatus());
    $('speakerEnabled').onchange = async () => {
      try { await persist({ asr: { ownerOnly: $('speakerEnabled').checked } }); paintSpeaker(await window.pet.speakerStatus()); }
      catch (error) { paintSpeaker(await window.pet.speakerStatus()); $('speakerStatus').textContent = error.message; }
    };
    $('speakerEnroll').onclick = async () => {
      if (speakerState.enrolling) { await window.pet.speakerCancel(); return; }
      if (speakerRequestBusy) return;
      speakerRequestBusy = true; paintSpeaker(speakerState); $('speakerStatus').textContent = '正在准备，请稍等…';
      let failure;
      try { paintSpeaker(await window.pet.speakerEnroll()); }
      catch (error) { failure = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
      finally { speakerRequestBusy = false; paintSpeaker(await window.pet.speakerStatus()); if (failure) $('speakerStatus').textContent = failure; }
    };
    $('speakerReset').onclick = async () => {
      if (!confirm('清除已记住的声音？')) return;
      try { paintSpeaker(await window.pet.speakerReset()); } catch (error) { $('speakerStatus').textContent = error.message; }
    };
    $('brainModel').addEventListener('change', () => {
      const p = draftProfile();
      if ($('brainModel').value) p.modelId = $('brainModel').value;
      p.thinking = brainDraft.source === 'workbuddy' ? 'auto' : 'none'; edit('brain', true);
      paintThinking(); paintBrainHint();
      $('brainStatus').textContent = '模型已选择，可测试连接。';
    });
    $('brainTestBtn').addEventListener('click', async () => {
      if (brainDraft.source !== 'workbuddy' && !$('brainModel').value) { $('brainStatus').textContent = '请先获取模型列表并选择模型'; return; }
      const btn = $('brainTestBtn'); btn.disabled = true;
      $('brainStatus').textContent = '正在用当前选择测试连接…';
      try {
        const r = await window.pet.brainTest(collectBrain());
        const name = brainDraft.source === 'workbuddy' ? 'WorkBuddy' : BRAIN.providers.find((p) => p.id === brainDraft.source)?.label;
        $('brainStatus').textContent = r.ok
          ? `${name} 已连通 · ${r.model} · ${(r.ms / 1000).toFixed(1)} 秒${r.credit === 0 ? ' · 本次消耗 0 额度' : ''}`
          : '未连通：' + r.error;
      } catch (e) { $('brainStatus').textContent = '测试失败：' + e.message; }
      finally { btn.disabled = false; }
    });
    const live = async patch => {
      for (const path of leafPaths(patch)) edit(path, readPath(patch, path));
      try { await persist(patch); }
      catch (e) { $('sfNote').textContent = '语音设置失败：' + e.message; }
    };
    for (const [id, key] of [['doubaoURL', 'url'], ['doubaoModel', 'model'], ['doubaoVoice', 'voice'], ['doubaoKey', 'apiKey']]) {
      $(id).addEventListener(key === 'model' ? 'change' : 'input', () => {
        edit('tts.doubao.' + key, $(id).value.trim());
        if (key === 'model') {
          const voice = $('doubaoVoice').value;
          if (TTSI.doubao?.voices?.some(v => v.id === voice) && $(id).value === 'seed-icl-2.0') edit('tts.doubao.voice', '');
          paintDoubao();
        }
      });
    }
    $('doubaoFetch').onclick = () => { doubaoCatalogVisible = true; paintDoubao(); };
    $('doubaoVoices').onchange = () => {
      if (!$('doubaoVoices').value) return;
      edit('tts.doubao.voice', $('doubaoVoices').value); paintDoubao();
    };
    $('setTtsOn').addEventListener('change', () => live({ tts: { enabled: $('setTtsOn').checked } }));
    for (const [id, field] of [['rmUrl', 'baseURL'], ['rmKey', 'apiKey']]) {
      $(id).addEventListener('input', () => {
        const value = $(id).value.trim();
        if (field === 'apiKey' && value === KEY_MASK) return;
        edit('tts.' + field, value); invalidateChp();
      });
      $(id).addEventListener('change', () => {
        const value = $(id).value.trim();
        if (field === 'apiKey' && value === KEY_MASK) return;
        live({ tts: { [field]: value } });
      });
    }
    $('chpFetch').addEventListener('click', fetchChp);
    $('chpHelp').addEventListener('click', e => { e.preventDefault(); window.pet.chpHelp(); });
    $('rmVoice').addEventListener('change', () => live({ tts: { engine: 'remote', chp: { voice: $('rmVoice').value } } }));
    $('sysVoice').addEventListener('change', async () => {
      ttsDraft.voice = $('sysVoice').value;
      await live({ tts: { voice: ttsDraft.voice, engine: 'system' } });
    });
    $('sysRate').addEventListener('input', () => {
      ttsDraft.rate = Number($('sysRate').value);
      edit('tts.rate', ttsDraft.rate);
      $('sysRateVal').textContent = ttsDraft.rate;
    });
    $('sysRate').addEventListener('change', () => live({ tts: { rate: ttsDraft.rate } }));
    $('qwenVoice').addEventListener('change', async () => {
      await live({ tts: { engine: 'qwen', qwen: { voice: $('qwenVoice').value } } });
      await refreshVoices();
    });
    $('qwenGo').addEventListener('click', async () => {
      $('qwenGo').disabled = true;
      try {
        if (TTSI.qwen.downloaded) {
          $('qwenGo').textContent = '正在获取音色…';
          await refreshVoices(true);
          return;
        }
        const r = await window.pet.ttsDownload();
        if (r.started) await refreshDl();
        else { $('qwenGo').disabled = false; $('qwenTip').textContent = r.reason || '没能开始下载'; }
      } catch (e) { $('qwenGo').disabled = false; $('qwenGo').textContent = TTSI.qwen.downloaded ? '获取音色' : '下载模型'; $('qwenTip').textContent = '操作失败：' + e.message; }
    });
    $('qwenDelete').addEventListener('click', async () => {
      $('qwenDelete').disabled = true;
      try {
        const r = await window.pet.ttsDelete();
        await refreshVoices();
        if (r.ok) $('sfNote').textContent = '模型已删除。';
        else if (r.error) $('sfNote').textContent = r.error;
      } catch (e) { $('sfNote').textContent = '删除失败：' + e.message; }
      finally { paintDl(TTSI.dl || {}); }
    });

    $('permCheck').addEventListener('click', async () => {
      $('permTip').textContent = '正在请求权限…系统弹窗请点允许';
      paintPerm(await window.pet.asrStatus({ request: true }));
    });
    $('permOpenSpeech').addEventListener('click', () => window.pet.openPrivacy('speech'));
    $('permOpenMic').addEventListener('click', () => window.pet.openPrivacy('mic'));

    $('saveBtn').addEventListener('click', () => save().catch((e) => { $('sfNote').textContent = e.message; }));
    $('testBtn').addEventListener('click', async () => {
      const button = $('testBtn'); button.disabled = true; button.textContent = '正在合成…';
      $('sfNote').textContent = ttsDraft.engine === 'qwen' ? '正在本地合成，加载模型可能需要几十秒，请稍候…' : '正在试听…';
      try {
        const pending = draftPatch('tts');
        if (pending.paths.length) await persist(pending.patch, pending.paths);
        await writeTail;
        const r = await window.pet.ttsTest();
        $('sfNote').textContent = r.ok
          ? (r.degraded ? `所选语音不可用，已切换系统语音：${r.reason}` : `用的是 ${r.engine === 'system' ? '系统语音' : r.engine === 'qwen' ? '本地 Qwen 语音' : r.engine === 'doubao' ? '豆包语音' : r.engine === 'http' ? '已有接口' : '局域网 CHP'}${r.voice ? ' · ' + r.voice : ''}（${(r.ms / 1000).toFixed(1)} 秒）`)
          : ('试听失败：' + r.error);
      } catch (e) { $('sfNote').textContent = '试听失败：' + e.message; }
      finally { button.disabled = false; button.textContent = '试听一句'; }
    });
  } else {
    applyMotionView({ motions: MOTIONS, categories: MOTION_GROUPS }); buildMotionList();
    window.pet.on(ev => {
      if (ev.type === 'config' && ev.config) { const changed = JSON.stringify(cfg.motions) !== JSON.stringify(ev.config.motions); cfg = ev.config; if (changed) buildMotionList(); }
      if (ev.type === 'motion-library') { applyMotionView(ev); buildMotionList(); }
      if (ev.type === 'motion-error') $('mStatus').textContent = ev.error;
    });
    $('mAddCategory').onclick = async () => { await motionOperation({ type: 'category-add', label: $('mNewCategory').value }); $('mNewCategory').value = ''; };
    $('mImport').onclick = async () => {
      if (motionSaving) return; motionSaving = true; $('mStatus').textContent = '请选择个人动作文件…';
      try { const r = await window.pet.motionImport({ slot: $('mImportGroup').value }); if (!r.cancelled) { applyMotionView(r); $('mStatus').textContent = r.errors?.length ? r.errors.join('；') : `已导入${r.imported.length}个动作`; } }
      catch (error) { $('mStatus').textContent = error.message; }
      finally { motionSaving = false; buildMotionList(); }
    };
    $('mRestore').onclick = () => { if (confirm('恢复内置动作和默认分类？个人动作文件会保留。')) motionOperation({ type: 'restore-defaults' }); };
    $('mAll').addEventListener('click', () => setDisabledMotions([]));
    $('mIdle').addEventListener('click', () => { curMotion = ''; window.pet.panelMotion('__idle__'); buildMotionList(); });
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement) document.activeElement.blur(); });
})().catch((e) => {
  document.body.textContent = '面板没起来：' + String((e && e.message) || e);
});

window.__panel = () => ({ which, motions: MOTIONS.length, groups: MOTION_GROUPS.length, avatar: avatarKey, scale: viewScale });
