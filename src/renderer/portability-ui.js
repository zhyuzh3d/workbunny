import { paintCredential, credentialCleared } from './credential-input.js';
export async function mountPortability(pet) {
  const $ = id => document.getElementById(id);
  let state = await pet.portability(), initial = await pet.panelInit(), config = initial.config;
  state.asr = initial.asr || {};
  function paint() {
    $('storagePath').textContent = state.storage.dir || state.storage.error;
    $('storageMove').disabled = !state.storage.ok || state.storage.busy;
    const needsNetwork = state.asrMode === 'single' && state.asr.onDevice === false;
    $('asrNetworkRow').hidden = !needsNetwork;
    $('asrModeInfo').hidden = !needsNetwork;
    $('asrModeInfo').textContent = needsNetwork ? '当前语音识别需要网络。' : '';
    $('setAlways').disabled = false;
    if ($('brainSource').value === 'workbuddy') $('brainStatus').textContent = state.connection.note;
    if ($('openWorkBuddy')) $('openWorkBuddy').textContent = state.connection.ready ? '重新连接 WorkBuddy' : '连接 WorkBuddy';
  }
  $('installWorkBuddy').onclick = () => pet.open('workbuddy-download');
  paint();
  $('asrAllowNetwork').checked = !!config.asr.allowNetwork;
  $('asrAllowNetwork').onchange = async () => { try { await pet.config({ asr: { allowNetwork: $('asrAllowNetwork').checked } }); } catch (e) { $('permTip').textContent = e.message; } };
  pet.on(ev => { if (ev.type === 'config' && ev.config) config = ev.config; if (ev.type === 'workbuddy-connection') { state.connection = ev; paint(); } if (ev.type === 'asrStatus') { state.asr = {...state.asr,...ev}; if(ev.mode) state.asrMode = ev.mode; paint(); } });
  for (const [id, operation] of [['storageMove', () => pet.storageMigrate()], ['storageReconnect', () => pet.storageReconnect()]]) $(id).onclick = async () => {
    $(id).disabled = true; $('storageStatus').textContent = '正在处理，请勿断开磁盘…';
    try { const r = await operation(); $('storageStatus').textContent = r.cancelled ? '' : r.ok ? '位置已更新，正在重启…' : r.error; }
    catch (e) { $('storageStatus').textContent = e.message; }
    finally { if (!state.storage.busy) $(id).disabled = false; }
  };
  let profile = config.tts.http?.profile || await pet.ttsHTTPTemplate('jsonl');
  let stored = config.tts.http || {};
  function renderProfile(keepSecrets = false) {
    const draftSecrets = keepSecrets ? new Map([...$('httpSecrets').querySelectorAll('input')].map(x => [x.dataset.secret, {value:x.value,cleared:credentialCleared(x)}])) : new Map();
    $('httpProfile').value = JSON.stringify(profile, null, 2); $('httpURL').value = profile.url || '';
    for (const [id, key] of [['httpModel', 'model'], ['httpVoice', 'voice'], ['httpResource', 'resourceId']]) $(id).value = stored.params?.[key] || '';
    const names = new Set();
    function walk(v) { if (!v || typeof v !== 'object') return; if (v.$secret) names.add(v.$secret); else Object.values(v).forEach(walk); } walk(profile);
    $('httpSecrets').replaceChildren();
    for (const name of names) {
      const row = document.createElement('label'); row.className = 'row'; const label = document.createElement('span');
      label.textContent = name === 'authorization' ? '鉴权值' : name; const input = document.createElement('input');
      input.type = 'password'; input.autocomplete = 'off'; input.dataset.secret = name; input.value = draftSecrets.get(name)?.value || '';
      input.placeholder = stored.hasSecrets?.[name] ? '已保存，留空保持' : name === 'authorization' ? '例如 Bearer 加密钥' : '请输入凭据';
      row.append(label, input); $('httpSecrets').append(row);
      if (!globalThis.BunnyCredential.isPassword(name)) paintCredential(input, input.value, {preview:stored.secretPreviews?.[name], preserveEmpty:true,cleared:draftSecrets.get(name)?.cleared});
    }
  }
  renderProfile();
  $('httpProfile').onchange = () => { try { stored.params = { ...stored.params, model: $('httpModel').value, voice: $('httpVoice').value, resourceId: $('httpResource').value }; profile = JSON.parse($('httpProfile').value); renderProfile(true); } catch { $('httpStatus').textContent = '接口配置不是有效 JSON'; } };
  $('httpApplyTemplate').onclick = async () => { profile = await pet.ttsHTTPTemplate($('httpTemplate').value); stored = {}; renderProfile(); $('httpStatus').textContent = '模板已载入草稿，填写后保存生效。'; };
  $('httpImport').onclick = () => $('httpFile').click();
  $('httpFile').onchange = async () => {
    try { const file = $('httpFile').files[0]; if (!file || file.size > 128 * 1024) throw new Error('配置文件不能超过128KiB');
      profile = JSON.parse(await file.text()); stored = {}; renderProfile(); $('httpStatus').textContent = '已导入草稿，请填写地址和凭据后保存。';
    } catch (e) { $('httpStatus').textContent = e.message; }
  };
  async function save(activate = true) {
    profile = JSON.parse($('httpProfile').value); profile.url = $('httpURL').value.trim();
    const secrets = Object.fromEntries([...$('httpSecrets').querySelectorAll('input')].filter(x => x.value || credentialCleared(x)).map(x => [x.dataset.secret, x.value]));
    const result = await pet.config({ tts: { ...(activate ? { engine: 'http' } : {}), http: { profile, secrets, params: {
      model: $('httpModel').value.trim(), voice: $('httpVoice').value.trim(), resourceId: $('httpResource').value.trim() } } } });
    stored = result.config?.tts?.http || result.tts?.http || {}; renderProfile();
    return result;
  }
  $('httpSave').onclick = async () => { try { await save(); $('httpStatus').textContent = '已保存并使用，可点击底部试听一句。'; } catch (e) { $('httpStatus').textContent = e.message; } };
  $('httpCatalog').onclick = async () => {
    try {
      await save(false); const results = await Promise.all(['models', 'voices'].map(kind => pet.ttsHTTPCatalog(kind)));
      for (const [i, id] of ['httpModels', 'httpVoices'].entries()) {
        $(id).replaceChildren(); for (const item of results[i].items || []) { const option = document.createElement('option'); option.value = item.id; option.label = item.label; $(id).append(option); }
      }
      $('httpStatus').textContent = results.some(r => !r.ok) ? results.find(r => !r.ok).error : results.every(r => r.manual) ? '此配置没有目录接口，请填写模型/音色 ID 后试听。' : '已获取目录，可选择模型和音色。';
    } catch (e) { $('httpStatus').textContent = e.message; }
  };
  $('httpExport').onclick = async () => {
    // Export the sanitized saved profile, never free-form unsaved credentials.
    const saved = (await pet.panelInit()).config.tts.http?.profile;
    if (!saved) { $('httpStatus').textContent = '请先保存有效配置'; return; }
    const objectURL = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = objectURL; a.download = 'bunny-tts-profile.json'; a.click(); setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  };
}
