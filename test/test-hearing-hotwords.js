'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/main/config');
const hearing = require('../src/main/hearing-hotwords');

function fixture(t, disk) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-hotwords-'));
  const file = path.join(directory, 'config.json');
  if (disk !== undefined) fs.writeFileSync(file, JSON.stringify(disk));
  config.setPath(file);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { file, directory };
}
function patch(ops, revision = hearing.snapshot(config.load()).revision) {
  return { expectedRevision: revision, ops };
}
const list = count => Array.from({ length: count }, (_, index) => 'term-' + index);

test('normalization accepts exact short phrases, preserves first spelling and rejects invalid words', () => {
  const words = ['  ＷｏｒｋＢｕｎｎｙ ', 'workbunny', ' 工程 术语 ', '工程 术语', 'Workbuddy'];
  assert.deepEqual(hearing.normalizeWords(words), ['WorkBunny', '工程 术语', 'Workbuddy']);
  assert.equal(words[0], '  ＷｏｒｋＢｕｎｎｙ ');
  assert.deepEqual(hearing.normalizeWords(['🙂'.repeat(64)]), ['🙂'.repeat(64)]);
  for (const value of [null, undefined, {}, 'term']) assert.throws(() => hearing.normalizeWords(value), /数组/);
  for (const value of [null, 1, '', '  ', 'x'.repeat(65), 'a\nb', '\tterm', 'term\u007f', 'password: fixture-only-secret']) {
    assert.throws(() => hearing.normalizeWords([value]));
  }
  assert.deepEqual(hearing.normalizeWords(['A', 'a'], { max: 1 }), ['A']);
  assert.throws(() => hearing.normalizeWords(['A', 'B'], { label: 'fixture', max: 1 }), /fixture最多1项/);
});

test('new and old configs get default extras while an explicitly empty list stays empty across save and reload', t => {
  const { file } = fixture(t);
  assert.deepEqual(config.load().asr.hotwords, ['WorkBunny', 'Workbuddy']);
  fs.writeFileSync(file, JSON.stringify({ buddy: { name: '芭尼' }, asr: { wakeAliases: [' 妮妮 ', '妮妮'] } }));
  config.setPath(file);
  assert.deepEqual(config.load().asr.hotwords, ['WorkBunny', 'Workbuddy']);
  assert.deepEqual(config.load().asr.wakeAliases, ['妮妮']);
  config.save({ asr: { hotwords: [] } });
  config.setPath(file);
  assert.deepEqual(config.load().asr.hotwords, []);
  assert.deepEqual(hearing.DEFAULT_HOTWORDS, ['WorkBunny', 'Workbuddy']);
});

test('legacy malformed or excessive terms are repaired without preventing startup or logging their contents', t => {
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { file } = fixture(t, { buddy: { name: 'bad\nname' }, asr: { wakeAliases: [' alias ', null, 'ALIAS'], hotwords: null } });
    assert.equal(config.load().buddy.name, config.DEFAULTS.buddy.name);
    assert.deepEqual(config.load().asr.wakeAliases, ['alias']);
    assert.deepEqual(config.load().asr.hotwords, [...hearing.DEFAULT_HOTWORDS]);
    fs.writeFileSync(file, JSON.stringify({ buddy: { name: '芭尼' }, asr: { wakeAliases: [], hotwords: [...list(520), 'password: fixture-only-secret'] } }));
    config.setPath(file);
    assert.deepEqual(config.load().asr.hotwords, list(511));
    assert.equal(hearing.effective(config.load()).length, 512);
    assert.ok(warnings.length >= 2);
    assert.ok(warnings.every(message => !message.includes('fixture-only-secret') && !message.includes('term-')));
  } finally { console.warn = warn; }
});

