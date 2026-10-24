const $ = (id) => document.getElementById(id);
const page = new URLSearchParams(location.search).get('p') === 'desktop' ? 'desktop' : 'memory';
$(page === 'desktop' ? 'desktopPage' : 'memoryPage').hidden = false;

function node(tag, className = '', text = '') {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined && text !== null) item.textContent = String(text);
  return item;
}
function setNote(id, message, bad = false) {
  const target = $(id);
  if (!target) return;
  target.textContent = message || '';
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
  const labels = { pending: '待确认', accepted: '已确认', rejected: '已忽略', ready: '已就绪', unavailable: '不可用',
    enabled: '已启用', disabled: '已停用', running: '运行中', completed: '已完成', failed: '未完成', stopped: '已停止' };
  return labels[String(value)] || String(value ?? '—');
}

/* ── 记忆 ── */
let memoryKind = 'memory', memoryQuery = '', memoryCursor = null, memoryHasMore = false, memoryPageCount = 0;
let memoryRows = [], memoryStats = null, memoryCfg = {}, savedMemoryCfg = {}, memoryCfgWriting = false;
let memoryCfgPending = false;
let memoryRefreshPending = false, memoryRefreshTimer = null, memoryRefreshBusy = false;
let memoryViewRevision = 0;
let memoryListBusyRevision = 0;
function countValue(value) { return typeof value === 'number' ? value : Number(value?.count ?? value?.total ?? 0) || 0; }
function countsObject(stats) { return stats?.counts && typeof stats.counts === 'object' ? stats.counts : {}; }
function setPill(id, text, tone = '') {
  const el = $(id); el.textContent = text; el.className = `status-pill${tone ? ` ${tone}` : ''}`;
}
function paintMemoryStats(stats) {
  memoryStats = stats || {};
  const counts = countsObject(memoryStats);
  const state = memoryStats.state && typeof memoryStats.state === 'object' ? memoryStats.state : null;
  const stateLabel = state ? [state.mood, Number.isFinite(state.energy) ? `精力 ${Math.round(state.energy <= 1 ? state.energy * 100 : state.energy)}%` : ''].filter(Boolean).join(' · ') : '';
  $('memoryUnlock').hidden = memoryStats.ready !== false || !!memoryStats.opening;
  if (memoryStats.locked) setPill('memoryStatus', '电脑解锁后载入记忆', 'warn');
  else if (memoryStats.opening) setPill('memoryStatus', '正在解锁记忆 · 请留意 macOS 授权', 'warn');
  else if (memoryStats.error) setPill('memoryStatus', `读取失败 · ${memoryStats.error}`, 'bad');
  else if (memoryStats.ready === false) setPill('memoryStatus', '记忆服务未就绪', 'warn');
  else setPill('memoryStatus', stateLabel || '已就绪', 'ok');
  const target = $('memoryCounts'); target.replaceChildren();
  for (const [key, title] of [['memory', '长期记忆'], ['message', '聊天记录'], ['summary', '对话摘要']]) {
    const box = node('div', 'count-box');
    box.append(node('b', '', countValue(counts[key])));
    box.append(node('span', '', title));
    target.append(box);
  }
}
function memoryConfigFrom(result) {
  const root = result?.config || result || {};
  const value = root.memory && typeof root.memory === 'object' ? root.memory : {};
  memoryCfg = { enabled: !!value.enabled, extract: !!value.extract };
  savedMemoryCfg = { ...memoryCfg };
  paintMemoryConfig();
}
function paintMemoryConfig() {
  $('memoryEnabled').checked = memoryCfg.enabled;
  $('memoryExtract').checked = memoryCfg.extract;
}
function configDraftLabel(draft) {
  return `使用记忆：${draft.enabled ? '开' : '关'}，整理新记忆：${draft.extract ? '开' : '关'}`;
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
  if (!memoryCfgPending) return;
  event.preventDefault(); event.returnValue = '';
});
function rowSourceIds(row) {
  const sources = Array.isArray(row.sources) ? row.sources : [];
  return sources.map((source) => typeof source === 'string' ? source : source?.id).filter(Boolean);
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
  const card = node('article', 'record');
  const top = node('div', 'record-top');
  top.append(node('span', 'record-date', formatTime(row.ts)));
  if (row.role) top.append(node('span', 'badge', row.role));
  if (row.status) top.append(node('span', `badge${row.status === 'pending' ? ' pending' : ''}`, labelStatus(row.status)));
  card.append(top);
  card.append(node('div', `record-content${row.role ? ' role' : ''}`, row.content || '（空内容）'));
  if (row.evidence) card.append(node('div', 'record-source', `依据：${row.evidence}`));
  const actions = node('div', 'record-actions');
  let editBox = null;
  if (row.kind === 'memory') {
    addAction(actions, '编辑', () => {
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
    if (row.status === 'pending') addAction(actions, '确认', async () => {
      try {
        hideError();
        const result = await api('memoryUpdate', row.id, row.content || '');
        if (!result?.ok) throw new Error(result?.error || '没有确认记忆');
        setNote('memoryActionNote', '记忆已确认'); await loadMemoryStats(); await loadMemoryList(true);
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
      } catch (error) { showError(error); }
    });
    addAction(actions, '删除', async () => {
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
async function loadMemoryStats() {
  try { paintMemoryStats(await api('memoryStats')); }
  catch (error) { paintMemoryStats({ ready: false, error: error.message }); }
}
async function loadMemoryList(reset = false) {
  const revision = ++memoryViewRevision;
  hideError();
  if (reset) { memoryCursor = null; memoryRows = []; memoryPageCount = 0; }
  const view = { kind: memoryKind, query: memoryQuery, cursor: memoryCursor && { ...memoryCursor } };
  memoryListBusyRevision = revision;
  $('memoryListNote').textContent = '正在读取…'; $('memoryMore').hidden = true;
  try {
    const options = { kind: view.kind, query: view.query };
    if (view.cursor) { options.before = view.cursor.ts; options.beforeId = view.cursor.id; }
    const result = await api('memoryList', options);
    if (memoryListBusyRevision === revision) memoryListBusyRevision = 0;
    if (revision !== memoryViewRevision) return;
    if (hasOpenMemoryEditor()) { memoryRefreshPending = true; return; }
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    memoryRows = reset ? rows : memoryRows.concat(rows);
    if (rows.length) memoryPageCount = reset ? 1 : memoryPageCount + 1;
    const target = $('memoryList'); target.replaceChildren(...memoryRows.map(renderRecord));
    const last = rows.at(-1);
    memoryCursor = last ? { ts: last.ts, id: last.id } : memoryCursor;
    memoryHasMore = !memoryQuery && (typeof result?.hasMore === 'boolean' ? result.hasMore : rows.length > 0);
    $('memoryMore').hidden = !memoryHasMore || !last;
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
  const view = { kind: memoryKind, query: memoryQuery, pageCount: memoryQuery ? 1 : Math.max(1, memoryPageCount) };
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
      const options = { kind: view.kind, query: view.query };
      if (cursor) { options.before = cursor.ts; options.beforeId = cursor.id; }
      const result = await api('memoryList', options);
      if (revision !== memoryViewRevision) return;
      if (hasOpenMemoryEditor()) { memoryRefreshPending = true; return; }
      const batch = Array.isArray(result) ? result : (result?.rows || []);
      rows.push(...batch);
      const last = batch.at(-1);
      if (last) cursor = { ts: last.ts, id: last.id };
      hasMore = !view.query && (typeof result?.hasMore === 'boolean' ? result.hasMore : batch.length > 0);
      if (!last || !hasMore) break;
    }
    memoryRows = rows;
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
  await loadMemoryList(true);
}
$('memoryUnlock').addEventListener('click', async () => { try { paintMemoryStats(await api('memoryUnlock')); await loadMemoryList(true); } catch (error) { showError(error); } });
$('memoryTabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-kind]');
  if (!button) return;
  memoryKind = button.dataset.kind;
  for (const tab of $('memoryTabs').querySelectorAll('.tab')) tab.classList.toggle('active', tab === button);
  loadMemoryList(true);
});
$('memorySearchBtn').addEventListener('click', () => { memoryQuery = $('memorySearch').value.trim(); loadMemoryList(true); });
$('memorySearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('memorySearchBtn').click(); } });
$('memoryMore').addEventListener('click', () => { if (memoryHasMore) loadMemoryList(false); });
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
    setNote('memoryActionNote', result?.canceled ? '已取消' : result?.ok ? '备份已恢复' : result?.error || '没有恢复备份', !result?.ok && !result?.canceled);
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
let desktopStatus = null, insertPending = false, insertPromise = null;
const PERMISSION_NAMES = { accessibilityTrusted: '辅助功能', screenCaptureAllowed: '屏幕录制', postEventAllowed: '输入控制', accessibility: '辅助功能', screenRecording: '屏幕录制', automation: '自动化', inputMonitoring: '输入监控' };
const TASK_STATUS_LABELS = { starting: '正在准备', running: '运行中', paused: '已暂停', stopped: '已停止', review: '等待验收', accepted: '已验收' };
function taskStatusLabel(status) { return TASK_STATUS_LABELS[status] || labelStatus(status); }
function displayValue(value) {
  if (value === true) return '已授权';
  if (value === false) return '未授权';
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${PERMISSION_NAMES[key] || key}：${displayValue(item)}`).join(' · ');
  return labelStatus(value);
}
function paintDesktopStatus(status) {
  desktopStatus = status || {};
  const task = desktopStatus.task || null;
  const running = !!desktopStatus.running;
  const tone = running ? 'warn' : task?.status === 'paused' ? 'bad' : task?.status === 'review' ? 'warn' : 'ok';
  setPill('desktopStatus', running ? '任务运行中' : task ? taskStatusLabel(task.status) : '空闲', tone);
  $('taskStop').disabled = !running;
  $('taskStart').disabled = running;
  $('taskAccept').disabled = task?.status !== 'review';
  $('taskStateNote').textContent = running ? task?.note || '任务正在执行' : task ? [taskStatusLabel(task.status), task.note].filter(Boolean).join(' · ') : '没有正在运行的任务';
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
  if (task) {
    const fields = [['goal', '任务'], ['target', '目标'], ['step', '步骤'], ['currentStep', '当前步骤'], ['message', '说明'], ['result', '结果'], ['error', '状态说明']];
    for (const [key, title] of fields) if (task[key]) details.append(node('div', 'task-detail', `${title}：${task[key]}`));
  }
  const shot = desktopStatus.screenshot || (typeof desktopStatus.lastScreenshot === 'string' ? desktopStatus.lastScreenshot : desktopStatus.lastScreenshot?.dataUrl);
  const preview = $('taskPreview'), image = $('taskScreenshot');
  if (typeof shot === 'string' && shot.startsWith('data:image/')) { image.src = shot; preview.hidden = false; }
  else { image.removeAttribute('src'); preview.hidden = true; }
}
async function refreshDesktop() {
  try { hideError(); paintDesktopStatus(await api('taskStatus')); }
  catch (error) { setPill('desktopStatus', '状态读取失败', 'bad'); showError(error); }
}
$('desktopRefresh').addEventListener('click', refreshDesktop);
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
  if (!goal) { showError(new Error('请先写下任务内容')); $('taskGoal').focus(); return; }
  try {
    hideError(); $('taskStart').disabled = true;
    const result = await api('taskStart', { goal, target: $('taskTarget').value });
    if (!result?.ok) throw new Error(result?.error || '任务没有开始');
    setNote('desktopActionNote', '任务已开始'); await refreshDesktop();
  } catch (error) { showError(error); }
  finally { $('taskStart').disabled = !!desktopStatus?.running; }
});
$('taskStop').addEventListener('click', async () => {
  try { const result = await api('taskStop'); if (result === false || result?.ok === false) throw new Error(result?.error || '任务没有停止'); setNote('desktopActionNote', '已请求停止任务'); await refreshDesktop(); }
  catch (error) { showError(error); }
});
$('taskAccept').addEventListener('click', async () => {
  try { const result = await api('taskAccept'); if (result === false || result?.ok === false) throw new Error(result?.error || '任务没有验收'); setNote('desktopActionNote', '任务已验收'); await refreshDesktop(); }
  catch (error) { showError(error); }
});
async function cancelInsert() {
  if (!insertPending) return;
  $('desktopInsertCancel').disabled = true;
  setNote('desktopInsertNote', '正在取消…');
  try {
    const result = await api('taskStop');
    if (result === false || result?.ok === false) throw new Error(result?.error || '取消没有完成');
    setNote('desktopInsertNote', '已取消输入');
  } catch (error) { setNote('desktopInsertNote', error.message || '取消失败', true); }
  finally { $('desktopInsertCancel').disabled = false; }
}
$('desktopInsertCancel').addEventListener('click', cancelInsert);
$('desktopInsert').addEventListener('click', async () => {
  const text = $('desktopInsertText').value;
  if (!text.trim()) { setNote('desktopInsertNote', '请先写下要输入的文字', true); $('desktopInsertText').focus(); return; }
  if (insertPending) return;
  insertPending = true; $('desktopInsert').disabled = true; $('desktopInsertCancel').hidden = false;
  setNote('desktopInsertNote', '请求已发出；服务将在 3 秒内输入，请切换焦点。');
  insertPromise = (async () => {
    try {
      const result = await api('desktopInsert', text);
      if (!result?.ok) throw new Error(result?.error || '没有输入文字');
      setNote('desktopInsertNote', '文字已输入');
    } catch (error) { setNote('desktopInsertNote', error.message || '输入失败', true); }
    finally {
      insertPending = false; insertPromise = null;
      $('desktopInsert').disabled = false; $('desktopInsertCancel').hidden = true;
    }
  })();
  await insertPromise;
});

addEventListener('beforeunload', () => {
  if (insertPending) { try { api('taskStop'); } catch {} }
});

if (page === 'memory') {
  initMemory();
  window.pet?.on?.(event => {
    if (event?.type === 'memory-ready') { loadMemoryStats(); loadMemoryList(true); }
    else if (event?.type === 'memory-changed') scheduleMemoryRefresh();
  });
}
else {
  refreshDesktop();
  if (typeof window.pet?.on === 'function') window.pet.on((event) => { if (event?.type === 'desktop') paintDesktopStatus(event); });
}
