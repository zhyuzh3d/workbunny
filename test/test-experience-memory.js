#!/usr/bin/env node
'use strict';

// Real SQLite/vault integration tests using only a disposable temp directory.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { createExperienceMemory, EXPERIENCE_MARKER, TOOL_MARKER } = require('../src/main/experience-memory');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const key = Buffer.from('b9fa2656e22fbd561349637295c0cf1eb9fa2656e22fbd561349637295c0cf1e', 'hex');
const rotatedKey = Buffer.from('c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a291807f6e5d4', 'hex');
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workbunny-experience-memory-'));
const services = [];
let now = Date.UTC(2026, 9, 27, 9);

function createService(name, scene = 'work', keyBytes = key) {
  const settings = { enabled: true, extract: false, scene };
  const memory = new MemoryService({ dir: path.join(temp, name), bin, getSettings: () => settings,
    openKey: async () => Buffer.from(keyBytes), clock: () => now++, random: () => 0 });
  services.push(memory);
  return { memory, settings };
}

function artifactFor(file, code, checkedAt = Date.now()) {
  const stat = fs.statSync(file);
  const bytes = Buffer.from(code, 'utf8');
  return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    mtimeMs: stat.mtimeMs, checkedAt };
}

async function addAcceptedTask(memory, { id, goal, scene = 'work', domain = 'work', visibilityFloor = 0,
  verification = {}, sourceText = '用户明确交代该项工作。', sourcesOverride } = {}) {
  const source = await memory.addMessage('user', sourceText, { scene, domain: scene, visibilityFloor });
  const taskId = id || `task-${crypto.randomUUID()}`;
  const value = { id: taskId, target: 'workbuddy', status: 'accepted', goal, criteria: '结果符合原要求', scene, domain, visibilityFloor,
    workModel: 'deepseek-v4.1-flash', acceptedAt: now++, automaticAccepted: true,
    verification: { verdict: 'pass', at: now++, report: '独立验收通过', ...verification },
    monitorSummary: '执行方提供了与目标对应的可检查结果。', monitorMessageKey: `message-${taskId}`,
    sources: sourcesOverride || [source.id], steps: [{ x: 0.1, y: 0.2, windowId: 55, screenshot: 'ignored' }] };
  const task = { id: taskId, kind: 'task', ts: now++, updatedAt: now, domain, visibilityFloor,
    value: { ...value, content: `${goal}\naccepted` } };
  await memory.write([task]);
  return { task, source };
}

function fixtureCollector({ transform } = {}) {
  return async (_task, { files }) => files.map((file, index) => {
    const data = transform ? transform(file, index) : file;
    if (data.code === undefined) return { ...data, code: null };
    return data;
  });
}

async function listStates(memory, scene = 'private') {
  return memory.query('state', 100, { scene });
}