test('effective words include exact name, aliases and extras with shared deduplication and a stable complete revision', () => {
  const c = { buddy: { name: ' Bunny ' }, asr: { wakeAliases: ['BUNNY', '兔兔'], hotwords: ['兔兔', 'WorkBunny', 'workbunny'] } };
  const view = hearing.snapshot(c);
  assert.match(view.revision, /^[a-f0-9]{16}$/u);
  assert.equal(view.name, 'Bunny');
  assert.deepEqual(view.aliases, ['BUNNY', '兔兔']);
  assert.deepEqual(view.hotwords, ['兔兔', 'WorkBunny']);
  assert.deepEqual(view.effective, ['Bunny', '兔兔', 'WorkBunny']);
  assert.equal(view.limit, 512);
  assert.equal(hearing.snapshot({ ...c, settingsRevision: 42 }).revision, view.revision);
  for (const changed of [
    { ...c, buddy: { name: 'New Bunny' } },
    { ...c, asr: { ...c.asr, wakeAliases: ['新叫法'] } },
    { ...c, asr: { ...c.asr, hotwords: [] } },
  ]) assert.notEqual(hearing.snapshot(changed).revision, view.revision);
  assert.throws(() => hearing.effective({ buddy: { name: 'Bunny' }, asr: { hotwords: list(512) } }), /合计最多512项/);
  assert.throws(() => hearing.snapshot({ buddy: { name: 'Bunny' }, asr: { wakeAliases: null } }), /数组/);
});

test('update requests have a strict bounded schema and normalize each operation', () => {
  assert.deepEqual(hearing.validateUpdate({ expectedRevision: 'revision', ops: [{ op: 'replace', word: ' Ａ ', replacement: ' B ' }] }),
    { expectedRevision: 'revision', ops: [{ op: 'replace', word: 'A', replacement: 'B' }] });
  const valid = { expectedRevision: 'revision', ops: [{ op: 'add', word: 'term' }] };
  assert.equal(hearing.validateUpdate({ expectedRevision: 'revision', ops: list(512).map(word => ({ op: 'add', word })) }).ops.length, 512);
  for (const value of [null, [], {}, { ...valid, extra: true }, { ...valid, expectedRevision: '' }, { ...valid, expectedRevision: ' '.repeat(2) },
    { ...valid, expectedRevision: 'x'.repeat(129) }, { ...valid, ops: [] }, { ...valid, ops: Array(513).fill(valid.ops[0]) },
    { ...valid, ops: Array(1) }, { ...valid, ops: [{ op: 'clear', word: 'term' }] }, { ...valid, ops: [{ op: 'add', word: 'term', replacement: 'other' }] },
    { ...valid, ops: [{ op: 'replace', word: 'term' }] }, { ...valid, ops: [{ op: 'remove', word: 'term', aliases: [] }] }]) {
    assert.throws(() => hearing.validateUpdate(value));
  }
});

test('atomic add, replace and remove only save extras and keep name and aliases intact', t => {
  fixture(t, { buddy: { name: '芭尼' }, asr: { wakeAliases: ['妮妮'], hotwords: [] } });
  const saved = [], module = { load: () => config.load(), save: value => { saved.push(value); return config.save(value); } };
  let result = hearing.update(module, patch([{ op: 'add', word: ' ＷｏｒｋＢｕｎｎｙ ' }, { op: 'add', word: 'workbunny' }, { op: 'add', word: '旧术语' }]));
  assert.deepEqual(result.snapshot.hotwords, ['WorkBunny', '旧术语']);
  assert.equal(result.changed, true); assert.equal(result.saved, true);
  result = hearing.update(module, patch([{ op: 'replace', word: '旧术语', replacement: '新术语' }, { op: 'remove', word: 'WORKBUNNY' }]));
  assert.deepEqual(result.snapshot.hotwords, ['新术语']);
  assert.deepEqual(saved, [{ asr: { hotwords: ['WorkBunny', '旧术语'] } }, { asr: { hotwords: ['新术语'] } }]);
  assert.equal(config.load().buddy.name, '芭尼');
  assert.deepEqual(config.load().asr.wakeAliases, ['妮妮']);
  const revision = result.snapshot.revision;
  result = hearing.update(module, patch([{ op: 'add', word: '新术语' }, { op: 'replace', word: '新术语', replacement: '新术语' }, { op: 'remove', word: '芭尼' }, { op: 'remove', word: '妮妮' }], revision));
  assert.deepEqual(result, { snapshot: hearing.snapshot(config.load()), changed: false, saved: true });
  assert.equal(result.snapshot.revision, revision); assert.equal(saved.length, 2);
  assert.throws(() => hearing.update(module, patch([{ op: 'add', word: 'will-not-save' }, { op: 'replace', word: '妮妮', replacement: 'other' }])), /不存在/);
  assert.equal(saved.length, 2); assert.deepEqual(config.load().asr.hotwords, ['新术语']);
});

