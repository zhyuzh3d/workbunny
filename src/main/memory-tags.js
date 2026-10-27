'use strict';
const { containsSecret } = require('./conversation-input');
const ACTIVE = '主动记忆', AUTO = '自动记忆';
function topics(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).filter(t => typeof t === 'string')
    .map(t => t.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ').slice(0, 48))
    .filter(t => t && t !== ACTIVE && t !== AUTO && !containsSecret(t) && !/[\u0000-\u001f]/u.test(t)))].slice(0, 8);
}
function provenance(value = {}) {
  const flags = new Set(Array.isArray(value.provenance) ? value.provenance.filter(t => ['active', 'automatic'].includes(t)) : []);
  if (Array.isArray(value.provenance)) return ['active', 'automatic'].filter(t => flags.has(t));
  if (/^(?:task-experience|verified-tool|doze-candidate|dream-candidate|model-candidate)/u.test(value.origin || '')) flags.add('automatic');
  if (/^user-reviewed/u.test(value.origin || '') || value.origin === 'user-experience-v1') flags.add('active');
  // Old explicit memories used importance=1; ordinary rule observations used .7.
  if (value.origin === 'user-statement') flags.add(Number(value.importance) >= .95 ? 'active' : 'automatic');
  return ['active', 'automatic'].filter(t => flags.has(t));
}
function tagged(value, flags = []) {
  const inherited = Array.isArray(value.provenance) || !flags.length ? provenance(value) : [];
  const all = new Set([...inherited, ...flags]);
  const source = ['active', 'automatic'].filter(t => all.has(t));
  return { ...value, provenance: source, tags: [...source.map(t => t === 'active' ? ACTIVE : AUTO), ...topics(value.tags)] };
}
module.exports = { ACTIVE, AUTO, topics, provenance, tagged };
