import { characterName, characterText, paintCharacterNames } from './character-name.mjs';
import { autoGrow } from './auto-grow.js';
const $ = id => document.getElementById(id);

export function createSelfSettings(pet, { save, getConfig = () => ({}) }) {
  let view, dirty = false, saving = false, understanding = false, loadTicket = 0;
  let phase = 'idle', outcome = '';
  let failedAt = 0;
  const status = text => { $('selfSettingsStatus').textContent = text; };
  const resize = () => { for (const id of ['setProfile', 'setBehavior']) autoGrow($(id)); };
  function paint() {
    const config = { ...getConfig(), buddy: { ...getConfig()?.buddy, name: $('setName').value || getConfig()?.buddy?.name } };
    const name = characterName(config);
    paintCharacterNames(config);
    $('selfUnderstand').textContent = understanding ? `${name}正在更新…` : `让${name}自己理解并更新`;
    $('selfUnderstand').title = `让${characterName(config, 64)}自己理解并更新`;
    $('selfUnderstand').disabled = !view || view.locked || saving || understanding;
    if (!view) return;
    status(understanding ? `${name}正在理解你的新设定…`
      : phase === 'failed' ? `${name}更新未完成：${characterText(outcome, config)}`
      : phase === 'completed' ? `${name}更新完毕。${characterText(outcome, config)}`
      : view.locked ? `自我理解已锁定。你仍可手工微调；如需${name}自己更新，请先在微调弹窗中解锁。`
      : view.pendingSettings ? `你的设定已保存，可点击按钮让${name}立即理解并更新。`
      : '三个场景共用同一份自我理解，可在“手工微调”中查看全部条目。');
  }
  async function load() {
    if (!$('setProfile') || saving) return;
    const ticket = ++loadTicket;
    try {
      const latest = await pet.selfView();
      if (ticket !== loadTicket || !latest || latest.revision < (view?.revision || 0)) return;
      // Keep the revision on which the draft was based, so a concurrent edit
      // cannot be overwritten by saving the old inputs.
      if (!dirty) {
        view = latest;
        $('setProfile').value = view.settings.identity;
        $('setBehavior').value = view.settings.behavior;
        resize();
      } else if (view && latest.revision !== view.revision) {
        view = { ...view, locked: latest.locked };
      }
      if (!dirty && !understanding && latest.understanding && !latest.pendingSettings && latest.understanding.at > failedAt) {
        phase = 'completed'; outcome = latest.understanding.summary || (latest.understanding.changed ? '已融合新设定，可以在“手工微调”中查看。' : '已核对新设定，本次保留原有理解。');
      }
      paint();
    } catch (error) { status(error.message); }
  }
  async function saveInputs() {
    if (!dirty) return;
    if (!view) throw new Error('请先在记忆窗口解锁本地资料库');
    if (saving) throw new Error('正在保存设定，请稍后');
    saving = true; loadTicket++; paint();
    const identity = $('setProfile').value, behavior = $('setBehavior').value;
    try {
      const submit = revision => pet.selfSettings({ identity, behavior, expectedRevision: revision, reflect: false });
      try { view = await submit(view.revision); }
      catch (error) {
        const latest = await pet.selfView().catch(() => null);
        // Entry revisions may advance while the owner is typing. Retry only
        // when their original input material is still exactly the same.
        if (!latest || latest.revision === view.revision || latest.settings.identity !== view.settings.identity || latest.settings.behavior !== view.settings.behavior) throw error;
        view = await submit(latest.revision);
      }
      dirty = $('setProfile').value !== identity || $('setBehavior').value !== behavior;
      phase = 'idle'; outcome = '';
    } finally { saving = false; paint(); }
  }
  queueMicrotask(() => {
    if (!$('selfUnderstand')) return;
    paint();
    $('setName').addEventListener('input', paint);
    for (const id of ['setProfile', 'setBehavior']) $(id).addEventListener('input', () => { dirty = true; resize(); if (!understanding) phase = 'idle'; paint(); });
    addEventListener('resize', resize);
    $('selfManual').addEventListener('click', () => pet.open('self'));
    $('selfUnderstand').addEventListener('click', async () => {
      if (understanding || saving || view?.locked) return;
      understanding = true; paint();
      try {
        await save();
        const result = await pet.selfReflect();
        if (!result?.ok) throw new Error(result?.error || '暂时无法完成理解与更新');
        view = result; phase = 'completed'; outcome = result.understanding?.summary || (result.changed ? '已融合新设定，可以在“手工微调”中查看。' : '已核对新设定，本次保留原有理解。');
      } catch (error) { phase = 'failed'; failedAt = Date.now(); outcome = String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
      finally { understanding = false; paint(); }
    });
    pet.on?.(event => { if (['memory-changed', 'memory-ready', 'self-changed'].includes(event.type)) void load(); });
  });
  return { load, saveInputs, paint, resize };
}
