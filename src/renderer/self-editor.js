import { characterText } from './character-name.mjs';
import { autoGrow } from './auto-grow.js';
const $ = id => document.getElementById(id);
const facets = { identity: '身份与定位', trait: '性格倾向', value: '在意的原则', behavior: '相处与行为', interest: '兴趣与愿景' };
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function createSelfEditor(pet, { getConfig = () => ({}) } = {}) {
  let view, saving = false, ticket = 0, editing = null;
  const dialog = $('selfDialog'), editor = $('selfEntryDialog');
  const status = text => { $('selfStatus').textContent = text; };
  function element(tag, className = '', text = '') {
    const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
  }
  function paintControls() {
    for (const el of dialog.querySelectorAll('button:not(#selfClose)')) el.disabled = saving || !view;
    for (const el of editor.querySelectorAll('input,textarea,select,button')) el.disabled = saving;
    $('selfEntrySave').disabled = saving || !!editing?.deleted;
    $('selfEntryDelete').disabled = saving || !!editing?.deleted;
    $('selfGlobalLock').textContent = view?.locked ? '解锁自我理解' : '锁定自我理解';
    $('selfGlobalLock').setAttribute('aria-pressed', String(!!view?.locked));
    $('selfLockNote').textContent = characterText(view?.locked
      ? '已锁定：Bunny 不会自行更新，你仍可手工修改。'
      : '未锁定：Bunny 可以根据设定与相处经历更新理解。', getConfig());
  }
  const summary = () => `共 ${view.entries.length} 条理解${view.pendingSettings ? ' · 有待理解的新设定' : ''}`;
  async function load() {
    if (saving || editor.open) return;
    const current = ++ticket;
    try {
      const latest = await pet.selfView();
      if (current !== ticket || editor.open || !latest || latest.revision < (view?.revision || 0)) return;
      view = latest; render(); status(summary());
    } catch (error) { status(errorText(error)); }
  }
  async function patch(ops, fromEditor = false) {
    if (!view || saving) return false;
    const revision = fromEditor ? editing.baseRevision : view.revision;
    saving = true; ticket++; paintControls();
    try {
      view = await pet.selfPatch({ baseRevision: revision, ops });
      status(summary()); return true;
    } catch (error) {
      let message = errorText(error);
      const latest = await pet.selfView().catch(() => null);
      if (latest && latest.revision > view.revision) {
        view = latest;
        if (fromEditor && editing) {
          editing.baseRevision = latest.revision; editing.historyLoaded = false;
          editing.deleted = !!editing.entryId && !latest.entries.some(row => row.entryId === editing.entryId);
          message = editing.deleted ? '这条理解已被删除，当前输入仍保留，可复制后重新添加。'
            : '自我理解刚被更新。当前输入已保留，请核对修订记录，再次保存会采用当前编辑。';
          if (editing.entryId && $('selfEntryHistory').open) void loadHistory();
        }
      }
      if (fromEditor) $('selfEntryStatus').textContent = message; else status(message);
      return false;
    } finally { saving = false; render(); }
  }
  function openEntry(source = { facet: 'behavior', text: '', condition: '' }) {
    if (!view || saving) return;
    editing = { ...source, baseRevision: view.revision, token: crypto.randomUUID(), historyLoaded: false };
    $('selfEntryTitle').textContent = source.entryId ? '编辑理解' : '添加理解';
    $('selfEntryFacet').value = source.facet || 'behavior';
    $('selfEntryText').value = source.text || ''; $('selfEntryCondition').value = source.condition || '';
    $('selfEntryHistory').open = false; $('selfEntryHistory').hidden = !source.entryId;
    $('selfEntryHistoryList').replaceChildren(); $('selfEntryStatus').textContent = '';
    $('selfEntryDelete').hidden = !source.entryId;
    paintControls(); editor.showModal(); autoGrow($('selfEntryText')); $('selfEntryText').focus();
  }
  function closeEntry() { if (!saving) { editing = null; editor.close(); } }
  async function loadHistory() {
    const current = editing;
    if (!current?.entryId || current.historyLoaded) return;
    const history = $('selfEntryHistoryList'); history.textContent = '正在读取…';
    try {
      const rows = await pet.selfHistory(current.entryId);
      if (editing !== current || !editor.open) return;
      const origins = { 'owner-direct': '手工微调', 'dream-learning': 'Bunny 理解与更新', migration: '初始设定' };
      history.replaceChildren(...rows.map(item => {
        const row = element('article', 'self-revision');
        row.append(element('div', 'inline-note', `第 ${item.revision} 版 · ${new Date(item.ts).toLocaleString()} · ${characterText(origins[item.origin] || item.origin, getConfig())}`),
          element('div', 'self-revision-text', item.text || ''), ...(item.condition ? [element('div', 'inline-note', '条件：' + item.condition)] : []));
        return row;
      }));
      if (!rows.length) history.textContent = '暂无修订记录';
      current.historyLoaded = true;
    } catch (error) { if (editing === current) history.textContent = errorText(error); }
  }
  function render() {
    if (!view) return;
    const list = $('selfEntries'), top = list.scrollTop;
    list.replaceChildren(...view.entries.map(row => {
      const box = element('article', 'self-entry'); box.dataset.key = row.entryId; box.dataset.facet = row.facet;
      const main = element('div', 'self-entry-main'), meta = element('div', 'self-entry-meta');
      meta.append(element('span', 'self-facet', facets[row.facet] || row.facet));
      if (row.locked) meta.append(element('span', 'inline-note', '固定'));
      main.append(meta, element('p', 'self-entry-text', row.text));
      if (row.condition) main.append(element('p', 'self-entry-condition', '条件：' + row.condition));
      const edit = element('button', 'button quiet self-edit', '编辑'); edit.type = 'button';
      edit.setAttribute('aria-label', '编辑此条理解'); edit.onclick = () => openEntry(row);
      box.append(main, edit); return box;
    }));
    if (!view.entries.length) list.append(element('p', 'inline-note', '还没有自我理解，点击“添加理解”开始。'));
    list.scrollTop = top; paintControls();
  }
  for (const [value, label] of Object.entries(facets)) { const option = element('option', '', label); option.value = value; $('selfEntryFacet').append(option); }
  $('selfEntryText').addEventListener('input', () => autoGrow($('selfEntryText')));
  addEventListener('resize', () => { if (editor.open) autoGrow($('selfEntryText')); });
  $('selfEntryHistory').ontoggle = () => { if ($('selfEntryHistory').open) void loadHistory(); };
  $('selfEntryClose').onclick = $('selfEntryCancel').onclick = closeEntry;
  editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  editor.addEventListener('close', () => { if (!editor.open) editing = null; });
  $('selfEntrySave').onclick = async () => {
    if (!editing || saving) return;
    const text = $('selfEntryText').value.trim();
    if (!text) { $('selfEntryStatus').textContent = '请填写理解内容'; $('selfEntryText').focus(); return; }
    const op = { op: editing.entryId ? 'replace' : 'add', ...(editing.entryId ? { entryId: editing.entryId } : {}),
      facet: $('selfEntryFacet').value, text, condition: $('selfEntryCondition').value.trim() };
    if (await patch([op], true)) closeEntry();
  };
  $('selfEntryDelete').onclick = async () => {
    if (!editing?.entryId || saving || !confirm('删除这条自我理解？')) return;
    if (await patch([{ op: 'remove', entryId: editing.entryId }], true)) closeEntry();
  };
  $('selfClose').onclick = () => window.close();
  $('selfGlobalLock').onclick = () => view && patch([{ op: view.locked ? 'unlock_all' : 'lock_all' }]);
  $('selfAdd').onclick = () => openEntry(); $('selfRefresh').onclick = load;
  pet.on?.(event => { if (['memory-changed', 'memory-ready', 'self-changed'].includes(event.type)) void load(); });
  paintControls();
  return { load };
}
