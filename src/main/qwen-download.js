'use strict';

// Pinned community conversion of the official Qwen CustomVoice checkpoint.
// Its merged GGUF format is for speech.cpp, not llama.cpp.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const FILES = [
  { name: 'Qwen3-TTS-12Hz-1.7B-CustomVoice-Q4_K.gguf', bytes: 1329512960,
    sha256: 'd643b25ffa11e7c9687aae50d21b5a47076c4f5642c5e6b957f101a98024cc74' },
];
const MODEL_PATH = 'sakasegawa/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/resolve/a72e6c6575d67652488cdffc1c863215a9899978/';
const SOURCES = [
  { id: 'huggingface', label: 'Hugging Face', base: 'https://huggingface.co/' + MODEL_PATH },
  { id: 'mirror', label: '备用镜像', base: 'https://hf-mirror.com/' + MODEL_PATH },
];

function openResponse(url, headers, signal, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 8) return reject(new Error('下载地址重定向过多'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('下载地址无效')); }
    if (!['https:', 'http:'].includes(u.protocol)) return reject(new Error('下载协议无效'));
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      signal, headers: { 'User-Agent': 'workbunny/0.2.2', 'Accept-Encoding': 'identity', ...headers },
    });
    const timer = setTimeout(() => req.destroy(new Error('下载源连接超时')), 15000);
    req.setTimeout(30000, () => req.destroy(new Error('下载源长时间没有响应')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try {
          if (!res.headers.location) throw new Error('下载源缺少跳转地址');
          const next = new URL(res.headers.location, u);
          if (u.protocol === 'https:' && next.protocol !== 'https:') throw new Error('下载源尝试使用不安全连接');
          openResponse(next.href, headers, signal, hops + 1).then(resolve, reject);
        } catch (e) { reject(e); }
      } else resolve(res);
    });
  });
}

async function probeSource(source, file, signal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const start = Date.now();
  const res = await openResponse(source.base + file.name, { Range: 'bytes=0-63' }, signal);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    res.on('error', reject);
    if (![200, 206].includes(res.statusCode)) {
      res.destroy(); return reject(new Error('下载源暂不可用'));
    }
    const range = res.headers['content-range'];
    if (res.statusCode === 206 && range !== `bytes 0-63/${file.bytes}`) {
      res.destroy(); return reject(new Error('下载源的文件版本不匹配'));
    }
    res.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk.subarray(0, 64 - buf.length)]);
      if (buf.length < 64) return;
      res.destroy();
      if (buf.subarray(0, 4).toString() !== 'GGUF') return reject(new Error('下载源返回的不是模型文件'));
      resolve({ ...source, ms: Date.now() - start });
    });
    res.on('end', () => { if (buf.length < 64) reject(new Error('下载源返回不完整')); });
  });
}

async function sha256(file, signal) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash, { signal });
  return hash.digest('hex');
}
function size(file) { try { return fs.statSync(file).size; } catch { return 0; } }