async function testAcceptedTaskAndCurrentArtifact() {
  const { memory } = createService('accepted-current');
  await memory.init();
  const code = '// verified local tool fixture\nmodule.exports = value => value + 1;\n';
  const file = path.join(temp, 'fixture-tool.js');
  fs.writeFileSync(file, code, { mode: 0o600 });
  const manifest = { files: [artifactFor(file, code)] };
  const goal = `请检查文件 ${file} 并验证相关工具行为，交付一个可核对的结果。`;
  const { task } = await addAcceptedTask(memory, { goal, verification: { artifactManifest: manifest } });
  const experience = createExperienceMemory({ memory });
  const recorded = await experience.recordAcceptedTask(task.id);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.outcome, 'single-verified-run');
  assert.equal(recorded.toolIds.length, 1);
  const repeated = await experience.recordAcceptedTask(task.id);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.duplicate, true, 'task plus acceptance evidence is idempotent');

  const states = await listStates(memory);
  const experienceRow = states.find(row => row.id === recorded.experienceId);
  const toolRow = states.find(row => row.id === recorded.toolIds[0]);
  assert(experienceRow && toolRow);
  assert.equal(experienceRow.value.origin, 'task-experience-v1');
  assert.equal(experienceRow.value.outcome, 'single-verified-run');
  assert.equal(experienceRow.value.status, 'candidate');
  assert.equal(experienceRow.value.goal, goal);
  assert(!('steps' in experienceRow.value) && !JSON.stringify(experienceRow.value).includes('windowId'), 'volatile UI steps are not copied');
  assert.equal(toolRow.value.origin, 'verified-tool-v1');
  assert.equal(toolRow.value.code, code);
  assert.equal(toolRow.value.outcome, 'single-verified-run');
  const rawTool = (await memory.db.request('get', { ids: [toolRow.id] })).rows[0];
  assert(!String(rawTool.body).includes(code), 'code snapshot is encrypted at rest');
  assert(experienceRow.value.sources.includes(task.id) && toolRow.value.sources.includes(task.id));
  assert(experienceRow.value.content.includes(EXPERIENCE_MARKER) && toolRow.value.content.includes(TOOL_MARKER));

  let calls = 0;
  const noRead = createExperienceMemory({ memory, collectArtifacts: async () => { calls++; return []; } });
  const unknown = await noRead.findApplicable({ goal: '检查工具并完成类似任务', criteria: '保留边界', target: 'workbuddy', scene: 'work' });
  assert.equal(calls, 0, 'an old path is never read without a new explicit allowedPaths grant');
  assert(unknown.experiences.some(row => row.id === recorded.experienceId));
  assert.equal(unknown.tools[0].status, 'unknown');
  assert(!('code' in unknown.tools[0]));
  const unrelated = await noRead.findApplicable({ goal: '分析火星探测器轨道数据', criteria: '比较光谱样本与着陆器路径', target: 'workbuddy', scene: 'work' });
  assert.deepEqual(unrelated.experiences, [], 'platform and index markers cannot make a different-topic experience applicable');
  assert.deepEqual(unrelated.tools, [], 'tools require at least one meaningful topic or entity overlap');

  const reused = await experience.findApplicable({ goal: '检查工具并完成类似任务', criteria: '保留边界', target: 'workbuddy', scene: 'work', allowedPaths: [file] });
  assert.equal(reused.experiences.length, 1);
  assert.equal(reused.experiences[0].confidence, 'single-verified-run; not a general rule');
  assert.equal(reused.tools[0].status, 'current');
  assert.equal(reused.tools[0].snapshotAvailable, true);
  assert(!('code' in reused.tools[0]), 'bounded code is stored encrypted and is not injected into ordinary task context');
  assert(reused.sourceIds.includes(task.id));

  const passphrase = 'experience-fixture-backup-passphrase';
  const envelope = await memory.export(passphrase);
  const rotated = createService('accepted-restored-new-key', 'work', rotatedKey);
  await rotated.memory.init();
  await rotated.memory.restore(envelope, passphrase);
  const afterRestore = createExperienceMemory({ memory: rotated.memory });
  const restoredUnknown = await afterRestore.findApplicable({ goal: '检查工具并完成类似任务', target: 'workbuddy', scene: 'work' });
  assert.equal(restoredUnknown.tools[0].status, 'unknown', 'restored path metadata is not treated as a live filesystem check');
  assert(!('code' in restoredUnknown.tools[0]));
  const restoredMatches = await afterRestore.findApplicable({ goal: '检查工具并完成类似任务', criteria: '保留边界', target: 'workbuddy', scene: 'work', allowedPaths: [file] });
  assert(restoredMatches.experiences.some(row => row.id === recorded.experienceId), 'stable receipt survives a vault key rotation');
  assert.equal(restoredMatches.tools[0].status, 'current');
  assert.equal(restoredMatches.tools[0].snapshotAvailable, true, 'encrypted snapshot survives export and re-encryption');
  const restoredRecord = await afterRestore.recordAcceptedTask(task.id);
  assert.equal(restoredRecord.ok, true);
  assert.equal(restoredRecord.duplicate, true, 'sourceId+marker lookup prevents a new HMAC ID from duplicating restored experience');
  assert.equal(restoredRecord.experienceId, recorded.experienceId);
  assert.deepEqual(restoredRecord.toolIds, recorded.toolIds);
  const restoredStates = await listStates(rotated.memory);
  assert.equal(restoredStates.filter(row => row.value?.origin === 'task-experience-v1' && row.value.taskId === task.id).length, 1);
  assert.equal(restoredStates.find(row => row.id === recorded.toolIds[0]).value.artifact.sha256, manifest.files[0].sha256);

  fs.writeFileSync(file, code.replace('value + 1', 'value + 2'), { mode: 0o600 });
  const stale = await experience.findApplicable({ goal: '检查工具并完成类似任务', target: 'workbuddy', scene: 'work', allowedPaths: [file] });
  assert.equal(stale.tools[0].status, 'stale');
  assert.equal(stale.tools[0].snapshotAvailable, false, 'changed files do not expose the old snapshot as current code');
  fs.unlinkSync(file);
  const missing = await experience.findApplicable({ goal: '检查工具并完成类似任务', target: 'workbuddy', scene: 'work', allowedPaths: [file] });
  assert.equal(missing.tools[0].status, 'missing');
}

