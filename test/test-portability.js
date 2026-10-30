'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { capabilities } = require('../src/main/runtime-capabilities');
const P = require('../src/main/tts-http-profile'), T = require('../src/main/tts-http');
const { MemoryService } = require('../src/main/memory-service');
const { DataLocation } = require('../src/main/data-location');
const { WorkBuddyConnection } = require('../src/main/workbuddy-connection');
const bin = path.resolve(__dirname, '../bin/vault');
async function main() {
  for (const version of ['13.0', '15.0', '26.0']) {
    const c = capabilities({ platform: 'darwin', arch: 'arm64', version, memory: 16 * 1024 ** 3 });
    assert(c.supported); assert.equal(c.asrMode, version.startsWith('26') ? 'continuous' : 'single');
  }
  assert(!capabilities({ platform: 'darwin', arch: 'arm64', version: '26', memory: 8 * 1024 ** 3 }).qwen.available);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-portability-'));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: b => b.toString() };
  let model = 'missing', identity = 'a', connected = true, connectionCalls = 0;
  const c = new WorkBuddyConnection({ identity: () => identity, catalog: async () => { connectionCalls++; if (!connected) throw new Error('请先登录 WorkBuddy'); return { models: [{ id: 'hy3' }] }; }, getModel: () => model, saveModel: v => { model = v; } });
  await Promise.all([c.connect(), c.connect()]); assert(c.status().ready); assert.equal(connectionCalls, 1); assert.equal(model, 'hy3');
  identity = 'b'; await c.connect(); assert.equal(c.status().generation, 1); connected = false; await c.connect(); assert(!c.status().ready); c.close();
  const source = path.join(root, 'vault');
  const memory = new MemoryService({ dir: source, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) });
  await memory.init(); assert(memory.ready, memory.error);
  const competing = new MemoryService({ dir: source, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) });
  await competing.init(); assert(!competing.ready); assert(/另一个 Bunny 进程/.test(competing.error), competing.error); await competing.close();
  await memory.addMessage('user', '这是一条仅用于迁移验收的合成消息');
  await memory.db.request('checkpoint');
  const before = await memory.db.request('stats');
  const dl = new DataLocation(root, bin), dest = path.join(root, 'destination'); fs.mkdirSync(dest);
  const result = await dl.migrate(dest, { quiesce: async () => { await memory.db.request('checkpoint'); await memory.close({ strict: true }); } });
  assert(result.ok); assert.equal(result.records, before.counts.total); assert.equal(dl.resolve(), path.join(fs.realpathSync(dest), 'vault'));
  assert.equal(fs.readFileSync(path.join(source, 'companion.db')).compare(fs.readFileSync(path.join(result.dir, 'companion.db'))), 0);
  const restored = new MemoryService({ dir: result.dir, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) });
  await restored.init(); assert(restored.ready, restored.error); assert((await restored.query('message', 10, { scene: 'life' })).some(r => r.value.content.includes('迁移验收')));
  await restored.close();
  const dest2 = path.join(root, 'bad-destination'); fs.mkdirSync(dest2);
  await assert.rejects(dl.migrate(dest2, { quiesce: async () => {}, verify: async () => { throw new Error('injected-failure'); } }), /injected/);
  assert.equal(dl.resolve(), result.dir); assert(!fs.existsSync(path.join(dest2, 'vault')));
  // Process exit bypasses catch/finally: exercise durable recovery at each phase.
  for (const phase of ['checked','quiesced','copied','verified','prepared','activated']) {
    const crashRoot = path.join(root, 'crash-' + phase); fs.mkdirSync(crashRoot);
    fs.cpSync(result.dir, path.join(crashRoot, 'vault'), { recursive: true });
    const parent = path.join(crashRoot, 'destination'); fs.mkdirSync(parent);
    const code = `const {DataLocation}=require(${JSON.stringify(path.resolve(__dirname,'../src/main/data-location'))});const d=new DataLocation(${JSON.stringify(crashRoot)},${JSON.stringify(bin)});d.onStage=p=>{if(p===${JSON.stringify(phase)})process.exit(73)};d.migrate(${JSON.stringify(parent)},{quiesce:async()=>{}}).catch(e=>{console.error(e);process.exit(1)});`;
    const exited = require('child_process').spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(exited.status, 73, exited.stderr);
    if (phase === 'prepared') {
      assert.throws(() => new DataLocation(crashRoot, bin).resolve(), /位置记录缺失/);
      fs.writeFileSync(path.join(crashRoot, 'storage-location.json'), JSON.stringify({ format: 'workbunny-location/v1', dir: path.join(parent, 'vault') }));
    }
    const recovered = new DataLocation(crashRoot, bin).resolve();
    assert.equal(fs.realpathSync(recovered), fs.realpathSync(path.join(['activated','prepared'].includes(phase) ? parent : crashRoot, 'vault')));
    assert.equal(require('../src/main/data-location').inspect(bin, path.join(recovered, 'companion.db')).count, before.counts.total);
    if (phase === 'activated') {
      fs.unlinkSync(path.join(crashRoot, 'storage-location.json'));
      assert.throws(() => new DataLocation(crashRoot, bin).resolve(), /位置记录缺失/);
    }
  }
  const damaged = path.join(root, 'damaged-pointer'); fs.mkdirSync(damaged); fs.writeFileSync(path.join(damaged, 'storage-location.json'), 'null');
  assert.throws(() => new DataLocation(damaged, bin).resolve(), /位置记录损坏/);
  const audio = Buffer.alloc(4800, 1), encoded = audio.toString('base64'); let seen;
  const server = http.createServer((req, res) => {
    const b = []; req.on('data', x => b.push(x)); req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(Buffer.concat(b)) };
      if (req.url === '/error') { res.writeHead(200); res.end(JSON.stringify({ code: 45000000, message: 'never surface token abc' }) + '\n'); return; }
      if (req.url === '/bad') { res.end(JSON.stringify({ code: 0, data: encoded }) + '\n'); return; }
      if (req.url === '/sse') { res.setHeader('content-type', 'text/event-stream'); res.write('event: 352\ndata: '+JSON.stringify({ code: 0, data: encoded })+'\n\nevent: 152\ndata: '+JSON.stringify({ code: 20000000, data: null })+'\n\n');res.end();return; }
      const s = JSON.stringify({ code: 0, data: encoded })+'\n'+JSON.stringify({ code: 0, data: null, sentence: '字幕' })+'\n'+JSON.stringify({ code: 20000000, data: null })+'\n';
      res.write(s.slice(0, 17)); setTimeout(() => res.end(s.slice(17)), 5);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = P.template(), url = `http://127.0.0.1:${server.address().port}`;
  profile.url = url + '/jsonl';
  const cfg = { http: { profile, params: { resourceId: 'test-resource', voice: 'test-voice' }, secrets: { apiKey: 'private-test-key' } } };
  try {
    const result = await T.synthesize('测试引号"与换行\n', cfg); assert.equal(result.buffer.length, audio.length + 44); assert.equal(result.engine, 'http');
    assert.equal(seen.body.req_params.text, '测试引号"与换行\n'); assert.equal(seen.headers['x-api-key'], 'private-test-key');
    profile.url = url + '/sse'; profile.response.framing = 'sse'; assert.equal((await T.synthesize('测试', cfg)).buffer.length, audio.length + 44);
    profile.url = url + '/error'; profile.response.framing = 'jsonl'; await assert.rejects(T.synthesize('测试', cfg), e => !e.message.includes('abc'));
    profile.url = url + '/bad'; await assert.rejects(T.synthesize('测试', cfg), /提前结束/);
    assert(!JSON.stringify(P.publicHTTP(cfg.http)).includes('private-test-key'));
    assert.throws(() => P.validate(JSON.parse('{"format":"workbunny-tts-http/v1","__proto__":{}}')), /字段/);
    assert.throws(() => P.validate({ ...profile, url: url + '/?api_key=secret' }), /凭据/);
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(T.synthesize('测试', cfg, { signal: aborted.signal }), { name: 'AbortError' });
  } finally { T.cancel(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Portability: capabilities, WorkBuddy lifecycle, real encrypted migration + six crash stages, JSONL/SSE, errors and secrets passed');
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