function createDownloader({ files = FILES, sources = SOURCES } = {}) {
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const manifest = files.map((f) => f.sha256).join(':');
  const receiptName = '.verified-v1.json';
  const state = { running: false, done: 0, bytes: 0, total, count: files.length, file: '', err: '', phase: '', source: '', cancelled: false };
  let controller, job;
  function writeReceipt(dir) {
    const receipt = { manifest, verifiedAt: Date.now(), files: Object.fromEntries(files.map((f) => [f.name,
      { sha256: f.sha256, mtimeMs: fs.statSync(path.join(dir, f.name)).mtimeMs }])) };
    const tmp = path.join(dir, receiptName + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, receiptName));
  }
  async function check(dir) {
    if (state.running) return { ok: false, error: '模型仍在下载，请完成后再检查。' };
    const start = Date.now();
    try {
      for (const f of files) {
        const file = path.join(dir, f.name);
        if (size(file) !== f.bytes || await sha256(file) !== f.sha256)
          throw new Error('模型文件缺失或校验失败，请点击下载模型修复。');
      }
      writeReceipt(dir);
      return { ok: true, files: files.length, bytes: total, ms: Date.now() - start };
    } catch (e) {
      try { fs.rmSync(path.join(dir, receiptName), { force: true }); } catch {}
      return { ok: false, error: e.message, ms: Date.now() - start };
    }
  }
  function ready(dir) {
    if (!dir) return false;
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, receiptName), 'utf8'));
      return receipt.manifest === manifest && files.every((f) => {
        const st = fs.statSync(path.join(dir, f.name)), saved = receipt.files[f.name];
        return st.isFile() && st.size === f.bytes && saved?.sha256 === f.sha256 && saved.mtimeMs === st.mtimeMs;
      });
    } catch { return false; }
  }
  async function downloadFile(source, f, dest, baseBytes, signal) {
    const part = dest + '.part';
    if (size(part) > f.bytes) fs.unlinkSync(part);
    let offset = size(part);
    if (offset < f.bytes) {
      const res = await openResponse(source.base + f.name, { Range: `bytes=${offset}-` }, signal);
      if (res.statusCode === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range'] || '');
        if (!m || +m[1] !== offset || +m[2] !== f.bytes - 1 || +m[3] !== f.bytes) {
          res.destroy(); throw new Error('下载源断点范围不匹配');
        }
      } else if (res.statusCode === 200) offset = 0;
      else { res.destroy(); throw new Error(`下载源返回 ${res.statusCode}`); }
      const length = res.headers['content-length'];
      if (length !== undefined && +length !== f.bytes - offset) {
        res.destroy(); throw new Error('下载源文件大小不匹配');
      }
      state.phase = 'downloading'; state.bytes = baseBytes + offset;
      let got = offset;
      res.on('data', (chunk) => {
        got += chunk.length; state.bytes = baseBytes + got;
        if (got > f.bytes) res.destroy(new Error('下载源文件超出预期大小'));
      });
      await pipeline(res, fs.createWriteStream(part, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal });
    }
    state.phase = 'verifying'; state.bytes = baseBytes + size(part);
    if (size(part) !== f.bytes || await sha256(part, signal) !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('模型完整性校验失败，正在换源');
    }
    fs.renameSync(part, dest);
  }
  async function run(dir, signal) {
    if (ready(dir)) {
      state.done = files.length; state.bytes = total; state.phase = 'complete'; return;
    }
    // Probe real file endpoints, not IP geolocation services or a timezone guess.
    // Pick the faster reachable route; give the domestic source a small tie bias.
    state.phase = 'selecting';
    const checks = await Promise.allSettled(sources.map((s) => probeSource(s, files[0], signal)));
    signal.throwIfAborted();
    const order = checks.filter((r) => r.status === 'fulfilled').map((r) => r.value)
      .sort((a, b) => a.ms * (a.id === 'modelscope' ? 0.8 : 1) - b.ms * (b.id === 'modelscope' ? 0.8 : 1));
    if (!order.length) throw new Error('国内和海外下载源暂时都无法连接，请检查网络后重试');
    let baseBytes = 0;
    for (const f of files) {
      signal.throwIfAborted(); state.file = f.name; state.phase = 'verifying';
      const dest = path.join(dir, f.name);
      if (size(dest) !== f.bytes || await sha256(dest, signal) !== f.sha256) {
        let last;
        // A temporarily failed probe is still worth trying if all healthy routes fail.
        const fallbacks = [...order, ...sources.filter((s) => !order.some((o) => o.id === s.id))];
        for (const source of fallbacks) {
          signal.throwIfAborted(); state.source = source.label;
          try { await downloadFile(source, f, dest, baseBytes, signal); last = null; break; }
          catch (e) { signal.throwIfAborted(); last = e; }
        }
        if (last) throw new Error('下载中断，已保留断点；点击继续下载可重试。' + last.message);
      }
      baseBytes += f.bytes; state.bytes = baseBytes; state.done++;
    }
    signal.throwIfAborted();
    writeReceipt(dir);
    state.file = ''; state.phase = 'complete';
  }
  function start(dir) {
    if (state.running) return { started: false, reason: '正在下载中' };
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (e) { return { started: false, reason: e.message }; }
    Object.assign(state, { running: true, done: 0, bytes: 0, file: '', err: '', phase: 'selecting', source: '', cancelled: false });
    controller = new AbortController();
    job = run(dir, controller.signal).catch((e) => {
      state.cancelled = controller.signal.aborted;
      state.err = state.cancelled ? '已取消，断点已保留，下次可继续下载。' : e.message;
      state.phase = state.cancelled ? 'cancelled' : 'error';
    }).finally(() => { state.running = false; });
    return { started: true };
  }
  async function remove(dir) {
    controller?.abort();
    await job;
    let bytes = 0;
    for (const f of files) {
      for (const suffix of ['', '.part']) {
        const file = path.join(dir, f.name + suffix); bytes += size(file);
        await fs.promises.rm(file, { force: true });
      }
    }
    for (const name of [receiptName, receiptName + '.tmp']) await fs.promises.rm(path.join(dir, name), { force: true });
    Object.assign(state, { running: false, done: 0, bytes: 0, file: '', err: '', phase: '', source: '', cancelled: false });
    return { ok: true, bytes };
  }
  return { start, ready, check, remove, state: () => ({ ...state }), cancel: () => controller?.abort(), wait: () => job };
}

const downloader = createDownloader();
module.exports = { FILES, SOURCES, createDownloader, probeSource,
  downloadQwen: downloader.start, qwenReady: downloader.ready,
  checkQwen: downloader.check, deleteQwen: downloader.remove,
  downloadState: downloader.state, cancelDownload: downloader.cancel };
