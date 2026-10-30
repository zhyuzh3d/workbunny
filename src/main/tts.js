'use strict';
/**
 * 语音合成。三档引擎，默认第一档：
 *
 *   system（默认）macOS 自带 /usr/bin/say。离线、零配置、立刻出声。
 *   qwen          本地 Qwen3-TTS 1.7B CustomVoice，由 speech.cpp 运行，内置九种音色。
 *   remote        局域网 CHP，通过信息文档获取 TTS 模型和音色。
 *
 * 为什么默认从远程改成系统：以前默认是局域网那台机器，它一关机，每句话都要先白等
 * 一两秒超时才降级 —— 对话节奏发木，而且主人以为她卡了。系统语音是"永远在"的底线，
 * 好听的声音是加分项，不该是开机条件。
 *
 * ── 兼容性 ──
 * /usr/bin/say 从 OS X 10.7 起就在，最近十几年（远不止五年）的 macOS 全都有。
 * 参数只用 -v / -r / -o / --data-format，全都是老参数，不会因为系统版本变掉。
 * 输出固定 LEI16@24000：渲染层按 24k/16bit 算时长和波形做口型，格式不一致嘴就对不上。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const qwenDownload = require('./qwen-download');
const voiceFiles = require('./qwen-voices');
const { createRuntime } = require('./qwen-runtime');
const chp = require('./chp-tts');
const custom = require('./tts-http');

const cache = new Map(); // hash -> Buffer
const CACHE_MAX = 40;

/* ═══════════ 1. 系统语音 ═══════════ */
function createSystemTTS({ execFileImpl = execFile, tmpdir = os.tmpdir, timeoutMs = 20000 } = {}) {
  return function systemTTS(text, voice, rate, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('系统语音合成已停止'), { name: 'AbortError' }));
      let dir, child, settled = false, inputFailed = false;
      const abortError = () => Object.assign(new Error('系统语音合成已停止'), { name: 'AbortError' });
      const cleanup = async () => {
        if (!dir) return null;
        try { await fs.promises.rm(dir, { recursive: true, force: true }); dir = null; return null; }
        catch { return new Error('系统语音临时文件清理失败'); }
      };
      const finish = async (err, buf) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        // execFile's callback runs after the child has closed. Keep cleanup here
        // so `say` can never recreate the file after we have removed it.
        const cleanupError = await cleanup();
        if (cleanupError) return reject(cleanupError);
        if (signal?.aborted) return reject(abortError());
        if (err) {
          return reject(new Error(err.code === 'ETIMEDOUT'
            ? '系统语音合成超时' : '系统语音合成失败'));
        }
        if (inputFailed) return reject(new Error('系统语音输入失败'));
        if (!buf) return reject(new Error('系统语音输出读取失败'));
        if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return reject(new Error('系统语音输出异常'));
        resolve(buf);
      };
      const onAbort = () => { try { child?.kill('SIGKILL'); } catch {} };
      const onInputError = () => {
        inputFailed = true;
        try { child?.kill('SIGKILL'); } catch {}
      };

      try {
        // A private directory also protects the WAV while `say` is writing it.
        dir = fs.mkdtempSync(path.join(tmpdir(), 'wb-tts-'));
        fs.chmodSync(dir, 0o700);
      } catch {
        return cleanup().then((cleanupError) => reject(cleanupError || new Error('无法创建系统语音临时目录')));
      }
      const out = path.join(dir, 'speech.wav');
      const args = ['-r', String(rate || 200), '-o', out, '--data-format=LEI16@24000'];
      if (voice) args.push('-v', voice);
      args.push('-f', '-');
      try {
        child = execFileImpl('/usr/bin/say', args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, async (err) => {
          if (err) return finish(err);
          let buf;
          try { buf = await fs.promises.readFile(out); }
          catch { return finish(new Error('read')); }
          return finish(null, buf);
        });
        if (!child?.stdin) {
          inputFailed = true;
          try { child?.kill('SIGKILL'); } catch {}
        } else {
          child.stdin.on('error', onInputError);
          try { child.stdin.end(text); }
          catch { onInputError(); }
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      } catch (err) {
        // No child was successfully started, so there is no writer to wait for.
        finish(err);
      }
    });
  };
}
const systemTTS = createSystemTTS();

