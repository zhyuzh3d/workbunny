export function setupAutonomy(pet) {
  const $ = id => document.getElementById(id);
  let state, directory = '', dirty = false;
  const note = text => { $('autonomyStatus').textContent = text; };
  function paint() {
    if (!state) return;
    const grant = state.grants.find(g => g.kind === $('autonomyKind').value);
    if (!dirty) {
      $('autonomySubject').value = grant?.subject || '';
      $('autonomyScene').value = grant?.scene || 'life';
      directory = grant?.directory || '';
    }
    $('autonomyPath').textContent = directory || '尚未选择目录';
    $('autonomyDirectory').hidden = $('autonomyKind').value !== 'create';
    $('autonomyGrants').textContent = state.grants.map(g => `${g.kind === 'create' ? '本地创作' : '桌面问候'}：${g.enabled && g.expiresAt > Date.now() ? '已授权至 ' + new Date(g.expiresAt).toLocaleString() : '未启用或已到期'}`).join('；');
    note(state.note);
    const list = $('growthList');
    if (list) {
      const labels = { user_model: '对你的认识', relationship: '相处理解', strategy: '相处方式', pursuit: '在意的目标',
        tentative: '暂定', stable: '稳定', recheck: '待重看', active: '正在尝试', paused: '暂缓', done: '已完成', abandoned: '已结束' };
      list.replaceChildren(...(state.growth || []).map(row => {
        const box = document.createElement('article'); box.className = 'record';
        const title = document.createElement('strong'); title.textContent = `${labels[row.type]} · ${labels[row.status]}`;
        const content = document.createElement('p'); content.textContent = row.content;
        const detail = document.createElement('p'); detail.className = 'inline-note';
        detail.textContent = [row.condition && '适用时：' + row.condition, row.nextStep && '下一步：' + row.nextStep,
          '最近核对：' + new Date(row.lastVerifiedAt).toLocaleString()].filter(Boolean).join('；');
        const evidence = document.createElement('div'); evidence.className = 'inline-note';
        evidence.textContent = [...row.support.map(q => '依据：“' + q.quote + '”'), ...row.counter.map(q => '反例：“' + q.quote + '”')].join('\n');
        const remove = document.createElement('button'); remove.className = 'button quiet'; remove.textContent = '移除这项';
        remove.onclick = async () => { remove.disabled = true; try { state = await pet.growthDismiss(row.entryId); paint(); } catch (e) { note(e.message); } finally { remove.disabled = false; } };
        box.append(title, content, detail, evidence, remove); return box;
      }));
      if (!list.children.length) list.textContent = '还没有形成可保留的认识或目标，随相处和尝试逐渐积累。';
    }
  }
  async function load() { const ticket = ++revision; try { const result = await pet.autonomyStatus(); if (ticket !== revision) return; state = result; paint(); } catch (e) { if (ticket === revision) note(e.message); } }
  async function save(enabled) {
    $('autonomyEnable').disabled = $('autonomyRevoke').disabled = true;
    try {
      state = await pet.autonomySave({ kind: $('autonomyKind').value, enabled, directory,
        subject: $('autonomySubject').value, scene: $('autonomyScene').value, days: Number($('autonomyDays').value) });
      dirty = false; paint();
    } catch (e) { note(e.message); }
    finally { $('autonomyEnable').disabled = $('autonomyRevoke').disabled = false; }
  }
  $('autonomyKind').onchange = () => { dirty = false; paint(); };
  for (const id of ['autonomySubject', 'autonomyScene']) $(id).oninput = () => { dirty = true; };
  $('autonomyDirectory').onclick = async () => { try { const selected = await pet.autonomyDirectory(); if (selected) { directory = selected; dirty = true; paint(); } } catch (e) { note(e.message); } };
  $('autonomyEnable').onclick = () => save(true);
  $('autonomyRevoke').onclick = () => save(false);
  $('autonomyRefresh').onclick = load;
  let refreshTimer, revision = 0;
  pet.on(event => {
    if (event.type === 'config') {
      revision++; state = null; $('growthList')?.replaceChildren(); clearTimeout(refreshTimer); void load();
    } else if (['memory-ready', 'memory-changed'].includes(event.type)) {
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void load(); }, 250);
    }
  });
  void load();
}