async function testEligibilityScopeAndSourceRevalidation() {
  const { memory } = createService('eligibility');
  await memory.init();
  const experience = createExperienceMemory({ memory });
  const pending = await addAcceptedTask(memory, { id: 'task-not-accepted', goal: '未验收', verification: { verdict: 'pass' } });
  await memory.write([{ ...pending.task, value: { ...pending.task.value, status: 'review' } }]);
  assert.equal((await experience.recordAcceptedTask(pending.task.id)).ok, false);

  const failed = await addAcceptedTask(memory, { id: 'task-failed-verification', goal: '验收失败', verification: { verdict: 'revise' } });
  assert.equal((await experience.recordAcceptedTask(failed.task.id)).ok, false);

  const privateTask = await addAcceptedTask(memory, { id: 'task-private-source', goal: '私聊来源的工作任务', scene: 'private', domain: 'work', visibilityFloor: 2,
    sourceText: '私密工作来源。' });
  const saved = await experience.recordAcceptedTask(privateTask.task.id);
  assert.equal(saved.ok, true);
  const hidden = await experience.findApplicable({ goal: '私聊来源', target: 'workbuddy', scene: 'work' });
  assert(!hidden.experiences.some(row => row.id === saved.experienceId), 'private-floor derived work experience is hidden in work scene');
  const visible = await experience.findApplicable({ goal: '私聊来源', target: 'workbuddy', scene: 'private' });
  assert(visible.experiences.some(row => row.id === saved.experienceId));

  const mutable = await addAcceptedTask(memory, { id: 'task-source-mutation', goal: '来源变更测试' });
  const created = await experience.recordAcceptedTask(mutable.task.id);
  assert.equal(created.ok, true);
  const changedSource = { ...mutable.source, value: { ...mutable.source.value, content: '源消息已修改。' } };
  await memory.write([changedSource]);
  const afterSourceChange = await experience.findApplicable({ goal: '来源变更测试', target: 'workbuddy', scene: 'work' });
  assert(!afterSourceChange.experiences.some(row => row.id === created.experienceId), 'changed source fingerprint invalidates reuse');

  const bodyTask = await addAcceptedTask(memory, { id: 'task-body-mutation', goal: '任务body变更测试' });
  const bodyRecord = await experience.recordAcceptedTask(bodyTask.task.id);
  await memory.write([{ ...bodyTask.task, value: { ...bodyTask.task.value, content: 'accepted task body was rewritten' }, updatedAt: now++ }]);
  const afterBodyChange = await experience.findApplicable({ goal: '任务body变更测试', target: 'workbuddy', scene: 'work' });
  assert(!afterBodyChange.experiences.some(row => row.id === bodyRecord.experienceId), 'task body fingerprint invalidates reuse');

  const statusTask = await addAcceptedTask(memory, { id: 'task-status-mutation', goal: '任务状态变更测试' });
  const statusRecord = await experience.recordAcceptedTask(statusTask.task.id);
  await memory.write([{ ...statusTask.task, value: { ...statusTask.task.value, status: 'paused' }, updatedAt: now++ }]);
  const afterStatusChange = await experience.findApplicable({ goal: '任务状态变更测试', target: 'workbuddy', scene: 'work' });
  assert(!afterStatusChange.experiences.some(row => row.id === statusRecord.experienceId), 'non-accepted task status invalidates reuse');
}

