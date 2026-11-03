'use strict';
// Explicitly invoked live acceptance only. Requires exclusive GUI ownership.
// WorkBuddy creates one isolated HTML artifact; the test never writes its content.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DesktopService } = require('../src/main/desktop-service');
const { DesktopNative } = require('../src/main/desktop-native');
const { Monitor } = require('../src/main/monitor');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const { Secretary } = require('../src/main/secretary');
const { collectDeliveryEvidence } = require('../src/main/delivery-evidence');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-artifact-profile-'));
const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-artifact-journal-'));
const journalPath = path.join(journalDir, 'task.jsonl');
fs.writeFileSync(journalPath, '', { flag: 'wx', mode: 0o600 });
// /tmp is a symlink on macOS; the canonical path allows delivery evidence to
// perform its no-symlink check while referring to the same unique /tmp folder.
const artifactDir = fs.realpathSync(fs.mkdtempSync('/tmp/bunny-workbuddy-artifact-'));
const artifact = path.join(artifactDir, 'checklist.html');
app.setPath('userData', profile);
let service, monitor, secretary;
const reports = [];
async function run() {
  await app.whenReady();
  await require('../src/main/model-catalog').refresh('workbuddy');
  monitor = new Monitor(); monitor.start(path.join(os.homedir(), '.workbuddy/projects'));
  service = new DesktopService({ native: new DesktopNative(path.resolve('bin/desktop')),
    observeWorkBuddy: task => observeWorkBuddy(monitor, task),
    persist: async task => fs.appendFileSync(journalPath, JSON.stringify(task) + '\n', { mode: 0o600 }),
    imageResize: png => { const img = nativeImage.createFromBuffer(png), size = img.getSize(); return img.resize({ width: Math.min(1280, size.width) }).toPNG(); },
    emit: state => { if (state.task?.status !== run.last) { run.last = state.task?.status; console.log(JSON.stringify({ phase: run.last })); } secretary?.onStatus(state); },
  });
  secretary = new Secretary({ desktop: service, ready: () => true, epoch: () => 0, getScene: () => 'life', maxFollowUps: 0,
    report: async report => reports.push(report) });
  const goal = `创建 ${artifact} 。只允许在 ${artifactDir}/ 读取和写入本次测试文件，不访问其他文件或网络，不操作微信或其他应用。生成一个独立、可直接打开的中文 HTML 页面，标题为“物资清单”；页面展示三行数据：铅笔12支、橡皮8块、尺子5把，并明确写出数量合计25；再附两条简短的整理检查事项。不要覆盖已有文件。完成后报告文件绝对路径。`;
  const criteria = '文件实际存在；HTML 为独立中文页面，包含指定三行物资、数量合计25及两条整理检查事项。';
  const response = await secretary.dispatch({ action: 'start', target: 'workbuddy', goal, criteria },
    { requestId: `artifact-live-${Date.now()}`, userText: goal, source: 'text', sources: [] });
  assert(response.taskId, `任务启动失败：${response.text}`);
  console.log(JSON.stringify({ taskId: response.taskId, artifactDir, artifact, journalPath }));
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline && !['accepted', 'paused', 'failed', 'stopped'].includes(service.task?.status)) await delay(250);
  if (!['accepted', 'paused', 'failed', 'stopped'].includes(service.task?.status)) {
    await service.stop('文件验收等待超时'); throw new Error('文件验收超过等待上限，已停止本地监督');
  }
  if (secretary.verifying) await secretary.verifying;
  const task = service.task;
  assert.equal(task.id, response.taskId);
  assert.equal(task.status, 'accepted', `Secretary 未接受文件交付：${task.note || ''}`);
  assert.equal(task.verification?.verdict, 'pass');
  assert.equal(task.followUpRound, 0);
  assert(task.monitorSessionId && task.monitorMessageKey, '未绑定实际 WorkBuddy 会话及消息');
  const evidence = await collectDeliveryEvidence(task);
  const file = evidence.files.find(row => row.path === artifact);
  assert(evidence.requiredOutputs?.includes(artifact), '交付路径未被识别为明确要求');
  assert(file?.exists && /^[a-f0-9]{64}$/.test(file.sha256 || ''), '文件证据缺少存在性或哈希');
  const manifest = task.verification?.artifactManifest?.files?.find(row => row.path === artifact);
  assert(manifest && manifest.sha256 === file.sha256, '真实验收没有包含稳定的文件内容证据');
  const stat = fs.lstatSync(artifact);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 256 * 1024);
  const contents = fs.readFileSync(artifact, 'utf8');
  for (const required of ['物资清单', '铅笔', '橡皮', '尺子', '12', '8', '5', '25']) assert(contents.includes(required), `文件缺少 ${required}`);
  assert.equal(reports.filter(item => item.status === 'accepted').length, 1);
  console.log(JSON.stringify({ passed: true, taskId: task.id, artifact, sha256: file.sha256,
    secretaryVerdict: task.verification.verdict, requiredOutputVerified: true, acceptedReports: 1, journalPath }));
}
async function finish(code) {
  secretary?.close(); monitor?.stop(); await service?.close();
  fs.rmSync(profile, { recursive: true, force: true }); app.exit(code);
}
run().then(() => finish(0), error => { console.error(error.stack || error.message); void finish(1); });