/** 系统里装了哪些中文音色（一次探测，缓存）。名字按好听程度排好，缺哪个就往下顺。 */
let zhVoices = null;
const ZH_PREFERRED = ['Tingting', 'Meijia', 'Sinji', 'Yu-shu', 'Han', 'Xiaoxiao'];
function systemVoices() {
  if (zhVoices) return zhVoices;
  const all = [];
  try {
    const out = require('child_process').execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S[\w .\-]*?)\s{2,}(\S{2,5})\s{2,}#/);
      if (!m) continue;
      all.push({ id: m[1].trim(), lang: m[2].trim() });
    }
  } catch {
    zhVoices = [];
    return zhVoices;
  }
  const zh = all.filter((v) => /^zh/i.test(v.lang));
  // 主人要的是中文嗓子，英文音色列出来只会让人挑错
  zhVoices = all;
  zhVoices.sort((a, b) => {
    const ia = ZH_PREFERRED.indexOf(a.id), ib = ZH_PREFERRED.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return zhVoices;
}
/** 挑一个本机真有的音色：指定了却没有，就顺位往下，绝不让 say 因为音色名报错 */
function pickSystemVoice(want) {
  if (!want || want === 'system-default') return '';
  const list = systemVoices();
  if (!list.length) return '';
  if (want && list.some((v) => v.id.toLowerCase() === String(want).toLowerCase())) {
    return list.find((v) => v.id.toLowerCase() === String(want).toLowerCase()).id;
  }
  for (const p of ZH_PREFERRED) {
    const hit = list.find((v) => v.id.toLowerCase() === p.toLowerCase());
    if (hit) return hit.id;
  }
  return list[0].id;
}

/* ═══════════ 2. 本地 Qwen CustomVoice（speech.cpp GGUF） ═══════════ */
const QWEN_FILES = qwenDownload.FILES;
function findSpeechRuntime() {
  for (const p of [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'bin', 'speech', 'speech')] : []),
    path.join(__dirname, '..', '..', 'bin', 'speech', 'speech'),
    path.join(__dirname, '..', '..', '..', 'bin', 'speech', 'speech'),
  ]) {
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const qwenRuntime = createRuntime({ findBinary: findSpeechRuntime, files: QWEN_FILES });
async function qwenTTS(text, q, options) {
  if (!q?.dir || !qwenDownload.qwenReady(q.dir)) throw new Error('本地模型还没下载或校验完成');
  return qwenRuntime.synthesize(text, q, options);
}
async function prewarm(q) { require('./runtime-capabilities').requireQwen(); if (q?.dir && qwenDownload.qwenReady(q.dir)) await qwenRuntime.prewarm(q.dir); }

/** Stable identity for persistent interaction audio, based on the active engine. */
async function voiceIdentity(cfg) {
  const engine = cfg.engine || 'system';
  if (engine === 'http') return { engine, profile: require('./tts-http-profile').identity(cfg.http), voice: cfg.http?.params?.voice };
  if (engine === 'qwen') return { engine, model: QWEN_FILES.map(f => f.sha256), voice: cfg.qwen?.voice || 'serena' };
  if (engine === 'remote') {
    const catalog = chp.cached(cfg) || await chp.discover(cfg).catch(() => null);
    if (!catalog) return null; // Let ordinary synthesis handle its system fallback.
    return { engine, service: catalog.endpoint, model: [catalog.model, catalog.file, catalog.version], voice: cfg.chp?.voice || catalog.voices[0].id };
  }
  if (!cfg.voice) return null; // OS default can change without a Bunny setting change.
  return { engine: 'system', model: 'macos-system', voice: pickSystemVoice(cfg.voice), rate: cfg.rate || 200 };
}

/* ═══════════ 合成入口 ═══════════ */
/**
 * @param {string} text
 * @param {object} cfg  config.tts
 * @returns {Promise<{buffer:Buffer,ms:number,cached:boolean,engine?:string,voice?:string,reason?:string}>}
 */
async function synthesize(text, cfg, options = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('空文本');
  if (!cfg || !cfg.enabled) throw new Error('发声已关闭');

  const engine = cfg.engine || 'system';
  const hash = crypto
    .createHash('sha1')
    .update([clean, engine, cfg.voice, cfg.rate,
      cfg.qwen && cfg.qwen.voice, cfg.qwen?.modelKind, cfg.qwen && cfg.qwen.dir,
      cfg.model, cfg.instructions, cfg.seed, cfg.speed, cfg.language, cfg.baseURL, cfg.apiKey, cfg.chp?.voice, require('./tts-http-profile').identity(cfg.http)].join('\u0001'))
    .digest('hex');
  if (cache.has(hash)) return { ...cache.get(hash), ms: 0, cached: true, streamed: false };

  const t0 = Date.now();
  let lastErr = null;
  let buffer = null;
  let used = 'system';
  let streamed = false, stats;

  // ① 主人指定的引擎（系统引擎本身就是兜底，不用再包一层）
  if (engine === 'qwen') {
    try {
      require('./runtime-capabilities').requireQwen();
      const result = await qwenTTS(clean, cfg.qwen, options);
      buffer = result.buffer; streamed = result.streamed; stats = result.stats;
      used = 'qwen';
    } catch (e) { if (e.name === 'AbortError') throw e; options.onStop?.(); lastErr = e; }
  } else if (engine === 'http') {
    try { const result = await custom.synthesize(clean, cfg, options); buffer = result.buffer; used = 'http'; stats = { httpVoice: result.voice }; }
    catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; }
  } else if (engine === 'remote') {
    try {
      const result = await chp.synthesize(clean, cfg, options);
      buffer = result.buffer; used = 'remote'; stats = { chpVoice: result.voice };
    } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; }
  }

  if (!buffer && engine !== 'system' && options.strict) throw lastErr || new Error('所选语音未返回音频');
  // ② 兜底：系统语音。绝不让"她不说话"成为一个可能的状态。
  if (!buffer) {
    const voice = engine === 'system' ? pickSystemVoice(cfg.voice) : '';
    try {
      buffer = await systemTTS(clean, voice, cfg.rate, { signal: options.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error((lastErr ? lastErr.message + ' / ' : '') + '系统语音也失败：' + e.message);
    }
    const result = {
      buffer, ms: Date.now() - t0, cached: false, engine: 'system', voice,
      degraded: engine !== 'system',
      reason: lastErr && lastErr.message,
    };
    // A system fallback must not hide a newly downloaded model on the next try.
    if (!result.degraded) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(hash, result);
    }
    return result;
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const result = { buffer, ms: Date.now() - t0, cached: false, engine: used,
    voice: used === 'qwen' ? cfg.qwen?.voice : stats?.chpVoice || stats?.httpVoice, streamed, ...(used === 'qwen' ? { stats } : {}) };
  cache.set(hash, result);
  return result;
}

/** 引擎体检：给设置页那颗「试听」按钮用 */
async function probe(cfg) {
  const t0 = Date.now();
  try {
    const buf = await synthesize('让我试试这个声音。', cfg);
    return { ok: true, ms: Date.now() - t0, bytes: buf.buffer.length, engine: buf.engine, voice: buf.voice };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

const { downloadQwen, downloadState, cancelDownload, qwenReady } = qwenDownload;

function qwenVoices(q = {}) {
  if (!qwenReady(q.dir) || !findSpeechRuntime()) return [];
  return voiceFiles.SPEAKERS;
}
function clearSpeechCache() { cache.clear(); }
function reset() { clearSpeechCache(); }

module.exports = {
  synthesize, probe, voiceIdentity,
  systemVoices, pickSystemVoice,
  downloadQwen: (...args) => { require('./runtime-capabilities').requireQwen(); return downloadQwen(...args); }, downloadState, cancelDownload, qwenReady, QWEN_FILES, qwenVoices,
  findSpeechRuntime, reset, clearSpeechCache, prewarm,
  createSystemTTS,
  runtimeStatus: qwenRuntime.status, cancel: () => { qwenRuntime.cancel(); chp.cancel(); custom.cancel(); }, shutdown: () => { qwenRuntime.close(); chp.cancel(); custom.cancel(); },
  deleteQwen: qwenDownload.deleteQwen,
  checkQwen: qwenDownload.checkQwen,
};
