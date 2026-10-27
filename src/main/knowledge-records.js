'use strict';

const ORIGINS = Object.freeze({ relation: 'semantic-relation-v1', doubt: 'memory-doubt-v1',
  experience: 'task-experience-v1', tool: 'verified-tool-v1', decision: 'doubt-resolution-v1' });
const TYPES = Object.freeze(Object.keys(ORIGINS));
const LABELS = Object.freeze({ relation: '相关陈述', doubt: '待核对', experience: '经验', tool: '工具', decision: '核对记录' });
function typeOf(record) {
  if (record?.kind !== 'state') return null;
  if (record.value?.origin === 'user-experience-v1') return 'experience';
  return TYPES.find(type => record.value?.origin === ORIGINS[type]) || null;
}
function marker(type) {
  if (type === 'all') return 'bunny_knowledge';
  if (!TYPES.includes(type)) throw new Error('未知的记忆资料类别');
  return 'bunny_knowledge_' + type;
}
function markersOf(record) {
  const type = typeOf(record);
  return type ? [marker('all'), marker(type)] : [];
}
module.exports = { ORIGINS, TYPES, LABELS, typeOf, marker, markersOf };