test('a revision conflict includes user edits to words, name or aliases and never overwrites their new state', t => {
  const { file } = fixture(t);
  for (const change of [{ asr: { hotwords: ['user-term'] } }, { buddy: { name: '新名字' } }, { asr: { wakeAliases: ['新叫法'] } }]) {
    const revision = hearing.snapshot(config.load()).revision;
    config.save(change);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => hearing.update(config, patch([{ op: 'add', word: 'stale-term' }], revision)), /已更新/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const revision = hearing.snapshot(config.load()).revision;
  config.save({ voice: { volume: 72 } });
  assert.equal(hearing.update(config, patch([{ op: 'add', word: 'current-term' }], revision)).saved, true);
});

test('failed file replacement leaves persistent and live words unchanged and cannot report saved success', t => {
  const { file, directory } = fixture(t);
  config.save({ asr: { hotwords: ['retained-term'] } });
  const before = fs.readFileSync(file, 'utf8'), view = hearing.snapshot(config.load()), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture rename failure'); };
  try {
    assert.throws(() => hearing.update(config, patch([{ op: 'replace', word: 'retained-term', replacement: 'not-saved' }], view.revision)), /保存失败/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(hearing.snapshot(config.load()), view);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('new saves reject malformed arrays and total overflow without truncating or changing cache', t => {
  const { file } = fixture(t);
  config.save({ buddy: { name: 'Bunny' }, asr: { hotwords: list(511) } });
  const before = fs.readFileSync(file, 'utf8'), view = hearing.snapshot(config.load());
  for (const value of [null, undefined, 'term', ['bad\nterm'], ['x'.repeat(65)], ['password: fixture-only-secret'], list(512)]) {
    assert.throws(() => config.save({ asr: { hotwords: value } }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(hearing.snapshot(config.load()), view);
  }
  assert.throws(() => config.save({ asr: { wakeAliases: ['alias'] } }), /合计最多512项/);
  assert.throws(() => hearing.update(config, patch([{ op: 'add', word: 'overflow-term' }])), /合计最多512项/);
  const result = hearing.update(config, patch([{ op: 'add', word: 'next-term' }, { op: 'remove', word: 'term-0' }]));
  assert.equal(result.snapshot.effective.length, 512);
  assert.equal(result.snapshot.hotwords.at(-1), 'next-term');
  config.save({ asr: { hotwords: ['Bunny', ...list(511)] } });
  assert.throws(() => config.save({ buddy: { name: 'Another Bunny' } }), /合计最多512项/);
  assert.equal(config.load().buddy.name, 'Bunny');
});


test('the full library remains available while system context keeps names first within the documented 100 phrase cap', () => {
  const c = { buddy: { name: 'Bunny' }, asr: { wakeAliases: ['兔兔', 'BUNNY'], hotwords: ['兔兔', ...list(510)] } };
  const view = hearing.snapshot(c);
  assert.equal(view.effective.length, 512);
  assert.equal(view.systemLimit, 100);
  assert.equal(hearing.SYSTEM_LIMIT, 100);
  assert.deepEqual(hearing.systemWords(c), ['Bunny', '兔兔', ...list(98)]);
  assert.deepEqual(view.hotwords, c.asr.hotwords);
  assert.equal(hearing.systemWords({ buddy: { name: 'Bunny' }, asr: { hotwords: [] } }).length, 1);
});

test('owner correction learning stays within existing reasoning and keeps a selective revision checked library', () => {
  for (const instruction of ['自主维护', '主人明确纠正', '人名、地名', '专业术语', '主动添加或替换', '不另发纠错模型请求', '普通、常见',
    '主动删除重复、过时和低价值词', 'expectedRevision', 'add/replace/remove', '最多512项', '最多100项', '不静默淘汰']) assert.ok(hearing.RULE.includes(instruction), instruction);
});
