'use strict';
const actors = require('./message-identity');
const error = () => Object.assign(new Error('语义水位必须指向输入中的完整连续前缀'), { code: 'E_SEMANTIC_BOUNDARY' });
function selectBoundary(result, rows, { force = false, allowedIds } = {}) {
  if (!rows.length) return { consumed: [], deferred: false };
  if (!Object.hasOwn(result, 'processedThrough')) return { consumed: rows, deferred: false }; // old adapters/fixtures
  if (result.processedThrough === null) {
    if (force) throw error();
    return { consumed: [], deferred: true };
  }
  if (allowedIds && !allowedIds.includes(result.processedThrough)) throw error();
  const index = rows.findIndex(r => r.id === result.processedThrough);
  if (index < 0) throw error();
  const last = rows[index], next = rows[index + 1];
  if (actors.isOwner(last.value) && next && actors.isBunny(next.value) &&
      (!last.value.turnId || !next.value.turnId || last.value.turnId === next.value.turnId)) throw error();
  return { consumed: rows.slice(0, index + 1), deferred: index < rows.length - 1 };
}
module.exports = { selectBoundary };
