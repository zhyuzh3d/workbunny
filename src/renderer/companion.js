import { setupAutonomy } from './autonomy-ui.js';
import { createSelfEditor } from './self-editor.js';
import { characterName, characterText, paintCharacterNames } from './character-name.mjs';
const $ = (id) => document.getElementById(id);
const page = new URLSearchParams(location.search).get('p') === 'desktop' ? 'desktop' : 'memory';
$(page === 'desktop' ? 'desktopPage' : 'memoryPage').hidden = false;
if (page === 'desktop') setupAutonomy(window.pet);
let characterConfig = {};
function setCharacterConfig(config) { if (config?.buddy) { characterConfig = config; paintCharacterNames(config); } }
const selfEditor = page === 'memory' ? createSelfEditor(window.pet, { getConfig: () => characterConfig }) : null;

function node(tag, className = '', text = '') {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}
function setNote(id, message, bad = false) {
  const target = $(id);
  if (!target) return;
  target.textContent = characterText(message, characterConfig);
  target.classList.toggle('bad-text', !!bad);
}
function api(name, ...args) {
  const fn = window.pet?.[name];
  if (typeof fn !== 'function') throw new Error('当前版本尚未提供此功能');
  return fn(...args);
}
function showError(error) {
  const box = $('pageError');
  box.textContent = error?.message || String(error || '操作失败');
  box.hidden = false;
}
function hideError() { $('pageError').hidden = true; }
function formatTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function labelStatus(value) {
  if (value === 'unverified') return '用户传授 · 未实测';
  const labels = { confirmed: '已确认', pending: '待确认', accepted: '已确认', rejected: '已忽略', ready: '已就绪', unavailable: '不可用',
    enabled: '已启用', disabled: '已停用', running: '运行中', completed: '已完成', failed: '未完成', stopped: '已停止' };
  return labels[String(value)] || String(value ?? '—');
}

