import { characterText } from './character-name.mjs';
const $ = id => document.getElementById(id);
const facets = {
  identity: ['身份与定位', '我是谁，希望成为怎样的伙伴。'],
  trait: ['性格倾向', '我通常怎样感受、思考和表达。'],
  value: ['在意的原则', '我看重什么，作选择时遵循什么原则。'],
  behavior: ['相处与行为', '在具体情况下，我会怎样回应和行动。'],
  interest: ['兴趣与愿景', '我对什么好奇，希望持续探索什么。'],
};

export function createSelfEditor(pet, { getConfig = () => ({}) } = {}) {
  let view, saving = false, ticket = 0;
  const drafts = new Map(), dialog = $('selfDialog');
  const status = text => { $('selfStatus').textContent = text; };
  function element(tag, className = '', text = '') {
    const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
  }
  function button(text, run) {
    const el = element('button', 'button quiet', text);
    el.onclick = () => Promise.resolve(run()).catch(error => status(error.message));
    return el;
  }
  function paintControls() {
    for (const el of dialog.querySelectorAll('input,textarea,select,button:not(#selfClose)')) el.disabled = saving || !view;
    $('selfGlobalLock').textContent = view?.locked ? '解锁自我理解' : '锁定自我理解';
    $('selfGlobalLock').setAttribute('aria-pressed', String(!!view?.locked));
    $('selfLockNote').dataset.characterText = view?.locked
      ? '已锁定：Bunny 不会自行更新自我理解，你仍可手工修改全部条目。'
      : '未锁定：Bunny 可根据你的设定和相处经历更新理解。手工修改会保留修订记录。';
    $('selfLockNote').textContent = characterText($('selfLockNote').dataset.characterText, getConfig());
  }
  function summary() {
    return `共 ${view.entries.length} 条理解${drafts.size ? ` · ${drafts.size} 条微调未保存` : ''}${view.pendingSettings ? ' · 有待理解的新设定' : ''}`;
  }
  async function load(force = false) {
    if (saving || drafts.size && !force) return;
    const current = ++ticket;
    try {
      const latest = await pet.selfView();
      if (current !== ticket || !latest || latest.revision < (view?.revision || 0)) return;
      view = latest; render(); status(summary());
    } catch (error) { status(error.message); }
  }
  async function patch(ops, draftKey) {
    if (!view || saving) return;
    saving = true; ticket++; paintControls();
    let message;
    try {
      view = await pet.selfPatch({ baseRevision: view.revision, ops });
      if (draftKey) drafts.delete(draftKey);
      message = summary();
    } catch (error) { message = error.message + '。微调已保留，可刷新后核对并重试。'; }
    finally { saving = false; render(); status(message); }
  }
  function add(facet = 'behavior') {
    if (!view || saving) return;
    const key = 'new:' + crypto.randomUUID();
    drafts.set(key, { draftId: key, facet, text: '', condition: '' }); render();
    const box = [...$('selfEntries').querySelectorAll('.self-entry')].find(el => el.dataset.key === key);
    box?.scrollIntoView({ block: 'nearest' }); box?.querySelector('textarea').focus();
  }
  function entry(source) {
    const key = source.entryId || source.draftId, row = { ...source, ...drafts.get(key) };
    const box = element('article', 'self-entry'); box.dataset.key = key;
    const type = document.createElement('select'); type.setAttribute('aria-label', '理解的分类');
    for (const [facet, [name]] of Object.entries(facets)) {
      const option = element('option', '', name); option.value = facet; type.append(option);
    }
    type.value = row.facet;
    const text = document.createElement('textarea'); text.rows = 3; text.maxLength = 400;
    text.value = row.text; text.setAttribute('aria-label', '自我理解正文');
    const condition = document.createElement('input'); condition.type = 'text'; condition.maxLength = 160;
    condition.placeholder = '适用条件（可留空）'; condition.setAttribute('aria-label', '适用条件'); condition.value = row.condition;
    for (const field of [type, text, condition]) field.addEventListener('input', () => {
      drafts.set(key, { ...(row.entryId ? { entryId: row.entryId } : { draftId: key }), facet: type.value, text: text.value, condition: condition.value });
      status(summary());
    });
    const actions = element('div', 'record-actions');
    actions.append(button('保存这条', async () => {
      if (!text.value.trim()) return status('请填写这条理解的正文');
      await patch([{ op: row.entryId ? 'replace' : 'add', ...(row.entryId ? { entryId: row.entryId } : {}),
        facet: type.value, text: text.value, condition: condition.value }], key);
    }));
    actions.append(button(row.entryId ? '移除' : '取消新增', async () => {
      if (row.entryId) await patch([{ op: 'remove', entryId: row.entryId }], key);
      else { drafts.delete(key); render(); status(summary()); }
    }));
    const history = element('div', 'inline-note self-history');
    if (row.entryId) actions.append(button('修订记录', async () => {
      const rows = await pet.selfHistory(row.entryId);
      const origins = { 'owner-direct': '手工微调', 'dream-learning': 'Bunny 理解与更新', migration: '初始设定' };
      history.textContent = rows.map(item => `第 ${item.revision} 版 · ${new Date(item.ts).toLocaleString()} · ${characterText(origins[item.origin] || item.origin, getConfig())}\n${item.text}${item.condition ? '\n适用条件：' + item.condition : ''}`).join('\n\n') || '暂无修订记录';
    }));
    box.append(type, text, condition, actions, history); return box;
  }
  function render() {
    if (!view) return;
    const rows = [...view.entries.map(row => ({ ...row, ...drafts.get(row.entryId) })),
      ...[...drafts.values()].filter(row => row.draftId)];
    $('selfEntries').replaceChildren(...Object.entries(facets).map(([facet, [name, hint]]) => {
      const section = element('section', 'self-group'); section.dataset.facet = facet;
      const members = rows.filter(row => row.facet === facet), head = element('div', 'self-group-head');
      head.append(element('h3', '', `${name} · ${members.length} 条`), button('增加条目', () => add(facet)));
      section.append(head, element('p', 'inline-note self-group-note', hint), ...members.map(entry));
      return section;
    }));
    paintControls();
  }
  $('selfClose').onclick = () => dialog.close();
  $('selfGlobalLock').onclick = () => view && patch([{ op: view.locked ? 'unlock_all' : 'lock_all' }]);
  $('selfAdd').onclick = () => add();
  $('selfRefresh').onclick = () => load(true);
  pet.on?.(event => { if (['memory-changed', 'memory-ready', 'self-changed'].includes(event.type) && dialog.open) void load(); });
  paintControls();
  return { load, async open() { if (!dialog.open) dialog.showModal(); await load(true); } };
}
