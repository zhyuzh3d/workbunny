'use strict';
// Re-evaluate an existing bound task only. No GUI, new delegation, or file writes
// to the artifact. All test state is appended to a private temporary journal.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { DesktopService } = require('../src/main/desktop-service');
const { Secretary } = require('../src/main/secretary');
const { collectDeliveryEvidence } = require('../src/main/delivery-evidence');
const id = '4378e169-986b-447a-a980-aea4afe8ea1b';
const artifact = '/private/tmp/bunny-workbuddy-artifact-Ef0lHl/checklist.html';
const expectedHash = 'ef6bbd543ee1c6ddd2093b63d06b90437690c3745f5740d429608f43410ab962';
function readLast(file) { return JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)); }
function hash() { return crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'); }
async function verifyOnce(task, journalPath) {
  const reports = [];
  const desktop = new DesktopService({ native: { close: async () => {} },
    persist: async current => fs.appendFileSync(journalPath, JSON.stringify(current) + '\n', { mode: 0o600 }) });
  desktop.task = task;
  task.verificationHistory = [...(task.verificationHistory || []), task.verification].filter(Boolean);
  task.status = 'review'; task.note = '仅重新核验已有文件及绑定任务';
  await desktop.journal();
  const secretary = new Secretary({ desktop, ready: () => true, epoch: () => 0, getScene: () => 'life', maxFollowUps: 0,
    report: async event => reports.push(event) });
  secretary.taskEpochs.set(id, 0);
  secretary.onStatus(desktop.publicStatus());
  await secretary.verifying;
  assert.equal(task.status, 'accepted', `秘书未通过：${task.note}`);
  assert.equal(task.verification?.verdict, 'pass');
  assert.equal(task.verification?.artifactManifest?.files?.find(x => x.path === artifact)?.sha256, expectedHash);
  // Repeated delivery of the same stage must remain idempotent.
  secretary.onStatus(desktop.publicStatus());
  await secretary._announce(id, '重复完成事件');
  secretary.close(); await desktop.close();
  return reports;
}
(async () => {
  const index = process.argv.indexOf('--reverify');
  if (index < 0 || !process.argv[index + 1]) throw new Error('用法：node test/test-workbuddy-artifact-reverify.cjs --reverify /绝对路径/task.jsonl');
  const source = process.argv[index + 1], original = readLast(source);
  assert.equal(original.id, id); assert(original.monitorMessageKey && original.monitorSessionId);
  assert.equal(original.status, 'accepted'); assert.equal(original.verification?.verdict, 'pass');
  assert.equal(hash(), expectedHash, '原交付文件已变化');
  const evidence = await collectDeliveryEvidence(original);
  const file = evidence.files.find(x => x.path === artifact);
  assert.equal(file?.sha256, expectedHash); assert(file.excerpt?.includes('铅笔') && file.excerpt?.includes('整理检查事项'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-artifact-reverify-'));
  const journal = path.join(dir, 'task.jsonl'); fs.writeFileSync(journal, '', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ journal, artifact, beforeHash: expectedHash }));
  const first = await verifyOnce(original, journal);
  assert.equal(first.length, 1, '原暂停报告不能压制后续完成报告');
  const eventId = first[0].eventId;
  assert.equal(eventId, `secretary-report:${id}:accepted:0:0`);
  assert.equal(first[0].status, 'accepted');
  const restored = readLast(journal);
  assert(restored.reportedStages?.includes('accepted:0:0'), '完成事件阶段必须持久化');
  const second = await verifyOnce(restored, journal);
  assert.equal(second.length, 0, '恢复后重验及重复回调不能再次播报');
  assert.equal(hash(), expectedHash, '复验期间交付文件发生变化');
  console.log(JSON.stringify({ passed: true, taskId: id, eventId, firstReports: first.length,
    restoredReports: second.length, beforeHash: expectedHash, afterHash: hash(), journal }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
