'use strict';

const { createHash } = require('node:crypto');
const { performancePlayback } = require('./performance-playback-policy');

const MOTION_FIELDS = ['key', 'localId', 'slot', 'label', 'use', 'enabled', 'deleted', 'url', 'file', 'duration',
  'loop', 'idle', 'posture', 'postureChanging', 'transition', 'requiresProp', 'autonomous', 'bakedPreview', 'sourceId', 'thumbAdaptation'];
const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function view(catalog) {
  const result = typeof catalog?.catalog === 'function' ? catalog.catalog() : catalog;
  if (!result || !Array.isArray(result.motions)) throw TypeError('动作目录不可用');
  return result;
}
function avatarIdentity(avatar) {
  if (typeof avatar === 'string') avatar = { key: avatar };
  return Object.fromEntries(['key', 'kind', 'url', 'file', 'version'].map(key =>
    [key, key === 'kind' ? avatar?.kind || 'vrm' : avatar?.[key] ?? null]));
}
function fingerprint(catalog, avatar) {
  return createHash('sha256').update(JSON.stringify({ avatar: avatarIdentity(avatar), motions: view(catalog).motions.map(motion =>
    [MOTION_FIELDS.map(field => motion[field] ?? null), performancePlayback(motion)]) })).digest('hex');
}

// Numbering belongs to this snapshot. Never reinterpret a model's number using
// a fresh catalog, even when its display names happen to be identical.
function buildPerformanceSnapshot(catalog, { avatar = null, posture = 'standing' } = {}) {
  const source = view(catalog), currentFingerprint = fingerprint(source, avatar);
  const motions = source.motions.filter(motion => motion.enabled !== false && !motion.deleted)
    .map(motion => freeze(JSON.parse(JSON.stringify(motion))));
  const counts = new Map();
  for (const motion of motions) counts.set(cleanText(motion.label), (counts.get(cleanText(motion.label)) || 0) + 1);
  const map = Object.create(null);
  const entries = motions.map((motion, index) => {
    const number = index + 1; map[number] = motion;
    return freeze({ number, key: motion.key, motion });
  });
  const lines = entries.map(({ number, motion }) => {
    const name = cleanText(motion.label) || '未命名动作', markers = [];
    if (counts.get(cleanText(motion.label)) > 1 && cleanText(motion.use) && cleanText(motion.use) !== name) markers.push(cleanText(motion.use).slice(0, 60));
    if (motion.posture === 'sitting') markers.push('坐姿');
    if (motion.transition) markers.push(motion.transition === 'sit' ? '坐下转场' : motion.transition === 'stand' ? '站起转场' : '姿态转场');
    else if (motion.postureChanging) markers.push('含姿态变化');
    if (motion.requiresProp) markers.push('需外部道具（当前不可用）');
    if (performancePlayback(motion).mode === 'cycle') markers.push('短周期重复展示');
    return `${number} ${name}${markers.length ? ' ' + markers.join('；') : ''}`;
  });
  const avatarName = cleanText(avatar?.name || avatar?.label) || '当前形象';
  const promptText = `形象：${avatarName}；当前姿态：${posture === 'sitting' ? '坐姿' : '站姿'}；外部道具：未提供。\n` + lines.join('\n');
  return Object.freeze({ avatar: freeze(JSON.parse(JSON.stringify(avatar))), posture, fingerprint: currentFingerprint,
    motions: Object.freeze(motions), entries: Object.freeze(entries), map: Object.freeze(map), promptText,
    resolve(number) {
      if (!Number.isInteger(number) || number < 0 || number > motions.length) throw RangeError('表演动作编号不在本次目录范围内');
      return number === 0 ? null : map[number];
    },
    isCurrent(currentCatalog, currentAvatar) {
      try { return currentFingerprint === fingerprint(currentCatalog, currentAvatar); } catch { return false; }
    } });
}

module.exports = { buildPerformanceSnapshot };
