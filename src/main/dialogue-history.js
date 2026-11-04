'use strict';

const actors = require('./message-identity');
const PAGE_SIZE = 40;
const cursorOf = row => row ? { ts: row.ts, id: row.id } : null;
function cursor(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value.ts) || value.ts < 0 || typeof value.id !== 'string' || !value.id || value.id.length > 256)
    throw new Error('对话分页位置无效');
  return value;
}
// Keyset pagination uses the vault's (ts,id) order. It has no date cutoff and
// never reads the whole conversation, even while the owner browses old messages.
async function dialoguePage(memory, options = {}, scene) {
  const before = cursor(options.before), after = cursor(options.after);
  if (before && after) throw new Error('对话分页方向无效');
  const limit = options.probe === true ? 1 : PAGE_SIZE;
  const rows = await memory.query('message', limit, {
    scene, channelId:'local', excludedMarkers: ['bunny_external_message'],
    ...(before ? { before: before.ts, beforeId: before.id } : {}),
    ...(after ? { after: after.ts, afterId: after.id, order: 'asc' } : {}),
  });
  if (!after) rows.reverse();
  return {
    scene, rows: rows.filter(r => actors.isOwner(r.value) || actors.isBunny(r.value)).map(r => ({
      id: r.id, ts: r.ts, role: actors.isOwner(r.value) ? 'user' : 'assistant', text: String(r.value.content || ''),
    })), oldest: cursorOf(rows[0]), newest: cursorOf(rows.at(-1)), more: rows.length === limit,
  };
}
module.exports = { dialoguePage, PAGE_SIZE };
