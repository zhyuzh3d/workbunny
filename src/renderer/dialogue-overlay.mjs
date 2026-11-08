import { renderResultText } from './result-links.mjs';
const LIMIT = 120;
const key = row => ({ ts: row.ts, id: row.id });
const day = ts => { const d = new Date(ts); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const MODES = [
  { id: 'avatar', label: '仅角色', ui: { dialogueVisible: false, dialogueBehind: false, avatarHidden: false } },
  { id: 'behind', label: '角色后加文字', ui: { dialogueVisible: true, dialogueBehind: true, avatarHidden: false } },
  { id: 'front', label: '角色前加文字', ui: { dialogueVisible: true, dialogueBehind: false, avatarHidden: false } },
  { id: 'text', label: '仅文字', ui: { dialogueVisible: true, dialogueBehind: false, avatarHidden: true } },
];
function modeIndex(config) {
  if (!config.ui?.dialogueVisible) return 0;
  if (config.ui?.avatarHidden) return 3;
  return config.ui?.dialogueBehind ? 1 : 2;
}

export function createDialogueOverlay(pet, initialConfig) {
  const root = document.getElementById('dialogueOverlay'), scroll = document.getElementById('dialogueScroll');
  const list = document.getElementById('dialogueMessages'), newer = document.getElementById('dialogueLatest');
  const older = document.getElementById('dialogueOlder'), toggle = document.getElementById('dialogueBtn');
  let config = initialConfig, rows = [], before = null, after = null, latestKnown = null, topMore = false, bottomMore = false;
  let generation = 0, changes = 0, loading = false, follow = true, pending = false, timer = 0, frame = 0, retry = false, jumpRequested = false;
  const opened = () => config.ui?.dialogueVisible === true;
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 36;
  const anchor = () => [...list.children].find(el => el.dataset.id && el.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
  function badge() {
    newer.hidden = !(pending || bottomMore);
    newer.title = pending ? '有新消息，回到最新对话' : '回到最新对话';
    newer.setAttribute('aria-label', newer.title);
    newer.querySelector('span').textContent = pending ? '新消息' : '最新';
  }
  function paint() {
    const saved = anchor(), savedId = saved?.dataset.id, offset = saved?.getBoundingClientRect().top;
    const fragment = document.createDocumentFragment(); let previousDay = '';
    for (const row of rows) {
      const date = day(row.ts);
      if (date !== previousDay) { const divider = document.createElement('div'); divider.className = 'dialogue-date'; divider.textContent = date; fragment.append(divider); previousDay = date; }
      const article = document.createElement('article'); article.className = 'dialogue-message ' + row.role; article.dataset.id = row.id;
      const label = document.createElement('div'); label.className = 'dialogue-speaker';
      label.textContent = row.role === 'user' ? config.buddy?.ownerName || '主人' : config.buddy?.name || 'Bunny';
      const text = document.createElement('div'); text.className = 'dialogue-text';if(row.taskId&&row.links?.length)renderResultText(text,row.text,row.links,index=>pet.agentResultLink(row.taskId,index));else text.textContent = row.text;
      article.append(label, text); fragment.append(article);
    }
    list.replaceChildren(fragment);
    older.hidden = !topMore && !retry;
    older.textContent = retry ? '读取失败，点击重试' : '加载更早消息';
    document.getElementById('dialogueEmpty').hidden = rows.length > 0;
    const replacement = [...list.children].find(el => el.dataset.id === savedId);
    if (replacement) scroll.scrollTop += replacement.getBoundingClientRect().top - offset;
    badge();
  }
  async function load(direction = 'latest') {
    if (!opened() || loading) return;
    const current = generation, startedAtChange = changes; loading = true; retry = false;
    older.disabled = true; root.setAttribute('aria-busy', 'true');
    try {
      const page = await pet.dialogueHistory(direction === 'older' ? { before } : direction === 'newer' ? { after } : {});
      if (current !== generation || !opened() || page.scene !== config.memory?.scene) return;
      if (direction === 'latest' && rows.length && !follow) { pending = true; badge(); return; }
      if (direction === 'latest') {
        latestKnown = page.newest;
        rows = page.rows; before = page.oldest; after = page.newest; topMore = page.more; bottomMore = false; pending = changes !== startedAtChange; follow = true;
      } else {
        const ids = new Set(rows.map(r => r.id)), incoming = page.rows.filter(r => !ids.has(r.id));
        rows = direction === 'older' ? [...incoming, ...rows] : [...rows, ...incoming];
        if (direction === 'older') { before = page.oldest || before; topMore = page.more; }
        else { after = page.newest || after; bottomMore = page.more; }
        if (rows.length > LIMIT) {
          if (direction === 'older') { rows = rows.slice(0, LIMIT); after = key(rows.at(-1)); bottomMore = true; }
          else { rows = rows.slice(-LIMIT); before = key(rows[0]); topMore = true; }
        }
      }
      paint();
      if (direction === 'latest') scroll.scrollTop = scroll.scrollHeight;
      if (!rows.length) document.getElementById('dialogueEmpty').textContent = page.note || '还没有对话消息';
    } catch {
      if (current !== generation) return;
      retry = true; older.hidden = false; older.textContent = '读取失败，点击重试';
    } finally {
      if (current === generation) {
        loading = false; older.disabled = false; root.setAttribute('aria-busy', 'false');
        if (jumpRequested) { jumpRequested = false; follow = true; void load(); }
        else if (changes !== startedAtChange && follow && !retry) refresh();
      }
    }
  }
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!opened()) return;
      if (follow) { if (!loading) void load(); return; }
      const current = generation;
      try {
        const page = await pet.dialogueHistory({ probe: true });
        if (current !== generation || !opened() || page.scene !== config.memory?.scene) return;
        if (page.newest && (page.newest.id !== latestKnown?.id || page.newest.ts !== latestKnown?.ts)) { pending = true; badge(); }
      } catch { /* Keep the current reading position when a background check fails. */ }
    }, 100);
  }
  function reset() {
    generation++; loading = false; pending = false; retry = false; jumpRequested = false; follow = true; rows = []; before = after = latestKnown = null; topMore = bottomMore = false;
    clearTimeout(timer); paint(); if (opened()) void load();
  }
  function apply(next) {
    const old = config, wasOpen = opened(); config = next;
    const index = modeIndex(config), current = MODES[index], nextMode = MODES[(index + 1) % MODES.length];
    root.hidden = !opened(); toggle.dataset.mode = current.id;
    toggle.title = `当前：${current.label}；点击切换至${nextMode.label}`;
    toggle.setAttribute('aria-label', toggle.title);
    document.body.classList.toggle('dialogue-open', opened());
    document.body.classList.toggle('dialogue-behind', current.id === 'behind');
    document.body.classList.toggle('dialogue-avatar-hidden', current.id === 'text');
    document.body.classList.toggle('private-scene', config.memory?.scene === 'private');
    if (old.memory?.scene !== next.memory?.scene || old.memory?.enabled !== next.memory?.enabled || wasOpen !== opened()) reset();
  }
  toggle.onclick = async () => {
    toggle.disabled = true;
    try { apply(await pet.config({ ui: MODES[(modeIndex(config) + 1) % MODES.length].ui })); }
    catch { toggle.title = '显示模式切换失败，请重试'; }
    finally { toggle.disabled = false; }
  };
  older.onclick = () => void load(before ? 'older' : 'latest');
  newer.onclick = () => { follow = true; if (loading) { jumpRequested = true; return; } void load(); };
  addEventListener('dialogue-layout', () => {
    if (opened() && follow) scroll.scrollTop = scroll.scrollHeight;
  });
  const layoutObserver = new ResizeObserver(() => {
    if (opened() && follow && !loading) scroll.scrollTop = scroll.scrollHeight;
  });
  layoutObserver.observe(scroll);
  scroll.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0; follow = atBottom() && !bottomMore;
      if (loading) return;
      if (scroll.scrollTop < 100 && topMore) void load('older');
      else if (atBottom() && bottomMore) void load('newer');
    });
  });
  pet.on(event => {
    if (event.type === 'config' && event.config) apply(event.config);
    if (event.type === 'scene' && event.scene !== config.memory?.scene) apply({ ...config, memory: { ...config.memory, scene: event.scene } });
    if (event.type === 'dialogue-reset') reset();
    if (event.type === 'memory-changed' && opened()) { changes++; if (follow) pending = true; refresh(); }
  });
  apply(config); if (opened()) void load();
  return { reset, get state() { return { count: rows.length, topMore, bottomMore, follow, pending, loading }; } };
}