/* ── 记忆 ── */
let memoryKind = 'memory', memoryCategory = 'all', memoryQuery = '', memoryCursor = null, memoryHasMore = false, memoryPageCount = 0;
let memoryRows = [], memoryStats = null, memoryCfg = {}, savedMemoryCfg = {}, memoryCfgWriting = false;
let memoryCfgPending = false;
const SCENES = ['private', 'life', 'work'];
const SCENE_SCOPE_TEXT = {
  private: '私聊：可按需参考私聊、生活与工作资料',
  life: '生活：可按需参考生活与工作资料',
  work: '工作：可按需参考工作资料',
};
let activeScene = 'life', savedScene = 'life', sceneRevision = 0;
let sceneWritePending = 0, sceneWriteTail = Promise.resolve();
let memoryRefreshPending = false, memoryRefreshTimer = null, memoryRefreshBusy = false;
let memoryViewRevision = 0, memoryStatsRevision = 0;
let memoryListBusyRevision = 0;
let currentRecallEntries = [];
let maintenanceBusy = false;
function countValue(value) { return typeof value === 'number' ? value : Number(value?.count ?? value?.total ?? 0) || 0; }
function countsObject(stats) { return stats?.counts && typeof stats.counts === 'object' ? stats.counts : {}; }
function setPill(id, text, tone = '') {
  const el = $(id); el.textContent = text; el.className = `status-pill${tone ? ` ${tone}` : ''}`;
}
function paintMemoryStats(stats) {
  memoryStats = stats || {};
  const counts = countsObject(memoryStats);
  const sceneLabel = { private: '私聊', life: '生活', work: '工作' }[memoryStats.scene || activeScene] || '生活';
  $('memoryUnlock').hidden = memoryStats.ready !== false || !!memoryStats.opening;
  if (memoryStats.locked) setPill('memoryStatus', '电脑解锁后载入记忆', 'warn');
  else if (memoryStats.opening) setPill('memoryStatus', '正在解锁记忆 · 请留意 macOS 授权', 'warn');
  else if (memoryStats.error) setPill('memoryStatus', `读取失败 · ${memoryStats.error}`, 'bad');
  else if (memoryStats.ready === false) setPill('memoryStatus', '记忆服务未就绪', 'warn');
  else setPill('memoryStatus', `${sceneLabel} · 已就绪`, 'ok');
  const compression = memoryStats.compression;
  $('contextStatus').textContent = compression?.version > 0
    ? `${sceneLabel} · 压缩版本 ${compression.version}${compression.updatedAt ? ` · ${formatTime(compression.updatedAt)}` : ''}`
    : `${sceneLabel} · 尚无需要压缩的旧对话`;
  const target = $('memoryCounts'); target.replaceChildren();
  for (const [key, title] of [['memory', '长期记忆'], ['message', '聊天记录'], ['summary', '对话摘要']]) {
    const box = node('div', 'count-box');
    box.append(node('b', '', countValue(counts[key])));
    box.append(node('span', '', title));
    target.append(box);
  }
}
function paintMaintenanceStatus(value) {
  const labels = { idle: '空闲', queued: '排队中', running: '整理中', paused: '已暂停', failed: '暂未完成', unavailable: '状态暂不可用' };
  if (!value || typeof value !== 'object') {
    $('maintenanceStatus').textContent = '整理状态暂不可用';
    return;
  }
  const label = labels[value.status] || '状态未知';
  const details = [];
  if (Number.isFinite(value.processed) && value.processed > 0) details.push(`已处理 ${value.processed} 条`);
  if (Number.isFinite(value.scanned) && value.scanned > 0) details.push(`检查旧记忆 ${value.scanned} 条`);
  if (Number.isFinite(value.archived) && value.archived > 0) details.push(`归档重复项 ${value.archived} 条`);
  if (value.note) details.push(String(value.note).slice(0, 180));
  if (value.status === 'idle' && value.lastSuccessAt) details.push(`上次完成 ${formatTime(value.lastSuccessAt)}`);
  $('maintenanceStatus').textContent = [label, ...details].join(' · ');
}
async function loadMaintenanceStatus() {
  try { paintMaintenanceStatus(await api('memoryMaintenanceStatus')); }
  catch (error) { paintMaintenanceStatus({ status: 'unavailable', note: error.message || '整理状态暂不可用' }); }
}
async function requestMemoryMaintenance(mode) {
  if (maintenanceBusy) return;
  maintenanceBusy = true;
  $('maintenanceDoze').disabled = $('maintenanceDream').disabled = $('maintenanceDeepdream').disabled = true;
  $('maintenanceStatus').textContent = `正在排入 ${mode}…`;
  try {
    const result = await api('memoryMaintain', mode);
    if (!result?.ok) throw new Error(result?.error || '请求没有排入');
    await loadMaintenanceStatus();
  } catch (error) {
    $('maintenanceStatus').textContent = error.message || '整理请求没有完成';
  } finally {
    maintenanceBusy = false;
    $('maintenanceDoze').disabled = $('maintenanceDream').disabled = $('maintenanceDeepdream').disabled = false;
  }
}
function memoryConfigFrom(result) {
  const root = result?.config || result || {};
  setCharacterConfig(root);
  const value = root.memory && typeof root.memory === 'object' ? root.memory : {};
  memoryCfg = { enabled: !!value.enabled, extract: !!value.extract };
  savedMemoryCfg = { ...memoryCfg };
  activeScene = SCENES.includes(value.scene) ? value.scene : 'life';
  savedScene = activeScene;
  paintMemoryConfig();
  paintSceneSettings();
}
function applyMemoryConfigUpdate(result) {
  const root = result?.config || result || {};
  setCharacterConfig(root);
  const remoteMemory = root.memory && typeof root.memory === 'object' ? root.memory : {};
  for (const key of ['enabled', 'extract']) {
    const dirty = memoryCfg[key] !== savedMemoryCfg[key];
    const remote = !!remoteMemory[key];
    savedMemoryCfg[key] = remote;
    if (!dirty) memoryCfg[key] = remote;
  }
  const remoteScene = SCENES.includes(remoteMemory.scene) ? remoteMemory.scene : 'life';
  const sceneDirty = activeScene !== savedScene;
  savedScene = remoteScene;
  if (!sceneDirty) activeScene = remoteScene;
  paintMemoryConfig();
  paintSceneSettings();
}
function paintMemoryConfig() {
  $('memoryEnabled').checked = memoryCfg.enabled;
  $('memoryExtract').checked = memoryCfg.extract;
}
function configDraftLabel(draft) {
  return `使用记忆：${draft.enabled ? '开' : '关'}，整理新记忆：${draft.extract ? '开' : '关'}`;
}
function paintSceneSettings() {
  $('memoryScene').value = activeScene;
  $('memorySceneScope').textContent = SCENE_SCOPE_TEXT[activeScene];
}
function changeMemoryScene(scene) {
  if (!SCENES.includes(scene) || scene === activeScene) return;
  activeScene = scene;
  const revision = ++sceneRevision;
  memoryViewRevision++;
  memoryStatsRevision++;
  memoryCursor = null; memoryRows = []; memoryPageCount = 0; memoryHasMore = false;
  $('memoryList').replaceChildren(); $('memoryMore').hidden = true;
  $('memoryListNote').textContent = '正在切换场景…';
  paintCurrentRecall([]);
  paintSceneSettings();
  setNote('memorySceneScope', SCENE_SCOPE_TEXT[scene]);
  sceneWritePending++;
  setNote('memoryConfigNote', '正在切换场景…');
  sceneWriteTail = sceneWriteTail.catch(() => {}).then(async () => {
    try {
      const result = await api('config', { memory: { scene } });
      if (result?.ok === false) throw new Error(result.error || '保存失败');
      savedScene = scene;
      if (revision === sceneRevision) {
        setNote('memoryConfigNote', '场景已切换');
        await loadMemoryStats(); await loadMemoryList(true);
      }
    } catch (error) {
      if (revision === sceneRevision) {
        activeScene = savedScene;
        paintSceneSettings();
        setNote('memoryConfigNote', `场景切换失败，已恢复原场景。${error.message || '请重试。'}`, true);
        await loadMemoryStats(); await loadMemoryList(true);
      }
    } finally { sceneWritePending--; }
  });
}
async function flushMemoryConfig() {
  if (memoryCfgWriting) return;
  memoryCfgWriting = true;
  memoryCfgPending = true;
  try {
    while (true) {
      const snapshot = { ...memoryCfg };
      const result = await api('config', { memory: snapshot });
      if (result?.ok === false) throw new Error(result.error || '保存失败');
      savedMemoryCfg = snapshot;
      if (memoryCfg.enabled === snapshot.enabled && memoryCfg.extract === snapshot.extract) {
        setNote('memoryConfigNote', '已保存');
        break;
      }
    }
  } catch (error) {
    const failedDraft = { ...memoryCfg };
    memoryCfg = { ...savedMemoryCfg };
    paintMemoryConfig();
    setNote('memoryConfigNote', `保存失败，已恢复原设置。未保存选择：${configDraftLabel(failedDraft)}。${error.message || '请重新选择后保存。'}`, true);
  } finally {
    memoryCfgPending = false;
    memoryCfgWriting = false;
  }
}
function saveMemorySetting(key, value) {
  memoryCfg[key] = value;
  setNote('memoryConfigNote', '正在保存…');
  flushMemoryConfig();
}
addEventListener('beforeunload', (event) => {
  if (!memoryCfgPending && !sceneWritePending) return;
  event.preventDefault(); event.returnValue = '';
});
function rowSourceIds(row) {
  const sources = Array.isArray(row.sources) ? row.sources : [];
  return sources.map((source) => typeof source === 'string' ? source : source?.id).filter(Boolean);
}
function normalizeMemoryRow(row) {
  if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) return row || {};
  return { ...row.value, ...row };
}
function addAction(container, text, callback, className = 'button quiet') {
  const button = node('button', className, text); button.type = 'button';
  button.addEventListener('click', callback); container.append(button); return button;
}
function renderSources(card, rows) {
  const region = node('div', 'record-source');
  if (!rows?.length) region.textContent = '没有可显示的来源';
  else for (const source of rows) {
    const line = node('div', '', [source.ts ? formatTime(source.ts) : '', source.role || '', source.content || source.title || source.evidence || ''].filter(Boolean).join(' · '));
    region.append(line);
  }
  card.append(region);
}
function renderRecord(row) {
  if (memoryKind === 'knowledge') return renderKnowledgeRecord(row);
  const isConflict = row.origin === 'user-key-conflict-v1' && row.status === 'pending';
  const isModelCandidate = /^(?:doze-candidate|dream-candidate|model-candidate)/u.test(row.origin || '') && row.status === 'pending';
  const card = node('article', 'record');
  card.dataset.recordId = row.id || '';
  const top = node('div', 'record-top');
  top.append(node('span', 'record-date', formatTime(row.ts)));
  if (row.role) {
    const id = row.characterId || (row.role === 'assistant' ? 'bunny' : 'owner');
    const names = { owner: '主人', bunny: characterName(characterConfig), workbuddy: 'WorkBuddy', system: '系统事件' };
    const characterBadge = node('span', 'badge', id === 'bunny' ? names.bunny : row.characterName && row.characterName !== id ? row.characterName : names[id] || id);
    if (id === 'bunny') characterBadge.dataset.characterText = 'Bunny';
    top.append(characterBadge);
  }
  if (row.memoryKind === 'observation') top.append(node('span', 'badge', '来源观察'));
  if (row.evidenceCharacter && !row.role) top.append(node('span', 'badge', `来源：${row.evidenceCharacter}`));
  for (const tag of (row.tags || []).filter(t => t === '主动记忆' || t === '自动记忆')) top.append(node('span', 'badge', tag));
  if (row.origin === 'deepdream-merged-v1') top.append(node('span', 'badge', '归并版本'));
  if (row.status) top.append(node('span', `badge${row.status === 'pending' ? ' pending' : ''}`, isConflict ? '用户说法待核对' : isModelCandidate ? '整理候选' : labelStatus(row.status)));
  card.append(top);
  card.append(node('div', `record-content${row.role ? ' role' : ''}`, row.content || '（空内容）'));
  if (row.evidence) card.append(node('div', 'record-source', `依据：${row.evidence}`));
  const actions = node('div', 'record-actions');
  let editBox = null;
  if (row.kind === 'memory') {
    if (!isConflict) addAction(actions, '编辑', () => {
      if (editBox) { editBox.remove(); editBox = null; if (memoryRefreshPending) void refreshMemoryView(); return; }
      memoryViewRevision++;
      if (memoryRefreshBusy || memoryListBusyRevision) memoryRefreshPending = true;
      memoryListBusyRevision = 0;
      editBox = node('div', 'record-edit');
      const textarea = node('textarea'); textarea.rows = 3; textarea.maxLength = 1000; textarea.value = row.content || '';
      const saveRow = node('div', 'record-actions');
      addAction(saveRow, '保存修改', async () => {
        try {
          hideError();
          const result = await api('memoryUpdate', row.id, textarea.value.trim());
          if (!result?.ok) throw new Error(result?.error || '没有保存成功');
          await loadMemoryStats(); await loadMemoryList(true); setNote('memoryActionNote', '记忆已更新');
        } catch (error) { showError(error); }
      }, 'button primary');
      editBox.append(textarea, saveRow); card.append(editBox); textarea.focus();
    });
    if (row.status === 'pending') addAction(actions, isConflict ? '采用这次说法' : '确认', async () => {
      try {
        hideError();
        const result = isConflict ? await api('memoryResolveConflict', row.id) : await api('memoryUpdate', row.id, row.content || '');
        if (!result?.ok) throw new Error(result?.error || '没有确认记忆');
        setNote('memoryActionNote', isConflict ? '已采用这次说法，旧说法保留为历史' : '记忆已确认'); await loadMemoryStats(); await loadMemoryList(true);
      } catch (error) { showError(error); }
    }, 'button primary');
    const ids = rowSourceIds(row);
    if (ids.length) addAction(actions, '查看来源', async () => {
      const existing = card.querySelector('.record-source.details');
      if (existing) { existing.remove(); return; }
      try {
        const sources = await api('memorySources', ids);
        const region = node('div', 'record-source details');
        const list = Array.isArray(sources) ? sources : (sources?.rows || []);
        if (!list.length) region.textContent = '没有可显示的来源';
        else for (const source of list) region.append(node('div', '', [formatTime(source.ts), source.role || '', source.content || source.title || ''].filter(Boolean).join(' · ')));
        card.append(region);
      } catch (error) {
        const region = node('div', 'record-source details bad-text', `来源暂时无法读取：${error?.message || '请稍后重试'}`);
        card.append(region);
      }
    });
    addAction(actions, '彻底遗忘', async () => {
      try {
        hideError();
        const result = await api('memoryRemove', row.id);
        if (!result?.removed) throw new Error(result?.error || '没有删除记忆');
        const removedSources = countValue(result.removedSources);
        setNote('memoryActionNote', removedSources ? `已删除，并移除 ${removedSources} 条关联来源` : '记忆已删除');
        await loadMemoryStats(); await loadMemoryList(true);
      } catch (error) { showError(error); }
    }, 'button danger');
  }
  card.append(actions);
  return card;
}
function knowledgeTypeLabel(type) {
  return ({ relation: '相关陈述', doubt: '待核对', experience: '经验', tool: '工具', decision: '核对记录' })[type] || '整理资料';
}
function knowledgeStatusLabel(status) {
  return ({ pending: '待处理', open: '待处理', unresolved: '待处理', snoozed: '稍后查看', dismissed: '不再提醒',
    resolved: '已核对', accepted: '已采纳', verified: '历史验收', superseded: '已更新', archived: '已归档' })[status] || labelStatus(status);
}
function toolDetails(row) {
  const metadata = row.toolMetadata || row.tool || row.metadata || {};
  const artifact = row.artifact;
  const file = row.fileName || metadata.fileName || metadata.filename ||
    (typeof artifact === 'string' ? artifact : artifact?.fileName || artifact?.filename || artifact?.path);
  const status = row.validationStatus ?? row.status ?? metadata.validationStatus ?? metadata.validation?.status;
  const fileStatus = row.fileStatus ?? metadata.fileStatus;
  const available = row.snapshotAvailable ?? metadata.snapshotAvailable;
  const details = [];
  if (typeof file === 'string' && file.trim()) details.push(`文件：${file.split(/[\\/]/u).filter(Boolean).at(-1) || file}`);
  if (fileStatus === 'unknown') details.push(status === 'verified' ? '历史验收；当前文件未复验' : '当前文件未复验');
  else if (typeof fileStatus === 'string' && fileStatus) details.push(`当前文件：${labelStatus(fileStatus)}`);
  else if (typeof status === 'string' || typeof status === 'boolean') details.push(`历史验收：${typeof status === 'boolean' ? (status ? '通过' : '未通过') : labelStatus(status)}`);
  if (typeof available === 'boolean') details.push(`快照：${available ? '可用' : '不可用'}`);
  return details;
}
function renderKnowledgeRecord(raw) {
  const row = normalizeMemoryRow(raw);
  const card = node('article', 'record knowledge-card');
  card.dataset.recordId = row.id || '';
  const top = node('div', 'record-top');
  top.append(node('span', 'record-date', formatTime(row.ts)));
  top.append(node('span', 'badge', row.label || knowledgeTypeLabel(row.knowledgeType)));
  for (const tag of (row.tags || []).filter(t => t === '主动记忆' || t === '自动记忆')) top.append(node('span', 'badge', tag));
  if (row.status) top.append(node('span', `badge${['pending', 'open', 'unresolved', 'snoozed'].includes(row.status) ? ' pending' : ''}`,
    row.knowledgeType === 'experience' && row.status === 'candidate' ? '单次已验收' : knowledgeStatusLabel(row.status)));
  card.append(top, node('div', 'record-content', row.content || '（空内容）'));

  const choices = Array.isArray(row.memberChoices) ? row.memberChoices.filter(choice =>
    choice && typeof choice.id === 'string' && choice.id.length > 0 && typeof choice.content === 'string') : [];
  if (choices.length) {
    const region = node('div', 'knowledge-choices');
    region.append(node('div', 'inline-note', '可核对的说法'));
    for (const choice of choices) {
      const item = node('div', 'knowledge-choice');
      item.append(node('div', 'record-content', choice.content));
      region.append(item);
    }
    card.append(region);
  }
  if (row.knowledgeType === 'tool') {
    const details = toolDetails(row);
    if (details.length) card.append(node('div', 'knowledge-tool-meta', details.join(' · ')));
  }

  const actions = node('div', 'record-actions');
  const note = node('div', 'knowledge-action-note inline-note');
  note.setAttribute('role', 'status'); note.hidden = true;
  const isOpenDoubt = row.knowledgeType === 'doubt' && !['resolved', 'accepted', 'dismissed', 'superseded', 'archived'].includes(row.status);
  if (isOpenDoubt) {
    const actionButtons = [];
    const resolve = async (action, choiceId, suppliedNote) => {
      let noteText;
      if (action === 'both') {
        noteText = String(suppliedNote || '').trim().slice(0, 500);
        if (!noteText) { note.textContent = '请补充两种说法分别适用的条件后再提交。'; note.classList.add('bad-text'); note.hidden = false; return; }
      }
      note.hidden = true; note.classList.remove('bad-text');
      const sceneAtStart = activeScene;
      actionButtons.forEach(button => { button.disabled = true; });
      try {
        const result = await api('memoryResolveDoubt', row.id, { action, ...(choiceId ? { choiceId } : {}), ...(noteText ? { note: noteText } : {}) });
        if (!result?.ok) throw new Error(result?.error || '核对没有完成，请稍后重试。');
        if (sceneAtStart !== activeScene) return;
        setNote('memoryActionNote', action === 'dismiss' ? '已设为不再提醒' : action === 'snooze' ? '已稍后处理' : '核对结果已保存');
        await loadMemoryStats(); await loadMemoryList(true);
      } catch (error) {
        if (card.isConnected && sceneAtStart === activeScene) {
          note.textContent = error?.message || '操作失败，请稍后重试。';
          note.classList.add('bad-text'); note.hidden = false;
        }
      } finally { actionButtons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
    };
    let bothEditor = null;
    const openBothEditor = () => {
      if (bothEditor?.isConnected) { bothEditor.querySelector('textarea')?.focus(); return; }
      bothEditor = node('div', 'knowledge-both-editor');
      const field = node('textarea'); field.rows = 2; field.maxLength = 500;
      field.placeholder = '例如：工作日按第一种安排，出差时按第二种安排';
      field.setAttribute('aria-label', '两种说法分别适用的条件');
      const controls = node('div', 'record-actions');
      const cancel = addAction(controls, '取消', () => { bothEditor?.remove(); bothEditor = null; }, 'button quiet');
      const submit = addAction(controls, '保存适用条件', () => resolve('both', undefined, field.value), 'button primary');
      actionButtons.push(cancel, submit);
      bothEditor.append(field, controls);
      card.insertBefore(bothEditor, actions);
      field.focus();
    };
    for (const [index, choice] of choices.entries()) {
      actionButtons.push(addAction(actions, `采用第 ${index + 1} 项`, () => resolve('choose', choice.id), 'button primary'));
    }
    if (choices.length >= 2) actionButtons.push(addAction(actions, '两种都适用', openBothEditor, 'button quiet'));
    actionButtons.push(addAction(actions, '稍后', () => resolve('snooze'), 'button quiet'));
    actionButtons.push(addAction(actions, '不再提醒', () => resolve('dismiss'), 'button quiet'));
  }
  const ids = rowSourceIds(row);
  if (ids.length) addAction(actions, '查看来源', async () => {
    const existing = card.querySelector('.record-source.details');
    if (existing) { existing.remove(); return; }
    try {
      const sources = await api('memorySources', ids.slice(0, 30));
      const list = Array.isArray(sources) ? sources : (sources?.rows || []);
      const region = node('div', 'record-source details');
      if (!list.length) region.textContent = '没有可显示的来源';
      else {
        if (ids.length > 30) region.append(node('div', 'inline-note', '来源较多，仅显示前 30 条'));
        for (const source of list) region.append(node('div', '', [formatTime(source.ts), source.role || '', source.content || source.title || source.evidence || ''].filter(Boolean).join(' · ')));
      }
      card.append(region);
    } catch (error) { card.append(node('div', 'record-source details bad-text', `来源暂时无法读取：${error?.message || '请稍后重试'}`)); }
  });
  card.append(actions, note);
  return card;
}
function paintCurrentRecall(entries) {
  currentRecallEntries = Array.isArray(entries) ? entries.filter(entry => entry &&
    typeof entry.id === 'string' && ['memory', 'summary'].includes(entry.kind) && typeof entry.content === 'string') : [];
  const card = $('currentRecallCard'), target = $('currentRecallList');
  card.hidden = currentRecallEntries.length === 0;
  $('currentRecallTitle').textContent = `本轮想起 · ${currentRecallEntries.length} 条`;
  target.replaceChildren();
  for (const entry of currentRecallEntries) {
    const item = node('article', 'recall-entry');
    item.append(node('div', 'record-date', `${entry.kind === 'memory' ? '长期记忆' : '对话摘要'} · ${formatTime(entry.ts)}`));
    item.append(node('p', '', entry.content));
    const actions = node('div', 'record-actions');
    const ids = Array.isArray(entry.sources) ? entry.sources.map(source => typeof source === 'string' ? source : source?.id).filter(id => typeof id === 'string' && id) : [];
    if (ids.length) addAction(actions, '查看来源', async event => {
      const button = event?.currentTarget;
      const existing = item.querySelector('.recall-source-list');
      if (existing) { existing.remove(); return; }
      if (button) button.disabled = true;
      try {
        const result = await api('memorySources', ids);
        const sources = Array.isArray(result) ? result : (result?.rows || []);
        const list = node('div', 'recall-source-list');
        if (!sources.length) list.append(node('div', 'recall-source', '没有可显示的来源'));
        else for (const source of sources) list.append(node('div', 'recall-source', [formatTime(source.ts), source.role || '', source.content || source.title || source.evidence || ''].filter(Boolean).join(' · ')));
        item.append(list);
      } catch (error) {
        const region = node('div', 'recall-source-list');
        region.append(node('div', 'recall-source bad-text', `来源暂时无法读取：${error?.message || '请稍后重试'}`));
        item.append(region);
      }
      finally { if (button) button.disabled = false; }
    });
    addAction(actions, '查看记录', async () => {
      memoryKind = entry.kind;
      memoryQuery = memoryRows.some(row => row.id === entry.id) ? '' : entry.content.slice(0, 100).trim();
      $('memorySearch').value = memoryQuery;
      for (const tab of $('memoryTabs').querySelectorAll('.tab')) {
        const active = tab.dataset.kind === memoryKind;
        tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
      }
      $('knowledgeFilters').hidden = memoryKind !== 'knowledge';
      $('memorySearch').placeholder = memoryKind === 'knowledge' ? '搜索整理与经验' : '搜索内容';
      await loadMemoryList(true);
      document.querySelector('.memory-main').scrollTop = 0;
      document.querySelector(`[data-record-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: 'center' });
    });
    item.append(actions); target.append(item);
  }
}
async function loadMemoryStats() {
  const revision = ++memoryStatsRevision;
  try {
    const stats = await api('memoryStats');
    if (revision === memoryStatsRevision) paintMemoryStats(stats);
  } catch (error) {
    if (revision === memoryStatsRevision) paintMemoryStats({ ready: false, error: error.message });
  }
}
function rowsFromMemoryResult(result) {
  const rows = Array.isArray(result) ? result : (result?.rows || []);
  return rows.map(normalizeMemoryRow);
}
function cursorFromMemoryResult(result, rows) {
  const next = result?.next;
  if (next && typeof next === 'object') {
    const ts = Number.isSafeInteger(next.ts) ? next.ts : next.before;
    const id = typeof next.id === 'string' ? next.id : next.beforeId;
    if (Number.isSafeInteger(ts) && typeof id === 'string' && id) return { ts, id };
  }
  const last = rows.at(-1);
  return last ? { ts: last.ts, id: last.id } : null;
}
function resultHasMemoryMore(result, rows, query) {
  if (query) return false;
  if (typeof result?.hasMore === 'boolean') return result.hasMore;
  if (Object.hasOwn(result || {}, 'next')) return !!result.next;
  return rows.length > 0;
}
function memoryListOptions(view, cursor) {
  const options = { kind: view.kind, query: view.query, ...(view.kind === 'memory' ? { effective: true } : {}) };
  if (view.kind === 'knowledge') options.category = view.category;
  if (cursor) { options.before = cursor.ts; options.beforeId = cursor.id; }
  return options;
}
async function loadMemoryList(reset = false) {
  const revision = ++memoryViewRevision;
  hideError();
  if (reset) { memoryCursor = null; memoryRows = []; memoryPageCount = 0; }
  const view = { kind: memoryKind, category: memoryCategory, query: memoryQuery, cursor: memoryCursor && { ...memoryCursor } };
  memoryListBusyRevision = revision;
  $('memoryListNote').textContent = '正在读取…'; $('memoryMore').hidden = true;
  try {
    const options = memoryListOptions(view, view.cursor);
    const result = await api('memoryList', options);
    if (memoryListBusyRevision === revision) memoryListBusyRevision = 0;
    if (revision !== memoryViewRevision) return;
    if (hasOpenMemoryEditor()) { memoryRefreshPending = true; return; }
    const rows = rowsFromMemoryResult(result);
    memoryRows = [...new Map((reset ? rows : memoryRows.concat(rows)).map(row => [row.id, row])).values()];
    if (rows.length) memoryPageCount = reset ? 1 : memoryPageCount + 1;
    const target = $('memoryList'); target.replaceChildren(...memoryRows.map(renderRecord));
    const nextCursor = cursorFromMemoryResult(result, rows);
    memoryCursor = nextCursor || memoryCursor;
    memoryHasMore = resultHasMemoryMore(result, rows, memoryQuery);
    $('memoryMore').hidden = !memoryHasMore || !memoryCursor;
    $('memoryListNote').textContent = rows.length ? `${memoryRows.length} 条内容` : (reset ? '没有找到内容' : '没有更多内容');
  } catch (error) {
    if (memoryListBusyRevision === revision) memoryListBusyRevision = 0;
    if (revision !== memoryViewRevision) return;
    $('memoryListNote').textContent = '';
    $('memoryList').replaceChildren(node('div', 'record', error.message || '读取失败'));
  }
}
function hasOpenMemoryEditor() { return !!$('memoryList')?.querySelector('.record-edit textarea'); }
function scheduleMemoryRefresh() {
  clearTimeout(memoryRefreshTimer);
  memoryRefreshTimer = setTimeout(() => { void refreshMemoryView(); }, 200);
}
async function refreshMemoryView() {
  const revision = ++memoryViewRevision;
  const view = { kind: memoryKind, category: memoryCategory, query: memoryQuery, pageCount: memoryQuery ? 1 : Math.max(1, memoryPageCount) };
  if (memoryRefreshBusy) { memoryRefreshPending = true; return; }
  memoryRefreshBusy = true;
  memoryRefreshPending = false;
  const scrollHost = document.querySelector('.memory-main');
  const scrollTop = scrollHost?.scrollTop || 0;
  try {
    await loadMemoryStats();
    if (revision !== memoryViewRevision) return;
    if (hasOpenMemoryEditor()) { memoryRefreshPending = true; return; }
    let cursor = null, rows = [], hasMore = false;
    for (let page = 0; page < view.pageCount; page++) {
      const options = memoryListOptions(view, cursor);
      const result = await api('memoryList', options);
      if (revision !== memoryViewRevision) return;
      if (hasOpenMemoryEditor()) { memoryRefreshPending = true; return; }
      const batch = rowsFromMemoryResult(result);
      rows.push(...batch);
      cursor = cursorFromMemoryResult(result, batch) || cursor;
      hasMore = resultHasMemoryMore(result, batch, view.query);
      if (!batch.length || !hasMore) break;
    }
    memoryRows = [...new Map(rows.map(row => [row.id, row])).values()];
    memoryCursor = cursor;
    memoryHasMore = hasMore;
    $('memoryList').replaceChildren(...memoryRows.map(renderRecord));
    $('memoryMore').hidden = !memoryHasMore || !memoryCursor;
    $('memoryListNote').textContent = memoryRows.length ? `${memoryRows.length} 条内容` : '没有找到内容';
    if (scrollHost) scrollHost.scrollTop = scrollTop;
  } catch (error) { if (revision === memoryViewRevision) $('memoryListNote').textContent = error.message || '刷新失败'; }
  finally {
    memoryRefreshBusy = false;
    if (memoryRefreshPending && !hasOpenMemoryEditor()) scheduleMemoryRefresh();
  }
}
function hasStoredMemory() {
  const counts = countsObject(memoryStats);
  return ['message', 'memory', 'summary', 'task'].some(key => countValue(counts[key]) > 0);
}
async function initMemory() {
  try {
    const [stats, config] = await Promise.all([api('memoryStats'), api('config')]);
    paintMemoryStats(stats); memoryConfigFrom(config);
  } catch (error) {
    if (!memoryStats) paintMemoryStats({ ready: false, error: error.message });
    setNote('memoryConfigNote', error.message || '设置暂不可用', true);
  }
  await loadMaintenanceStatus();
  await loadMemoryList(true);
}
$('maintenanceDoze').addEventListener('click', () => { void requestMemoryMaintenance('doze'); });
$('maintenanceDream').addEventListener('click', () => { void requestMemoryMaintenance('dream'); });
$('maintenanceDeepdream').addEventListener('click', () => { void requestMemoryMaintenance('deepdream'); });
$('memoryUnlock').addEventListener('click', async () => { try { paintMemoryStats(await api('memoryUnlock')); await loadMemoryList(true); } catch (error) { showError(error); } });
$('memoryTabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-kind]');
  if (!button) return;
  memoryKind = button.dataset.kind;
  for (const tab of $('memoryTabs').querySelectorAll('.tab')) {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  $('knowledgeFilters').hidden = memoryKind !== 'knowledge';
  $('memorySearch').placeholder = memoryKind === 'knowledge' ? '搜索整理与经验' : '搜索内容';
  loadMemoryList(true);
});
$('knowledgeCategory').addEventListener('change', event => {
  memoryCategory = ['all', 'relation', 'doubt', 'experience', 'tool'].includes(event.target.value) ? event.target.value : 'all';
  loadMemoryList(true);
});
$('memorySearchBtn').addEventListener('click', () => { memoryQuery = $('memorySearch').value.trim(); loadMemoryList(true); });
$('memorySearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('memorySearchBtn').click(); } });
$('memoryMore').addEventListener('click', () => { if (memoryHasMore) loadMemoryList(false); });
$('memoryScene').addEventListener('change', event => changeMemoryScene(event.target.value));
$('openSelfSettings').addEventListener('click', () => { void selfEditor?.open(); });
$('memoryEnabled').addEventListener('change', (event) => saveMemorySetting('enabled', event.target.checked));
$('memoryExtract').addEventListener('change', (event) => saveMemorySetting('extract', event.target.checked));
$('memoryExport').addEventListener('click', async () => {
  const passphrase = $('backupPassphrase').value;
  if (!passphrase) { setNote('memoryActionNote', '请先输入备份密码', true); $('backupPassphrase').focus(); return; }
  try {
    const result = await api('memoryExport', passphrase);
    setNote('memoryActionNote', result?.canceled ? '已取消' : result?.ok ? '加密备份已保存' : result?.error || '备份没有完成', !result?.ok && !result?.canceled);
  } catch (error) { setNote('memoryActionNote', error.message || '备份失败', true); }
  finally { $('backupPassphrase').value = ''; }
});
$('memoryRestore').addEventListener('click', async () => {
  const passphrase = $('backupPassphrase').value;
  if (!passphrase) { setNote('memoryActionNote', '请输入备份密码', true); $('backupPassphrase').focus(); return; }
  if (hasStoredMemory()) { setNote('memoryActionNote', '请先导出备份，再清空当前记忆后恢复。', true); return; }
  try {
    const result = await api('memoryRestore', passphrase);
    setNote('memoryActionNote', result?.canceled ? '已取消' : result?.ok ?
      '备份已恢复' + (result.legacyPrivateRecords ? '，旧资料已放入私聊，可切换后查看。' : '') : result?.error || '没有恢复备份', !result?.ok && !result?.canceled);
    if (result?.ok) { await loadMemoryStats(); await loadMemoryList(true); }
  } catch (error) { setNote('memoryActionNote', error.message || '恢复失败', true); }
  finally { $('backupPassphrase').value = ''; }
});
$('memoryClear').addEventListener('click', async () => {
  try {
    const result = await api('memoryClear');
    if (result !== true && !result?.ok) throw new Error(result?.error || '记忆没有清空');
    setNote('memoryActionNote', '本地记忆已清空'); await loadMemoryStats(); await loadMemoryList(true);
  } catch (error) { setNote('memoryActionNote', error.message || '清空失败', true); }
});

/* ── 桌面任务 ── */
let desktopStatus = null, paintedTaskId = null;
let resumePendingId = null, resumePreviousStatus = null, resumeTimer = null;
let workBuddyMonitorSnapshot = null;
let watchRows = [], watchRequestRevision = 0;
const watchActionsPending = new Set(), watchFeedback = new Map();
const PERMISSION_NAMES = { accessibilityTrusted: '辅助功能', screenCaptureAllowed: '屏幕录制', postEventAllowed: '输入控制', accessibility: '辅助功能', screenRecording: '屏幕录制', automation: '自动化', inputMonitoring: '输入监控' };
const TASK_STATUS_LABELS = { starting: '正在准备', running: '代理操作中', awaiting: '等待 WorkBuddy 开始处理', monitoring: '观察 WorkBuddy', verifying: '核对结果', paused: '代理已暂停', stopped: '代理已暂停', cancelled: '已取消', review: '待你确认', accepted: '你已确认', failed: '代理未完成' };
function taskStatusLabel(status) { return TASK_STATUS_LABELS[status] || labelStatus(status); }
function taskFieldValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  const parts = ['status', 'summary', 'result', 'note', 'evidence', 'message'].map(key => value[key]).filter(item => typeof item === 'string' && item.trim());
  if (typeof value.passed === 'boolean') parts.unshift(value.passed ? '符合' : '未确认');
  return parts.join(' · ');
}
function taskSourceLabel(task) {
  if (task?.inputSource === 'voice') return '口头交代';
  if (task?.inputSource === 'text') return '文字交代';
  if (task?.inputSource === 'panel' || task?.origin === 'panel') return '设定任务';
  return '对话交代';
}
function taskTargetLabel(target) {
  return target === 'workbuddy' ? 'WorkBuddy' : target === 'wechat' ? '微信' : '';
}
function verificationValue(value) {
  if (value && typeof value === 'object') {
    const verdicts = { pass: '核对通过', revise: '需要 WorkBuddy 修改', need_user: '需要你确认' };
    const label = verdicts[value.verdict];
    if (label) return `${label}${typeof value.report === 'string' && value.report.trim() ? `：${value.report}` : ''}`;
  }
  return taskFieldValue(value);
}
function displayValue(value) {
  if (value === true) return '已授权';
  if (value === false) return '未授权';
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${PERMISSION_NAMES[key] || key}：${displayValue(item)}`).join(' · ');
  return labelStatus(value);
}
function paintDesktopStatus(status) {
  desktopStatus = status || {};
  const task = desktopStatus.task || null;
  const running = !!desktopStatus.running || ['starting', 'running', 'awaiting', 'monitoring', 'verifying'].includes(task?.status);
  const tone = ['paused', 'stopped', 'failed'].includes(task?.status) ? 'bad' : ['starting', 'running', 'awaiting', 'monitoring', 'verifying', 'review'].includes(task?.status) ? 'warn' : 'ok';
  const taskLabel = task?.status === 'accepted' && task.automaticAccepted ? 'Bunny 已核对代理结果'
    : task?.status === 'review' && task.origin === 'dialogue' ? '已有结果，Bunny 正在核对' : task ? taskStatusLabel(task.status) : '';
  const taskId = task?.id || null;
  if (taskId !== paintedTaskId) {
    $('taskEvidenceDetails').open = false;
    $('taskPreview').open = false;
    paintedTaskId = taskId;
  }
  let resumeFeedback = '';
  if (resumePendingId && task?.id !== resumePendingId) {
    clearResumePending(); resumeFeedback = '当前代办已变化；继续请求尚未确认。';
  } else if (resumePendingId && task.status !== resumePreviousStatus) {
    clearResumePending(); resumeFeedback = `状态已更新：${taskLabel || '当前代办状态已变化'}`;
  }
  setPill('desktopStatus', task ? taskLabel : running ? '代理操作中' : '空闲', tone);
  const userReview = task?.status === 'review' && task.origin !== 'dialogue';
  const resumable = !!task?.id && task.target === 'workbuddy' && ['paused', 'stopped', 'review'].includes(task.status);
  $('taskStop').disabled = !running;
  $('taskStop').hidden = !running;
  $('taskStart').disabled = running;
  $('taskSetup').disabled = running;
  $('taskCancel').hidden = !task || ['accepted', 'failed', 'cancelled'].includes(task.status);
  $('taskCancel').disabled = false;
  $('taskAccept').disabled = !userReview;
  $('taskAccept').hidden = !userReview;
  $('taskResume').hidden = !resumable;
  $('taskResume').disabled = resumePendingId === task?.id;
  $('desktopActions').hidden = !running && !userReview && !resumable && $('taskCancel').hidden;
  const stateDetail = task?.status === 'verifying' ? ''
    : task?.status === 'review' && task.origin === 'dialogue' && /正在(?:核对|检查)/.test(task.note || '') ? ''
    : ['accepted', 'failed'].includes(task?.status) ? task.report || ''
      : task?.note || (running ? '代理操作正在进行' : '');
  const stateText = task ? [taskLabel, stateDetail && stateDetail !== taskLabel ? stateDetail : ''].filter(Boolean).join(' · ') : '没有正在进行的代理操作';
  $('taskStateNote').textContent = characterText(stateText, characterConfig);
  $('taskStateNote').dataset.characterText = stateText;
  $('taskStateNote').title = characterText(stateText, characterConfig);
  const pausableStates = ['starting', 'running', 'awaiting', 'monitoring', 'verifying', 'paused', 'stopped'];
  const pauseNote = task?.target === 'workbuddy' && pausableStates.includes(task.status)
    ? '暂停只停止 Bunny 的代理操作；WorkBuddy 已接收的会话可能仍在继续。'
    : task?.target === 'wechat' && pausableStates.includes(task.status)
      ? '暂停只停止 Bunny 的微信代理操作；微信中已发生的变化需要单独核对。' : '';
  const pauseNoteEl = $('taskPauseNote');
  pauseNoteEl.textContent = characterText(pauseNote, characterConfig);
  pauseNoteEl.dataset.characterText = pauseNote;
  pauseNoteEl.hidden = !pauseNote;
  const permissions = desktopStatus.permissions || {};
  const permissionList = $('permissionList'); permissionList.replaceChildren();
  const entries = Array.isArray(permissions) ? permissions.map((item) => [item.name || item.id, item.granted ?? item.status]) : Object.entries(permissions);
  if (!entries.length) permissionList.append(node('div', 'inline-note', '尚未读取权限状态'));
  for (const [key, value] of entries) {
    if (key === 'sessionLocked') {
      if (value) permissionList.append(node('div', 'inline-note bad-text', '电脑已锁屏，解锁后可操作桌面。'));
      continue;
    }
    const line = node('div', 'permission-line');
    line.append(node('span', '', PERMISSION_NAMES[key] || key), node('span', '', displayValue(value)));
    permissionList.append(line);
  }
  const details = $('taskDetails'); details.replaceChildren();
  $('taskEvidenceDetails').hidden = !task;
  const meta = $('taskMeta'), summary = $('taskSummary');
  meta.hidden = !task;
  summary.hidden = !task;
  if (task) {
    const source = taskSourceLabel(task), target = taskTargetLabel(task.target);
    meta.textContent = [source, target].filter(Boolean).join(' · ');
    const fullGoal = String(task.taskText || task.goal || '');
    summary.textContent = fullGoal;
    summary.title = fullGoal;
    const fields = [['goal', '任务'], ['criteria', '验收条件'], ['step', '步骤'], ['currentStep', '当前步骤'], ['message', '说明'], ['report', '执行报告'], ['result', '结果'], ['error', '状态说明']];
    for (const [key, title] of fields) { const value = taskFieldValue(task[key]); if (value) details.append(node('div', 'task-detail', `${title}：${value}`)); }
    const verification = verificationValue(task.verification);
    if (verification) details.append(node('div', 'task-detail', `核对结论：${verification}`));
    if (typeof task.monitorSummary === 'string' && task.monitorSummary.trim()) {
      const summary = node('details', 'task-monitor-summary');
      summary.append(node('summary', '', '查看 WorkBuddy 回复摘要'), node('div', 'task-detail', task.monitorSummary));
      details.append(summary);
    }
  }
  if (workBuddyMonitorSnapshot) paintWorkBuddyMonitor(workBuddyMonitorSnapshot);
  const shot = desktopStatus.screenshot || (typeof desktopStatus.lastScreenshot === 'string' ? desktopStatus.lastScreenshot : desktopStatus.lastScreenshot?.dataUrl);
  const preview = $('taskPreview'), image = $('taskScreenshot');
  if (typeof shot === 'string' && shot.startsWith('data:image/')) { image.src = shot; preview.hidden = false; }
  else { image.removeAttribute('src'); preview.hidden = true; preview.open = false; }
  if (resumeFeedback) setNote('desktopActionNote', resumeFeedback);
}
function clearResumePending() {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null; resumePendingId = null; resumePreviousStatus = null;
}
function paintWorkBuddyMonitor(snapshot) {
  workBuddyMonitorSnapshot = snapshot || null;
  const target = $('workbuddyMonitorTasks');
  if (!target) return;
  target.replaceChildren();
  const allTasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const sessionId = desktopStatus?.task?.monitorSessionId;
  const tasks = sessionId ? allTasks.filter(task => task.sessionId === sessionId) : allTasks;
  if (sessionId && !tasks.length) { target.append(node('div', 'inline-note', '正在等待该 WorkBuddy 会话的监视更新')); return; }
  if (!tasks.length) { target.append(node('div', 'inline-note', '暂未发现 WorkBuddy 会话任务')); return; }
  for (const task of tasks.slice(0, 6)) {
    const status = task.status === 'running' ? '进行中' : task.status === 'failed' ? '报告未完成' : task.status === 'abandoned' ? '已中断' : ['done', 'ok'].includes(task.status) ? '已有答复' : labelStatus(task.status);
    target.append(node('div', 'task-detail', `${task.name || task.title || 'WorkBuddy 任务'} · ${status}`));
  }
}
const WATCH_STATUS = { active: '关注中', paused: '已暂停', stopped: '已停止', needs_window: '需要打开目标应用', waiting: '等待新动态', expired: '已到期' };
function paintWatches(rows) {
  watchRequestRevision++;
  watchRows = Array.isArray(rows) ? rows : [];
  const list = $('watchList');
  if (!list) return;
  list.replaceChildren();
  const active = watchRows.filter(row => !['stopped', 'expired'].includes(row?.status));
  const inactive = watchRows.filter(row => ['stopped', 'expired'].includes(row?.status));
  if (!active.length && !inactive.length) {
    const empty = node('div', 'watch-empty', characterText('暂时没有持续关注。可以告诉 Bunny：“帮我关注某位联系人的新消息，有消息就告诉我。”', characterConfig));
    empty.dataset.characterText = '暂时没有持续关注。可以告诉 Bunny：“帮我关注某位联系人的新消息，有消息就告诉我。”';
    list.append(empty);
    return;
  }
  for (const row of active) list.append(makeWatchRow(row));
  if (inactive.length) {
    const details = node('details', 'watch-inactive');
    details.append(node('summary', '', `已停止或到期（${inactive.length}）`));
    const archive = node('div', 'watch-list');
    for (const row of inactive) archive.append(makeWatchRow(row));
    details.append(archive); list.append(details);
  }
}
function makeWatchRow(row) {
  const item = node('article', 'watch-item');
  if (typeof row.id === 'string') item.dataset.watchId = row.id;
  const target = row.target === 'workbuddy' ? 'WorkBuddy' : row.target === 'wechat' ? '微信' : '代理';
  const recipient = typeof row.recipient === 'string' && row.recipient.trim() ? row.recipient.trim() : target;
  const head = node('div', 'watch-item-head');
  head.append(node('span', 'watch-item-name', recipient), node('span', 'watch-item-status', WATCH_STATUS[row.status] || '状态待更新'));
  item.append(head);
  item.append(node('div', 'watch-item-meta', `${target} · ${row.mode === 'reply' ? '按规则回复' : '仅通知'}`));
  const goal = String(row.goal || '').trim();
  if (goal) { const summary = node('div', 'watch-item-note', goal); summary.title = goal; item.append(summary); }
  const note = watchFeedback.get(row.id) || String(row.note || '').trim();
  if (note) { const noteEl = node('div', 'watch-item-note', note); noteEl.title = note; item.append(noteEl); }
  const interval = Number.isFinite(row.intervalSeconds) && row.intervalSeconds > 0 ? `每 ${row.intervalSeconds} 秒检查` : '检查频率未知';
  const expiry = row.expiresAt ? `到期：${formatTime(row.expiresAt)}` : '持续至手动停止';
  item.append(node('div', 'watch-item-time', `${interval} · ${expiry}`));
  const checked = row.lastCheckedAt ? `上次检查：${formatTime(row.lastCheckedAt)}` : '尚未检查';
  const events = Number.isFinite(row.eventCount) && row.eventCount > 0 ? ` · 已发现 ${row.eventCount} 条动态` : '';
  item.append(node('div', 'watch-item-time', checked + events));
  const policy = String(row.policy || '').trim();
  if (policy) {
    const rules = node('details', 'watch-policy');
    rules.append(node('summary', '', '查看处理规则'), node('div', 'watch-item-note', policy));
    item.append(rules);
  }
  const actions = node('div', 'watch-item-actions');
  const isPending = watchActionsPending.has(row.id);
  const addAction = (label, method) => {
    const button = node('button', 'button quiet', label); button.type = 'button'; button.disabled = isPending;
    button.addEventListener('click', () => runWatchAction(row.id, method));
    actions.append(button);
  };
  if (row.status === 'active' || row.status === 'waiting' || row.status === 'needs_window') {
    addAction('暂停关注', 'watchPause');
    addAction('现在检查', 'watchCheck');
    addAction('停止关注', 'watchStop');
  } else if (row.status === 'paused') {
    addAction('继续关注', 'watchResume');
    addAction('停止关注', 'watchStop');
  }
  if (actions.childElementCount) item.append(actions);
  return item;
}
async function refreshWatches() {
  const revision = ++watchRequestRevision;
  try {
    const rows = await api('watchList');
    if (revision === watchRequestRevision) paintWatches(rows);
  } catch (error) {
    if (revision === watchRequestRevision) $('watchList').replaceChildren(node('div', 'watch-empty bad-text', error.message || '持续关注暂时无法读取'));
  }
}
async function runWatchAction(id, method) {
  if (watchActionsPending.has(id)) return;
  watchActionsPending.add(id); watchFeedback.set(id, '正在处理…'); paintWatches(watchRows);
  try {
    const result = await api(method, id);
    if (result === false || result?.ok === false) throw new Error(result?.error || '关注状态没有更新');
    watchFeedback.delete(id);
    await refreshWatches();
  } catch (error) {
    watchFeedback.set(id, error.message || '操作失败');
  } finally {
    watchActionsPending.delete(id); paintWatches(watchRows);
  }
}
async function refreshDesktop() {
  try { hideError(); paintDesktopStatus(await api('taskStatus')); }
  catch (error) { setPill('desktopStatus', '状态读取失败', 'bad'); showError(error); }
}
$('desktopRefresh').addEventListener('click', refreshDesktop);
$('taskSetup').onclick = () => { $('taskDialogNote').textContent = ''; $('taskDialog').showModal(); $('taskGoal').focus(); };
$('taskDialogClose').onclick = () => $('taskDialog').close();
$('desktopTabs').onclick = event => {
  const button = event.target.closest('[data-desktop-tab]'); if (!button) return;
  const tab = button.dataset.desktopTab;
  for (const el of $('desktopTabs').querySelectorAll('button')) { const on = el === button; el.classList.toggle('active', on); el.setAttribute('aria-selected', String(on)); }
  for (const el of document.querySelectorAll('[data-desktop-page]')) el.hidden = el.dataset.desktopPage !== tab;
};
$('workbuddyOpen').addEventListener('click', async () => {
  $('workbuddyOpen').disabled = true;
  try {
    const result = await api('workbuddyOpen');
    if (result === false || result?.ok === false) throw new Error(result?.error || 'WorkBuddy 没有打开');
    setNote('desktopActionNote', '已请求打开 WorkBuddy');
  } catch (error) { showError(error); }
  finally { $('workbuddyOpen').disabled = false; }
});
$('desktopPermission').addEventListener('click', async () => {
  $('desktopPermission').disabled = true;
  setNote('permissionNote', '正在打开系统权限请求…');
  try {
    const permissions = await api('desktopPermission');
    desktopStatus = { ...(desktopStatus || {}), permissions };
    paintDesktopStatus(desktopStatus);
    setNote('permissionNote', '检查完成；如仍未授权，请在系统设置中允许。');
  } catch (error) { setNote('permissionNote', error.message || '权限请求失败', true); }
  finally { $('desktopPermission').disabled = false; }
});
$('taskStart').addEventListener('click', async () => {
  const goal = $('taskGoal').value.trim();
  if (!goal) { $('taskDialogNote').textContent = '请写下要做的事情'; $('taskGoal').focus(); return; }
  $('taskStart').disabled = true; $('taskDialogClose').disabled = true;
  try {
    const result = await api('say', '请安排并执行这个任务：\n' + goal);
    if (!result?.ok) throw new Error(result?.error || '任务没有交代成功');
    $('taskDialog').close(); $('taskGoal').value = ''; setNote('desktopActionNote', '任务已交代，正在安排。'); await refreshDesktop();
  } catch (error) { $('taskDialogNote').textContent = error.message; }
  finally { $('taskStart').disabled = !!desktopStatus?.running; $('taskDialogClose').disabled = false; }
});
$('taskCancel').onclick = async () => {
  $('taskCancel').disabled = true;
  try { const result = await api('taskCancel'); if (!result?.ok) throw new Error(result?.error || '未能取消'); await refreshDesktop(); setNote('desktopActionNote', '已取消 Bunny 跟进。'); }
  catch (error) { showError(error); } finally { $('taskCancel').disabled = false; }
};
$('taskResume').addEventListener('click', async () => {
  const task = desktopStatus?.task;
  if (!task?.id || !['paused', 'stopped', 'review'].includes(task.status) || resumePendingId) return;
  resumePendingId = task.id; resumePreviousStatus = task.status;
  $('taskResume').disabled = true;
  setNote('desktopActionNote', '继续请求已发出，等待实际状态更新…');
  resumeTimer = setTimeout(async () => {
    if (resumePendingId !== task.id) return;
    clearResumePending();
    await refreshDesktop();
    if (desktopStatus?.task?.id === task.id && ['paused', 'stopped', 'review'].includes(desktopStatus.task.status)) {
      setNote('desktopActionNote', `当前仍为${taskStatusLabel(desktopStatus.task.status)}，继续状态尚未确认。`);
      $('taskResume').disabled = false;
    }
  }, 10000);
  try {
    const result = await api('say', '继续刚才的这件代办，请保留原任务，不重复发送。');
    if (!result?.ok) throw new Error(result?.error || '继续请求没有发出');
  } catch (error) {
    if (resumePendingId === task.id) clearResumePending();
    paintDesktopStatus(desktopStatus || {});
    setNote('desktopActionNote', error.message || '继续请求失败', true);
  }
});
$('taskStop').addEventListener('click', async () => {
  try { const result = await api('taskStop'); if (result === false || result?.ok === false) throw new Error(result?.error || '代理操作没有暂停'); setNote('desktopActionNote', '已暂停代理操作'); await refreshDesktop(); }
  catch (error) { showError(error); }
});
$('taskAccept').addEventListener('click', async () => {
  try { const result = await api('taskAccept'); if (result === false || result?.ok === false) throw new Error(result?.error || '任务没有验收'); setNote('desktopActionNote', '任务已验收'); await refreshDesktop(); }
  catch (error) { showError(error); }
});
if (page === 'memory') {
  initMemory();
  if (new URLSearchParams(location.search).get('section') === 'self') void selfEditor.open();
  let recallRevision = 0;
  if (typeof window.pet?.init === 'function') Promise.resolve(window.pet.init()).then(result => {
    if (recallRevision === 0) paintCurrentRecall(result?.currentRecall);
  }).catch(() => {});
  window.pet?.on?.(event => {
    if (event?.type === 'self-editor-open') void selfEditor.open();
    if (event?.type === 'memory-ready') { loadMemoryStats(); loadMemoryList(true); }
    else if (event?.type === 'memory-changed') scheduleMemoryRefresh();
    else if (event?.type === 'memory-maintenance') { paintMaintenanceStatus(event); if (event.status === 'idle') void loadMemoryStats(); }
    else if (event?.type === 'recall') { recallRevision++; paintCurrentRecall(event.entries); }
    else if (event?.type === 'config' && event.config) applyMemoryConfigUpdate(event.config);
  });
}
else {
  refreshDesktop();
  refreshWatches();
  $('watchRefresh').addEventListener('click', refreshWatches);
  if (typeof window.pet?.init === 'function') Promise.resolve(window.pet.init()).then(result => {
    setCharacterConfig(result?.config);
    paintWorkBuddyMonitor(result?.monitor);
    if (result?.desktop) paintDesktopStatus(result.desktop);
    if (Array.isArray(result?.watches)) paintWatches(result.watches);
  }).catch(() => {});
  if (typeof window.pet?.on === 'function') window.pet.on((event) => {
    if (event?.type === 'config' && event.config) setCharacterConfig(event.config);
    if (event?.type === 'desktop') paintDesktopStatus(event);
    else if (event?.type === 'monitor') paintWorkBuddyMonitor(event);
    else if (Array.isArray(event)) paintWatches(event);
    else if (event?.type === 'watches') paintWatches(event.watches || event.rows);
  });
}
