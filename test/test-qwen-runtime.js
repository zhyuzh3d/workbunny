'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { createRuntime } = require('../src/main/qwen-runtime');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-runtime-test-'));
  const binary = path.join(dir, 'worker');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const readline=require('readline');let active;
const send=o=>console.log(JSON.stringify(o));
send({type:'ready',protocol:3,model:{name:'Qwen3-TTS-CustomVoice',sample_rate:24000,voices:[{name:'serena'}]}});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.type==='cancel'){clearTimeout(active);send({type:'cancelled',id:r.id});return;}
if(r.text==='hang')return;
if(r.text==='crash'){process.exit(2);return;}
active=setTimeout(()=>{const pcm=Buffer.from(r.text.padEnd(r.text.length+(r.text.length%2),' '));
send({type:'chunk',id:r.id,seq:r.text==='bad-sequence'?2:0,pcm:pcm.toString('base64')});
send({type:'end',id:r.id,samples:pcm.length/2,stop:r.text==='truncated'?'max_seconds':'complete'});},20);});
`, { mode: 0o700 });
  const files = [{ name: 'model.gguf' }]; fs.writeFileSync(path.join(dir, files[0].name), 'fixture');
  let starts = 0;
  const runtime = createRuntime({ findBinary: () => binary, files, timeoutMs: 180,
    spawnProcess: (...args) => { starts++; return require('child_process').spawn(...args); } });
  t.after(() => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, runtime, starts: () => starts };
}
test('CustomVoice PCM requests serialize, preserve samples and reuse the loaded process', async (t) => {
  const f = fixture(t); await f.runtime.prewarm(f.dir);
  const chunks=[];
  const results = await Promise.all(['one', 'two', 'three'].map(text => f.runtime.synthesize(text, {dir:f.dir}, {onChunk:pcm=>chunks.push(pcm.toString().trim())})));
  assert.deepEqual(results.map(r=>r.buffer.subarray(44).toString().trim()), ['one','two','three']);
  assert.deepEqual(chunks,['one','two','three']); assert.ok(results.every(r=>r.streamed&&r.stats.audioSeconds>0));
  assert.equal(results[0].buffer.readUInt32LE(24),24000);
  assert.equal(f.starts(),1); assert.equal(f.runtime.status().queued,0);
});
test('prewarm is shared and an idle cancel preserves the warm model', async (t) => {
  const f=fixture(t); const first=f.runtime.prewarm(f.dir), second=f.runtime.prewarm(f.dir);
  assert.equal(first,second); f.runtime.cancel(); await first;
  assert.equal(f.runtime.status().ready,true); assert.equal(f.starts(),1);
});
test('cancel rejects active and queued speech and reuses the worker after acknowledgement', async (t) => {
  const f=fixture(t); await f.runtime.prewarm(f.dir);
  const pending=f.runtime.synthesize('hang',{dir:f.dir});
  const queued=f.runtime.synthesize('next',{dir:f.dir});
  const checked=Promise.all([assert.rejects(pending,{name:'AbortError'}),assert.rejects(queued,{name:'AbortError'})]);
  await new Promise(r=>setTimeout(r,10)); f.runtime.cancel(); await checked;
  assert.equal((await f.runtime.synthesize('works',{dir:f.dir})).buffer.subarray(44).toString().trim(),'works');
  assert.equal(f.starts(),1);
});
test('crash, missing chunks and truncation fail without returning partial audio', async (t) => {
  const f=fixture(t);
  await assert.rejects(f.runtime.synthesize('crash',{dir:f.dir}),/退出/);
  assert.equal((await f.runtime.synthesize('works',{dir:f.dir})).buffer.subarray(44).toString().trim(),'works');
  await assert.rejects(f.runtime.synthesize('bad-sequence',{dir:f.dir}),/顺序/);
  await assert.rejects(f.runtime.synthesize('truncated',{dir:f.dir}),/完整/);
  await assert.rejects(f.runtime.synthesize('hang',{dir:f.dir}),/超时/);
});
