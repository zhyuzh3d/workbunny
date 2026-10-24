'use strict';
// Tiny HTTP fixtures exercise interrupted downloads without fetching model weights.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createDownloader } = require('../src/main/qwen-download');
const buffers = [Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(128 * 1024, 17)]),
  Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4096, 29)])];
const files = buffers.map((b, i) => ({ name: `${i}.gguf`, bytes: b.length,
  sha256: crypto.createHash('sha256').update(b).digest('hex') }));

async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-download-test-'));
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { dir, base };
}
function serve(req, res, options = {}) {
  const index = Number(req.url.match(/(\d)\.gguf/)[1]);
  const original = buffers[index], data = Buffer.from(original);
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const probe = match && match[2] === '63';
  if (options.corrupt && !probe) data[100] ^= 1;
  const start = options.ignoreRange ? 0 : Number(match?.[1] || 0);
  const end = options.ignoreRange ? data.length - 1 : Number(match?.[2] || data.length - 1);
  res.writeHead(options.ignoreRange ? 200 : 206, { 'Content-Length': end - start + 1,
    ...(options.ignoreRange ? {} : { 'Content-Range': `bytes ${start}-${end}/${data.length}` }) });
  const body = data.subarray(start, end + 1);
  if (options.truncate && !probe) { res.write(body.subarray(0, 1000)); return setTimeout(() => res.destroy(), 10); }
  if (options.slow && !probe) {
    let pos = 0;
    const timer = setInterval(() => {
      if (pos >= body.length) { clearInterval(timer); res.end(); return; }
      res.write(body.subarray(pos, pos += 1024));
    }, 8);
    res.on('close', () => clearInterval(timer));
    return;
  }
  res.end(body);
}
async function until(predicate) {
  const limit = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > limit) throw new Error('fixture timed out'); await new Promise((r) => setTimeout(r, 10)); }
}

test('relative redirects, exact range resume, verified receipt and changed-file detection', async (t) => {
  const ranges = [];
  const { dir, base } = await fixture(t, (req, res) => {
    if (req.url.startsWith('/mirror/')) { res.writeHead(307, { Location: '../data/' + path.basename(req.url) }); res.end(); }
    else { ranges.push(req.headers.range); serve(req, res); }
  });
  fs.writeFileSync(path.join(dir, files[0].name + '.part'), buffers[0].subarray(0, 800));
  const dl = createDownloader({ files, sources: [{ id: 'modelscope', label: 'mirror', base: base + 'mirror/' }] });
  assert.equal(dl.ready(dir), false);
  assert.equal(dl.start(dir).started, true);
  assert.equal(dl.start(dir).started, false);
  await dl.wait();
  assert.equal(dl.state().err, ''); assert.equal(dl.state().bytes, files.reduce((s, f) => s + f.bytes, 0));
  assert.equal(dl.ready(dir), true); assert.ok(ranges.includes('bytes=800-'));
  assert.deepEqual(fs.readFileSync(path.join(dir, files[0].name)), buffers[0]);
  fs.appendFileSync(path.join(dir, files[1].name), 'bad'); assert.equal(dl.ready(dir), false);
});

test('cancel settles immediately, keeps partial file, then resumes successfully', async (t) => {
  let slow = true;
  const { dir, base } = await fixture(t, (req, res) => serve(req, res, { slow }));
  const dl = createDownloader({ files, sources: [{ id: 'modelscope', label: 'mirror', base }] });
  dl.start(dir); await until(() => dl.state().bytes >= 2048); dl.cancel(); await dl.wait();
  assert.equal(dl.state().running, false); assert.equal(dl.state().cancelled, true); assert.equal(dl.ready(dir), false);
  assert.ok(fs.statSync(path.join(dir, files[0].name + '.part')).size > 0);
  slow = false; dl.start(dir); await dl.wait(); assert.equal(dl.ready(dir), true);
});

test('corrupt primary is rejected and replaced with verified fallback', async (t) => {
  const { dir, base } = await fixture(t, (req, res) => {
    if (req.url.startsWith('/good/')) setTimeout(() => serve(req, res), 15);
    else serve(req, res, { corrupt: true });
  });
  const dl = createDownloader({ files, sources: [
    { id: 'modelscope', label: 'bad', base: base + 'bad/' },
    { id: 'huggingface', label: 'good', base: base + 'good/' },
  ] });
  dl.start(dir); await dl.wait(); assert.equal(dl.state().err, ''); assert.equal(dl.ready(dir), true);
  assert.equal(dl.state().source, 'good');
});

test('truncated transfers never become ready; retry retains recoverable data', async (t) => {
  const { dir, base } = await fixture(t, (req, res) => serve(req, res, { truncate: true }));
  const dl = createDownloader({ files, sources: [{ id: 'modelscope', label: 'bad', base }] });
  dl.start(dir); await dl.wait(); assert.equal(dl.state().phase, 'error'); assert.equal(dl.ready(dir), false);
  assert.equal(fs.existsSync(path.join(dir, files[0].name)), false);
  assert.ok(fs.existsSync(path.join(dir, files[0].name + '.part')));
});

test('server ignoring Range safely restarts instead of appending duplicate bytes', async (t) => {
  const { dir, base } = await fixture(t, (req, res) => serve(req, res, { ignoreRange: true }));
  const dl = createDownloader({ files, sources: [{ id: 'modelscope', label: 'mirror', base }] });
  fs.writeFileSync(path.join(dir, files[0].name + '.part'), buffers[0].subarray(0, 800));
  dl.start(dir); await dl.wait(); assert.equal(dl.state().err, ''); assert.equal(dl.ready(dir), true);
});

test('cancellation while selecting a source settles without hanging', async (t) => {
  const { dir, base } = await fixture(t, () => {});
  const dl = createDownloader({ files, sources: [{ id: 'modelscope', label: 'slow', base }] });
  dl.start(dir); dl.cancel(); await dl.wait();
  assert.equal(dl.state().running, false); assert.equal(dl.state().cancelled, true);
});

test('explicit check rehashes offline and rejects same-size corruption', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-model-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  files.forEach((f, i) => fs.writeFileSync(path.join(dir, f.name), buffers[i]));
  const dl = createDownloader({ files, sources: [] });
  assert.equal((await dl.check(dir)).ok, true); assert.equal(dl.ready(dir), true);
  const corrupted = Buffer.from(buffers[0]); corrupted[100] ^= 1;
  fs.writeFileSync(path.join(dir, files[0].name), corrupted);
  assert.equal((await dl.check(dir)).ok, false); assert.equal(dl.ready(dir), false);
  assert.equal(fs.existsSync(path.join(dir, '.verified-v1.json')), false);
});

test('deleting model files preserves unrelated files and voice references', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-model-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  files.forEach((f, i) => fs.writeFileSync(path.join(dir, f.name), buffers[i]));
  fs.writeFileSync(path.join(dir, files[0].name + '.part'), 'partial');
  fs.writeFileSync(path.join(dir, 'my-voice.wav'), 'reference');
  const dl = createDownloader({ files, sources: [] }); await dl.check(dir);
  const removed = await dl.remove(dir);
  assert.equal(removed.ok, true); assert.ok(removed.bytes > 0); assert.equal(dl.ready(dir), false);
  assert.deepEqual(fs.readdirSync(dir), ['my-voice.wav']); assert.equal(dl.state().bytes, 0);
});
