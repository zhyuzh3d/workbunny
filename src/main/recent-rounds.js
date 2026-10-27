'use strict';
const { containsSecret } = require('./conversation-input');

// Keep old turns intact. An omitted long turn remains retrievable from original
// records/segment summaries; it is never silently cut before a negation/date.
function recentRounds(rows, { rounds = 8, budget = 4000 } = {}) {
  const groups = []; let current = null;
  for (const row of rows) {
    if (row.value?.source === 'user-reviewed' || row.value?.delivery === 'task-receipt') continue;
    if (row.value?.role === 'user') { current = [row]; groups.push(current); }
    else if (row.value?.role === 'assistant' && current &&
      (!row.value.turnId || !current[0].value.turnId || row.value.turnId === current[0].value.turnId)) current.push(row);
  }
  const chosen = []; let used = 0;
  for (const group of groups.slice(-Math.max(1, Math.min(24, rounds))).reverse()) {
    if (group.some(row => containsSecret(row.value.content))) continue;
    const cost = group.reduce((n, row) => n + JSON.stringify({ role: row.value.role, content: row.value.content }).length, 0);
    if (used + cost > budget) break;
    chosen.unshift(...group); used += cost;
  }
  return { rows: chosen, used, omitted: rows.length - chosen.length };
}
function recentMessages(rows, { count = 20, budget = 12000 } = {}) {
  const actors = require('./message-identity'), groups = [];
  for (const row of rows.filter(r => actors.isDialogue(r.value))) {
    const previous = groups.at(-1);
    if (actors.isBunny(row.value) && previous && actors.isOwner(previous[0].value) &&
        (!row.value.turnId || !previous[0].value.turnId || row.value.turnId === previous[0].value.turnId)) previous.push(row);
    else groups.push([row]);
  }
  let used = 0, n = 0; const chosen = [];
  for (const group of groups.reverse()) {
    if (group.some(r => containsSecret(r.value.content))) continue;
    if (n && n + group.length > count) break;
    const cost = group.reduce((sum, r) => sum + JSON.stringify(actors.inputRow(r)).length + 2, 0);
    if (used + cost > budget) break;
    chosen.unshift(...group); used += cost; n += group.length;
    if (n >= count) break;
  }
  return { rows: chosen, used, omitted: rows.length - chosen.length };
}
module.exports = { recentRounds, recentMessages };
