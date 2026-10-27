'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
// Stub only the remote verdict. The actual filesystem evidence collector and
// production acceptance gate remain wired together, with no account requests.
const transport = require('../src/main/verification-transport');
let calls = 0, duringCheck = async () => {};
transport.requestVerification = async () => {
  calls++; await duringCheck();
  return { model: 'deepseek-v4.1-flash', response: { text: '{"verdict":"pass","report":"执行方说已完成。","followUp":""}' } };
};
const { verifyDelivery } = require('../src/main/secretary');
const { Secretary } = require('../src/main/secretary');
const { collectDeliveryEvidence } = require('../src/main/delivery-evidence');

(async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bunny-file-acceptance-'));
  try {
    const source = path.join(root, 'source.js'), output = path.join(root, '交付.md'), outside = path.join(root, 'executor-only.md');
    await fs.writeFile(source, 'function source() {}');
    await fs.writeFile(outside, 'not authorized by the user request');
    const task = { userRequest: `只读 ${source}，然后新建 ${output}。只写这一个文件。`, goal: '生成四行说明', criteria: '文件真实存在且四行',
      monitorSessionId: 'same-session', monitorSummary: `我已写好 ${output}，还检查了 ${outside}。` };
    assert.deepEqual((await collectDeliveryEvidence(task)).requiredOutputs, [output]);
    const absent = await verifyDelivery({ task });
    assert.equal(absent.verdict, 'revise'); assert.equal(calls, 0, 'a missing requested file cannot be accepted by a remote completion claim');
    await fs.writeFile(output, '# actual\nfirst\nsecond\nlast\n');
    const accepted = await verifyDelivery({ task });
    assert.equal(accepted.verdict, 'pass');
    assert.deepEqual(accepted.artifactManifest.files.map(file => file.path).sort(), [output, source].sort(),
      'only files authorized by the original request enter the manifest; executor-only paths cannot add authority');
    for (const file of accepted.artifactManifest.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/u);
      assert.ok(Number.isSafeInteger(file.size));
      assert.ok(Number.isFinite(file.mtimeMs));
      assert.ok(Number.isFinite(file.checkedAt));
      assert.deepEqual(Object.keys(file).sort(), ['checkedAt', 'mtimeMs', 'path', 'sha256', 'size']);
    }
    assert.equal(calls, 1, 'a real stable file still reaches normal content verification');
    const persistedTask = { ...task, id: 'manifest-persist-test', origin: 'dialogue', status: 'review', scene: 'life', domain: 'work', visibilityFloor: 1,
      privacyEpoch: 0, followUpRound: 0, observationHistory: [], evidence: '' };
    const desktop = { task: persistedTask, generation: 1,
      update(patch) { Object.assign(this.task, patch); },
      async journal() {},
      async accept() { this.task.status = 'accepted'; this.task.automaticAccepted = true; return { ok: true }; } };
    const secretary = new Secretary({ desktop, report: async () => {}, ready: () => true, epoch: () => 0, getScene: () => 'life' });
    secretary.taskEpochs.set(persistedTask.id, 0);
    await secretary._review(persistedTask.id);
    assert.equal(persistedTask.verification.verdict, 'pass');
    assert.deepEqual(persistedTask.verification.artifactManifest.files.map(({ checkedAt, ...file }) => file),
      accepted.artifactManifest.files.map(({ checkedAt, ...file }) => file),
      'only the production verifyDelivery result persists its rechecked manifest into task.verification');
    assert.ok(persistedTask.verification.artifactManifest.files.every(file => Number.isFinite(file.checkedAt)));
    secretary.close();
    duringCheck = async () => fs.writeFile(output, 'changed while the model was checking');
    assert.equal((await verifyDelivery({ task })).verdict, 'need_user', 'an old file snapshot cannot accept a file changed during checking');
    duringCheck = async () => {};
    await fs.rm(output);
    const negative = { ...task, userRequest: `只读 ${source}，不要创建 ${output}。` };
    assert.deepEqual((await collectDeliveryEvidence(negative)).requiredOutputs, []);
    const readOnly = await verifyDelivery({ task: negative });
    assert.equal(readOnly.verdict, 'pass', 'a read-only absence check does not require creating a file');
    assert.deepEqual(readOnly.artifactManifest.files.map(file => file.path), [source], 'stable explicitly read files can be manifested');
    const target = path.join(root, 'target.md'); await fs.writeFile(target, 'outside the requested exact file');
    await fs.symlink(target, output);
    const previousCalls = calls;
    assert.equal((await verifyDelivery({ task })).verdict, 'need_user');
    assert.equal(calls, previousCalls, 'an unsafe target is neither read by the model nor retried as a missing file');
    console.log('Local delivery acceptance gate checks passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
