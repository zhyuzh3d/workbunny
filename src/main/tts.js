'use strict';
/**
 * 语音合成。三档引擎，默认第一档：
 *
 *   system（默认）macOS 自带 /usr/bin/say。离线、零配置、立刻出声。
 *   qwen          本地 Qwen3-TTS 1.7B 的 GGUF 量化版，用 llama-tts 跑。音色更像她，还能克隆。
 *   remote        主人自己的 TTS 服务（比如局域网里那台 A1X 上的 Qwen3-TTS）。
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
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const agent = new http.Agent({ keepAlive: true, maxSockets: 3 });
const cache = new Map(); // hash -> Buffer
const CACHE_MAX = 40;
// 熔断：远程引擎刚失败过就别每句都等超时，直接走系统语音；60 秒后再试一次
let remoteDownUntil = 0;
const REMOTE_RETRY_MS = 60000;

/* ═══════════ 1. 系统语音 ═══════════ */
function systemTTS(text, voice, rate) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `wb-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    const args = ['-r', String(rate || 200), '-o', out, '--data-format=LEI16@24000'];
    if (voice) args.push('-v', voice);
    args.push(text);
    execFile('/usr/bin/say', args, { timeout: 20000 }, (err) => {
      if (err) return reject(err);
      fs.readFile(out, (e, buf) => {
        fs.unlink(out, () => {});
        if (e) return reject(e);
        if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return reject(new Error('系统语音输出异常'));
        resolve(buf);
      });
    });
  });
}

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
  zhVoices = zh.length ? zh : all;
  zhVoices.sort((a, b) => {
    const ia = ZH_PREFERRED.indexOf(a.id), ib = ZH_PREFERRED.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return zhVoices;
}
/** 挑一个本机真有的音色：指定了却没有，就顺位往下，绝不让 say 因为音色名报错 */
function pickSystemVoice(want) {
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

/* ═══════════ 2. 本地 Qwen（GGUF，llama-tts） ═══════════ */
/* 两个文件必须成对：主模型 + 音频投影（mmproj），少一个都加载不起来。 */
const QWEN_FILES = [
  {
    name: 'Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf',
    bytes: 1030000000,
    url: 'https://huggingface.co/NANI-Nithin/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/main/Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf',
  },
  {
    name: 'mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf',
    bytes: 494000000,
    url: 'https://huggingface.co/NANI-Nithin/Qwen3-TTS-12Hz-1.7B-Base-GGUF/resolve/main/mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf',
  },
];
/* llama-tts 是 llama.cpp 里的 TTS 前端。装了就能用；没装就明说，别假装成功。 */
function findLlamaTTS() {
  const tried = [];
  for (const p of [
    path.join(__dirname, '..', '..', 'bin', 'llama-tts'),
    '/opt/homebrew/bin/llama-tts',
    '/usr/local/bin/llama-tts',
  ]) {
    tried.push(p);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function qwenTTS(text, q, tmpTag) {
  return new Promise((resolve, reject) => {
    const bin = findLlamaTTS();
    if (!bin) return reject(new Error('没找到 llama-tts（先安装 llama.cpp 再回来）'));
    const dir = q && q.dir;
    if (!dir || !q.ready) return reject(new Error('本地模型还没下载完'));
    const main = QWEN_FILES[0].name, mm = QWEN_FILES[1].name;
    const out = path.join(os.tmpdir(), `wb-qwen-${tmpTag}.wav`);
    const args = ['-m', path.join(dir, main), '-mm', path.join(dir, mm),
      '-p', text, '--tts-lang', 'zh', '-o', out];
    // 主人上传过参考音色 → 走克隆
    if (q.refFile && fs.existsSync(q.refFile)) args.push('--tts-ref', q.refFile);
    execFile(bin, args, { timeout: 120000, maxBuffer: 1 << 22 }, (err) => {
      if (err) return reject(err);
      fs.readFile(out, (e, buf) => {
        fs.unlink(out, () => {});
        if (e) return reject(e);
        if (buf.slice(0, 4).toString('ascii') !== 'RIFF') return reject(new Error('本地合成没出 WAV'));
        resolve(buf);
      });
    });
  });
}

/* ═══════════ 3. 远程 API ═══════════ */
function post(baseURL, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(baseURL.replace(/\/$/, '') + '/v1/audio/speech');
    } catch (e) {
      return reject(new Error('TTS baseURL 非法'));
    }
    const payload = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        agent: u.protocol === 'https:' ? undefined : agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer ' + apiKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            return reject(new Error(`TTS ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
          }
          if (buf.slice(0, 4).toString('ascii') !== 'RIFF') {
            return reject(new Error('TTS 返回的不是 WAV：' + buf.toString('utf8').slice(0, 120)));
          }
          resolve(buf);
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs || 12000, () => req.destroy(new Error('TTS 超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ═══════════ 合成入口 ═══════════ */
/**
 * @param {string} text
 * @param {object} cfg  config.tts
 * @returns {Promise<{buffer:Buffer,ms:number,cached:boolean,engine?:string,voice?:string,reason?:string}>}
 */
async function synthesize(text, cfg) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('空文本');
  if (!cfg || !cfg.enabled) throw new Error('发声已关闭');

  const engine = cfg.engine || 'system';
  const hash = crypto
    .createHash('sha1')
    .update([clean, engine, cfg.voice, cfg.rate,
      cfg.qwen && cfg.qwen.voice, cfg.qwen && cfg.qwen.refFile,
      cfg.model, cfg.instructions, cfg.seed, cfg.speed, cfg.language].join('\u0001'))
    .digest('hex');
  if (cache.has(hash)) return { buffer: cache.get(hash), ms: 0, cached: true };

  const t0 = Date.now();
  const tag = `${process.pid}-${Date.now()}`;
  let lastErr = null;
  let buffer = null;
  let used = 'system';

  // ① 主人指定的引擎（系统引擎本身就是兜底，不用再包一层）
  if (engine === 'qwen') {
    try {
      buffer = await qwenTTS(clean, cfg.qwen, tag);
      used = 'qwen';
    } catch (e) { lastErr = e; }
  } else if (engine === 'remote') {
    if (cfg.apiKey && cfg.baseURL && Date.now() > remoteDownUntil) {
      try {
        buffer = await post(cfg.baseURL, cfg.apiKey, {
          model: cfg.model, input: clean, instructions: cfg.instructions,
          seed: cfg.seed, speed: cfg.speed, language: cfg.language,
          response_format: cfg.format || 'wav',
        }, cfg.timeoutMs || 12000);
        used = 'remote';
      } catch (e) {
        lastErr = e;
        remoteDownUntil = Date.now() + REMOTE_RETRY_MS;
      }
    } else {
      lastErr = new Error(cfg.apiKey && cfg.baseURL ? '远程 TTS 刚失败过，冷却中' : '没配远程 TTS');
    }
  }

  // ② 兜底：系统语音。绝不让"她不说话"成为一个可能的状态。
  if (!buffer) {
    const voice = engine === 'system' ? pickSystemVoice(cfg.voice) : pickSystemVoice(cfg.fallbackVoice || cfg.voice);
    try {
      buffer = await systemTTS(clean, voice, cfg.rate);
    } catch (e) {
      throw new Error((lastErr ? lastErr.message + ' / ' : '') + '系统语音也失败：' + e.message);
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(hash, buffer);
    return {
      buffer, ms: Date.now() - t0, cached: false, engine: 'system', voice,
      degraded: engine !== 'system',
      reason: lastErr && lastErr.message,
    };
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(hash, buffer);
  return { buffer, ms: Date.now() - t0, cached: false, engine: used };
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

/* ═══════════ 下载本地大模型 ═══════════
 * 1.4GB 的东西，必须能被看见进度、也能被掐断 —— 主人点错了不该干等半小时。 */
const dlState = { running: false, done: 0, total: 0, file: '', bytes: 0, err: '', cancel: false };

function downloadState() {
  return { ...dlState, total: QWEN_FILES.reduce((s, f) => s + f.bytes, 0) };
}
function cancelDownload() {
  if (dlState.running) dlState.cancel = true;
}

function getFile(url, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'workbaby' } }, (res) => {
      // HF 的 resolve 会 302 到 CDN，跟一次
      if (res.statusCode === 302 || res.statusCode === 301) {
        res.resume();
        return getFile(res.headers.location, dest, onBytes).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败 ${res.statusCode}`));
      }
      const tmp = dest + '.part';
      const fd = fs.openSync(tmp, 'w');
      let got = 0;
      res.on('data', (c) => {
        if (dlState.cancel) { try { res.destroy(); } catch {} return; }
        fs.writeSync(fd, c);
        got += c.length;
        dlState.bytes += c.length;
        if (onBytes) onBytes(c.length);
      });
      res.on('end', () => {
        fs.closeSync(fd);
        if (dlState.cancel) { try { fs.unlinkSync(tmp); } catch {} return reject(new Error('已取消')); }
        fs.renameSync(tmp, dest);
        resolve(dest);
      });
      res.on('error', (e) => { try { fs.closeSync(fd); } catch {} reject(e); });
    });
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

async function downloadQwen(dir) {
  if (dlState.running) return { started: false, reason: '正在下载中' };
  dlState.running = true;
  dlState.cancel = false;
  dlState.done = 0;
  dlState.bytes = 0;
  dlState.err = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    dlState.running = false;
    dlState.err = e.message;
    return { started: false, reason: e.message };
  }
  (async () => {
    try {
      for (const f of QWEN_FILES) {
        dlState.file = f.name;
        await getFile(f.url, path.join(dir, f.name));
        dlState.done++;
      }
      dlState.file = '';
    } catch (e) {
      dlState.err = e.message;
    } finally {
      dlState.running = false;
    }
  })();
  return { started: true };
}

/** 本地模型齐了没：两个文件都在，才算就绪 */
function qwenReady(dir) {
  if (!dir) return false;
  try {
    return QWEN_FILES.every((f) => {
      const st = fs.statSync(path.join(dir, f.name));
      return st.isFile() && st.size > 100 * 1024 * 1024;
    });
  } catch {
    return false;
  }
}

/* 内置音色：llama-tts 支持具名说话人，这里列几个顺嘴的；主人还能传自己的参考音频 */
const QWEN_VOICES = [
  { id: 'default', label: '默认（她自己的声音）' },
  { id: 'clone', label: '克隆（用我上传的音色）' },
];

module.exports = {
  synthesize, probe,
  systemVoices, pickSystemVoice,
  downloadQwen, downloadState, cancelDownload, qwenReady, QWEN_FILES, QWEN_VOICES,
  findLlamaTTS,
};
