'use strict';
// Explicit manual acceptance helper; requires GUI ownership and never creates a task.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');
const { DesktopNative } = require('../src/main/desktop-native');
const { makeWorkBuddyOutbound } = require('../src/main/desktop-service');
const id = '69722ee1-2a7a-439b-9911-e690e8887f28';
const marker = `[workbunny:${id}]`;
const goal = '这是纯文字测试。第一轮只回复“Bunny生命周期第一轮通过”。不要读取、创建或修改文件，不要使用工具，不要发送任何消息；之后按用户追问修改文字。';
const criteria = '根据后续追问，最终答复包含“Bunny生命周期第二轮通过”。';
const outboundText = makeWorkBuddyOutbound({ goal, criteria, recipient: '文件传输助手', associationMarker: marker });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wb-synthetic-clear-'));
const journal = path.join(dir, 'journal.jsonl'), textFile = path.join(dir, 'outbound.txt');
function record(value) { fs.appendFileSync(journal, JSON.stringify({ at: Date.now(), ...value }) + '\n', { mode: 0o600 }); }
let native;
(async () => {
  await app.whenReady(); native = new DesktopNative(path.resolve('bin/desktop'));
  fs.writeFileSync(textFile, outboundText, { mode: 0o600, flag: 'wx' });
  const scan = spawnSync('rg', ['-l', '--fixed-strings', '--glob', '*.jsonl', marker, path.join(os.homedir(), '.workbuddy/projects')], { encoding: 'utf8', timeout: 10000 });
  if (scan.status !== 1) throw new Error('Monitor 记录不为空或无法确认；停止清理');
  const f = await native.request('frontmost', {}, 5000);
  if (f.application?.bundleId !== 'com.tencent.workbuddy.mac') throw new Error('原 WorkBuddy 窗口不在前台');
  const w = f.windows.find(x => x.pid === f.application.pid && x.layer === 0 && x.rect.width > 100 && x.rect.height > 80);
  if (!w) throw new Error('找不到原 WorkBuddy 窗口');
  const payload = { expected: { bundleId: f.application.bundleId, pid: f.application.pid }, windowId: w.windowId, text: outboundText };
  const state = await native.request('workbuddyInspect', payload, 8000);
  if (!(state.available && state.homeReady && state.editorCount === 1 && state.draftEmpty === false && state.draftMatchesRequest === true)) throw new Error('草稿与完整合成原文不匹配，停止清理');
  record({ id, marker, goal, criteria, outboundText, priorSubmit: 'unknown', monitorMatches: 0, draftMatches: true, phase: 'before-clear' });
  console.log(JSON.stringify({ journal }));
  const result = spawnSync('swift', [path.resolve('test/workbuddy-clear-synthetic.swift'), String(f.application.pid), String(w.windowId), textFile], { encoding: 'utf8', timeout: 15000 });
  record({ phase: 'clear-attempted', status: result.status, error: result.error?.message || null });
  if (result.status !== 0) throw new Error(`清理结果未确认，绝不重试：${result.stderr || result.error?.message || 'unknown'}`);
  const after = await native.request('workbuddyInspect', payload, 8000);
  record({ phase: 'after-clear', available: after.available, draftEmpty: after.draftEmpty });
  if (after.available !== true || after.draftEmpty !== true) throw new Error('清理后空草稿未确认；停止后续测试');
  console.log(JSON.stringify({ cleared: true, journal }));
})().then(async () => { await native?.close(); app.exit(0); }, async error => { record({ phase: 'failed', error: error.message }); console.error(error.message); await native?.close(); app.exit(1); });
