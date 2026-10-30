export function setupAutonomy(pet) {
  const $ = id => document.getElementById(id);
  let state, revision = 0, timer, busy = false;
  const note = text => { $('autonomyStatus').textContent = text; };
  function paint() {
    if (!state) return;
    note(state.paused ? '自主生活已暂停' : state.note);
    $('autonomyPath').textContent = state.directory || '等待资料库就绪';
    $('autonomyPause').hidden = !!state.paused;
    $('autonomyResume').hidden = !state.paused;
    $('autonomyCancel').hidden = !state.running;
    for (const id of ['autonomyPause', 'autonomyResume', 'autonomyCancel', 'autonomyDirectory']) $(id).disabled = busy;
    const labels = { running:'正在尝试', paused:'已暂停', cancelled:'已取消', failed:'这次未完成', accepted:'已完成', stopped:'已暂停' };
    const list = $('autonomyHistory');
    list.replaceChildren(...(state.history || []).map(row => {
      const box = document.createElement('article'); box.className = 'record';
      const title = document.createElement('strong'); title.textContent = row.goal || '一件小事情';
      const meta = document.createElement('p'); meta.className = 'inline-note';
      meta.textContent = [new Date(row.at || row.startedAt).toLocaleString(), labels[row.status] || row.status].filter(Boolean).join(' · ');
      const content = document.createElement('p'); content.textContent = row.note || row.report || '';
      box.append(title, meta, content);
      for (const file of row.artifactManifest?.files || []) { const path = document.createElement('p'); path.className = 'inline-note artifact-path'; path.textContent = file.path; box.append(path); }
      return box;
    }));
    if (!list.children.length) list.textContent = '还没有生活记录，空闲时慢慢开始。';
  }
  async function load() {
    const current = ++revision;
    try { const result = await pet.autonomyStatus(); if (current !== revision || busy) return; state = result; paint(); }
    catch (error) { if (current === revision) note(error.message); }
  }
  async function operate(operation) {
    if (busy) return; busy = true; revision++; paint();
    let failure;
    try { const result = await operation(); if (result) state = result; }
    catch (error) { failure = error.message; }
    finally { busy = false; if (state) paint(); if (failure) note(failure); }
  }
  for (const [id, action] of [['autonomyPause','pause'],['autonomyResume','resume'],['autonomyCancel','cancel']]) $(id).onclick = () => operate(() => pet.autonomyControl(action));
  $('autonomyDirectory').onclick = () => operate(() => pet.autonomyDirectory());
  $('autonomyRefresh').onclick = load;
  pet.on(event => {
    if (event.type === 'config') { revision++; state = null; $('autonomyHistory').replaceChildren(); }
    if (['config','memory-ready','memory-changed'].includes(event.type)) { clearTimeout(timer); timer = setTimeout(load, 250); }
  });
  void load();
}