async function testSnapshotsRecheckedBeforeCommitAndSecretRejected() {
  const { memory } = createService('snapshot-recheck');
  await memory.init();
  const file = path.join(temp, 'race-tool.js');
  const code = 'module.exports = () => "ok";\n';
  fs.writeFileSync(file, code, { mode: 0o600 });
  const manifest = { files: [artifactFor(file, code)] };
  const { task, source } = await addAcceptedTask(memory, { id: 'task-race', goal: `请检查 ${file}`, verification: { artifactManifest: manifest } });
  let startedResolve, releaseResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  let calls = 0;
  const delayed = createExperienceMemory({ memory, collectArtifacts: async (_task, { files }) => {
    calls++;
    if (calls === 1) { startedResolve(); await release; }
    return files.map(item => ({ ...item, code }));
  } });
  const pending = delayed.recordAcceptedTask(task.id);
  await started;
  await memory.write([{ ...source, value: { ...source.value, content: '提交前来源已变化。' } }]);
  releaseResolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'source-changed-before-commit');
  assert.equal((await listStates(memory)).filter(row => row.value?.taskId === task.id).length, 0,
    'source mutation during collection leaves no partial experience or tool');

  const { task: mismatchTask } = await addAcceptedTask(memory, { id: 'task-artifact-mismatch', goal: '快照hash不一致', verification: { artifactManifest: manifest } });
  const mismatch = createExperienceMemory({ memory, collectArtifacts: fixtureCollector({ transform: item => ({ ...item, code: code + '// changed' }) }) });
  const mismatchResult = await mismatch.recordAcceptedTask(mismatchTask.id);
  assert.equal(mismatchResult.ok, true, 'experience may be retained without an invalid tool snapshot');
  assert.equal(mismatchResult.toolIds.length, 0, 'mismatched snapshot hash cannot register a tool');

  const { task: secretTask } = await addAcceptedTask(memory, { id: 'task-secret-code', goal: '秘密快照不得保存', verification: { artifactManifest: manifest } });
  const secretCode = 'const api_key = "abcdefghijklmnopqrstuvwx";\n';
  const secretManifest = { files: [artifactFor(file, secretCode)] };
  await memory.write([{ ...secretTask, value: { ...secretTask.value, verification: { ...secretTask.value.verification, artifactManifest: secretManifest } } }]);
  const secret = createExperienceMemory({ memory, collectArtifacts: fixtureCollector({ transform: item => ({ ...item, code: secretCode }) }) });
  const secretResult = await secret.recordAcceptedTask(secretTask.id);
  assert.equal(secretResult.ok, true);
  assert.equal(secretResult.toolIds.length, 0, 'secret-bearing source cannot create an encrypted code snapshot/tool');

  const largeCode = 'x'.repeat(34 * 1024);
  const largeFile = path.join(temp, 'large-tool.js');
  fs.writeFileSync(largeFile, largeCode, { mode: 0o600 });
  const largeManifest = { files: [artifactFor(largeFile, largeCode)] };
  const { task: largeTask } = await addAcceptedTask(memory, { id: 'task-large-snapshot', goal: '大文件只保存hash元数据', verification: { artifactManifest: largeManifest } });
  const large = createExperienceMemory({ memory, collectArtifacts: fixtureCollector({ transform: item => ({ ...item, code: largeCode }) }) });
  const largeResult = await large.recordAcceptedTask(largeTask.id);
  assert.equal(largeResult.toolIds.length, 1, 'large authorized artifact may retain verified hash metadata');
  const largeTool = (await listStates(memory)).find(row => row.id === largeResult.toolIds[0]);
  assert.equal(largeTool.value.artifact.sha256, largeManifest.files[0].sha256);
  assert.equal(largeTool.value.code, undefined, 'code snapshots larger than 32 KiB are not stored');
}

async function testStoredSourceDeletionAndLimit() {
  const { memory } = createService('source-deletion');
  await memory.init();
  const experience = createExperienceMemory({ memory });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const item = await addAcceptedTask(memory, { id: `task-limit-${i}`, goal: `重复场景任务 ${i}` });
    const created = await experience.recordAcceptedTask(item.task.id);
    ids.push({ task: item.task.id, experience: created.experienceId, source: item.source.id });
  }
  const limited = await experience.findApplicable({ goal: '重复场景任务', target: 'workbuddy', scene: 'work', limit: 99 });
  assert(limited.experiences.length <= 3, 'query limit clamps to three records');
  const target = ids[0];
  await memory.remove(target.source);
  const afterDelete = await experience.findApplicable({ goal: '重复场景任务', target: 'workbuddy', scene: 'work' });
  assert(!afterDelete.experiences.some(row => row.id === target.experience), 'deleted source prevents experience reuse');
}

async function main() {
  assert(fs.existsSync(bin), `prebuilt vault binary missing: ${bin}`);
  try {
    await testAcceptedTaskAndCurrentArtifact();
    await testEligibilityScopeAndSourceRevalidation();
    await testSnapshotsRecheckedBeforeCommitAndSecretRejected();
    await testStoredSourceDeletionAndLimit();
    console.log('experience memory SQLite integration: ok');
  } finally {
    await Promise.allSettled(services.map(service => service.close()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
