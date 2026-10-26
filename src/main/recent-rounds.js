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
module.exports = { recentRounds };
