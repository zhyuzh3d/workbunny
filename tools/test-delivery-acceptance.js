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
const { collectDeliveryEvidence } = require('../src/main/delivery-evidence');

(async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bunny-file-acceptance-'));
  try {
    const source = path.join(root, 'source.js'), output = path.join(root, '交付.md');
    await fs.writeFile(source, 'function source() {}');
    const task = { userRequest: `只读 ${source}，然后新建 ${output}。只写这一个文件。`, goal: '生成四行说明', criteria: '文件真实存在且四行',
      monitorSessionId: 'same-session', monitorSummary: `我已写好 ${output}。` };
    assert.deepEqual((await collectDeliveryEvidence(task)).requiredOutputs, [output]);
    const absent = await verifyDelivery({ task });
    assert.equal(absent.verdict, 'revise'); assert.equal(calls, 0, 'a missing requested file cannot be accepted by a remote completion claim');
    await fs.writeFile(output, '# actual\nfirst\nsecond\nlast\n');
    assert.equal((await verifyDelivery({ task })).verdict, 'pass');
    assert.equal(calls, 1, 'a real stable file still reaches normal content verification');
    duringCheck = async () => fs.writeFile(output, 'changed while the model was checking');
    assert.equal((await verifyDelivery({ task })).verdict, 'need_user', 'an old file snapshot cannot accept a file changed during checking');
    duringCheck = async () => {};
    await fs.rm(output);
    const negative = { ...task, userRequest: `只读 ${source}，不要创建 ${output}。` };
    assert.deepEqual((await collectDeliveryEvidence(negative)).requiredOutputs, []);
    assert.equal((await verifyDelivery({ task: negative })).verdict, 'pass', 'a read-only absence check does not require creating a file');
    const target = path.join(root, 'target.md'); await fs.writeFile(target, 'outside the requested exact file');
    await fs.symlink(target, output);
    const previousCalls = calls;
    assert.equal((await verifyDelivery({ task })).verdict, 'need_user');
    assert.equal(calls, previousCalls, 'an unsafe target is neither read by the model nor retried as a missing file');
    console.log('Local delivery acceptance gate checks passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
