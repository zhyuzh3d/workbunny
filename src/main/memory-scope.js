'use strict';

// Business domain and visibility are deliberately separate. A work result may
// retain a private input's floor; changing its label never declassifies it.
const SCENES = Object.freeze(['work', 'life', 'private']);
const LABELS = Object.freeze({ work: '工作', life: '生活', private: '私聊' });
function normalizeScene(value, fallback = 'life') {
  return SCENES.includes(value) ? value : fallback;
}
function rank(scene) {
  const result = SCENES.indexOf(scene);
  if (result < 0) throw new Error('未知的对话场景');
  return result;
}
function scopeOf(record, fallback = 'private') {
  const domain = record?.domain ?? record?.value?.domain ?? fallback;
  const visibilityFloor = record?.visibilityFloor ?? record?.value?.visibilityFloor ?? rank(domain);
  if (!Number.isInteger(visibilityFloor) || visibilityFloor < rank(domain) || visibilityFloor > 2) throw new Error('无效的资料可见范围');
  return { domain, visibilityFloor };
}
function canRead(scene, record) { return scopeOf(record).visibilityFloor <= rank(scene); }
function withSources(domain, sources = [], explicitFloor) {
  const minimum = Math.max(rank(domain), ...sources.map(r => scopeOf(r).visibilityFloor));
  if (explicitFloor !== undefined && (!Number.isInteger(explicitFloor) || explicitFloor < minimum || explicitFloor > 2)) {
    throw new Error('派生资料不能降低来源的可见范围');
  }
  return { domain, visibilityFloor: explicitFloor ?? minimum };
}
module.exports = { SCENES, LABELS, normalizeScene, rank, scopeOf, canRead, withSources };
