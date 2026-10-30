'use strict';
const assert = require('node:assert/strict');
const { recentRounds } = require('../src/main/recent-rounds');
const rows = [];
for (let i = 0; i < 15; i++) {
  rows.push({ id: `u${i}`, value: { role: 'user', content: `第${i}次：截止日期之前不要发送。`, turnId: `t${i}` } });
  rows.push({ id: `a${i}`, value: { role: 'assistant', content: `记住第${i}次的限制。`, turnId: `t${i}` } });
}
const full = recentRounds(rows, { rounds: 8, budget: 10000 });
assert.equal(full.rows.length, 16); assert.equal(full.rows[0].id, 'u7');
assert.equal(full.rows.at(-1).id, 'a14');
const last = recentRounds(rows, { rounds: 1, budget: 10000 });
const tooSmall = recentRounds(rows, { rounds: 8, budget: last.used - 1 });
assert.deepEqual(tooSmall.rows, [], 'never silently cut an old turn before its restriction');
const two = recentRounds(rows, { rounds: 8, budget: last.used * 2 + 5 });
assert(two.rows.length >= 2 && two.rows.length <= 4);
assert.equal(two.rows[0].value.role, 'user'); assert.equal(two.rows.at(-1).value.role, 'assistant');
const receipt = { id: 'receipt', value: { role: 'assistant', content: '工作代办回执', delivery: 'task-receipt' } };
assert(!recentRounds([...rows, receipt], { budget: 10000 }).rows.some(row => row.id === receipt.id));
console.log('Complete recent-round budget checks passed');
