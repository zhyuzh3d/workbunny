'use strict';

const { createHash } = require('node:crypto');
const identityFields = ['key', 'label', 'name', 'kind', 'version', 'digest', 'url', 'personal'];
const avatarKey = value => typeof value === 'string' ? value : value?.key;
const nameOf = avatar => String(avatar?.label || avatar?.name || avatar?.key || '');
function error(message, code) { return Object.assign(Error(message), { code }); }
function catalogIdentity(list) {
  if (!Array.isArray(list) || list.some(item => !item || typeof item.key !== 'string' || !item.key) || new Set(list.map(item => item.key)).size !== list.length) {
    throw error('形象目录不可用', 'E_AVATAR_CATALOG');
  }
  return createHash('sha256').update(JSON.stringify(list.map(item => identityFields.map(field =>
    field === 'kind' ? item.kind || 'vrm' : field === 'personal' ? !!item.personal : item[field] ?? null)))).digest('hex');
}

function buildAvatarSnapshot(list) {
  const fingerprint = catalogIdentity(list), keys = list.map(item => item.key);
  const choices = Object.freeze(list.map((item, index) => Object.freeze({ number: index + 1, name: nameOf(item), kind: item.kind || 'vrm', custom: !!item.personal })));
  return Object.freeze({ choices, fingerprint,
    resolve(number, currentList) {
      if (!Number.isInteger(number) || number < 1 || number > keys.length) throw error('形象编号不在本次目录范围内', 'E_AVATAR_NUMBER');
      let currentFingerprint;
      try { currentFingerprint = catalogIdentity(currentList); } catch {}
      if (fingerprint !== currentFingerprint) throw error('形象目录已变化，请使用当前目录重新选择', 'E_AVATAR_CATALOG_STALE');
      return keys[number - 1];
    }
  });
}

// getBody is Embodiment.snapshot(): avatar is the configured identity, while
// non-null capabilities come only from that avatar's actual body-ready event.
// current().avatarRevision must advance on every avatar setting change, including
// UI changes, so an interrupted request cannot overwrite a later user choice.
function createAvatarCapability({ list, current, getBody, applySettings, timeoutMs = 20000, pollMs = 50 }) {
  if (![list, current, getBody, applySettings].every(fn => typeof fn === 'function') ||
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw TypeError('invalid avatar capability');
  let generation = 0;
  const ready = key => {
    const body = getBody();
    return avatarKey(current()) === key && avatarKey(body?.avatar) === key && body.capabilities !== null && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities);
  };
  const validOwner = isCurrent => { try { return typeof isCurrent !== 'function' || isCurrent(); } catch { return false; } };
  function wait(ms, signal) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
  return { async select(key, { signal, isCurrent } = {}) {
    if (signal?.aborted || !validOwner(isCurrent)) return { ok: false, status: 'cancelled', error: '形象切换已取消', rolledBack: false };
    const target = list().find(item => item.key === key);
    if (!target) return { ok: false, status: 'failed', error: '形象不存在或已删除', rolledBack: false };
    const request = ++generation, previous = current(), previousKey = avatarKey(previous), changed = previousKey !== key;
    const receipt = { key, name: nameOf(target), label: nameOf(target), kind: target.kind || 'vrm', changed };
    if (ready(key)) return { ...receipt, ok: true, status: 'ready', ready: true };
    const deadline = Date.now() + timeoutMs;
    let applyFailure = null;
    if (changed) {
      try { Promise.resolve(applySettings({ avatar: key })).catch(cause => { applyFailure = cause; }); }
      catch (cause) { applyFailure = cause; }
    }
    const owned = current(), ownedRevision = owned?.avatarRevision;
    // Existing applySettings applies the avatar patch synchronously. Observe its
    // async rejection without waiting on unrelated later work in that promise.
    if (changed) await Promise.resolve();
    const ownsSelection = () => {
      const now = current();
      return request === generation && avatarKey(now) === key && now?.avatarRevision === ownedRevision;
    };
    function rollback() {
      if (!changed || !previousKey || !ownsSelection() || ready(key)) return false;
      try {
        Promise.resolve(applySettings({ avatar: previousKey })).catch(() => {});
        return avatarKey(current()) === previousKey;
      } catch { return false; }
    }
    while (true) {
      // Completion wins a cancellation race: a body already visibly ready is
      // retained. New dialogue output still belongs to its caller's own signal.
      if (request === generation && ownsSelection() && ready(key)) return { ...receipt, ok: true, status: 'ready', ready: true };
      if (applyFailure) return { ...receipt, ok: false, status: 'failed', error: applyFailure.message || '形象设置未能保存', rolledBack: rollback() };
      if (!ownsSelection()) return { ...receipt, ok: false, status: 'superseded', error: '形象选择已被后续操作替代', rolledBack: false };
      if (signal?.aborted || !validOwner(isCurrent)) return { ...receipt, ok: false, status: 'cancelled', error: '形象切换已取消', rolledBack: rollback() };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...receipt, ok: false, status: 'timeout', error: '尚未收到形象加载完成回执', rolledBack: rollback() };
      await wait(Math.min(pollMs, remaining), signal);
    }
  } };
}

module.exports = { buildAvatarSnapshot, createAvatarCapability };
