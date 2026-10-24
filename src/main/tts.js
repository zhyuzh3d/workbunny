'use strict';
/**
 * 语音合成：A1X 掌机上的 Qwen3-TTS（8020，VoiceDesign）。
 * 一次返回整段 WAV 的 Buffer，交给渲染层用 WebAudio 解码播放 —— 顺便拿到波形做真实口型。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const agent = new http.Agent({ keepAlive: true, maxSockets: 3 });
const cache = new Map(); // hash -> Buffer
const CACHE_MAX = 40;
// 熔断：远程 TTS 刚失败过，就别每句话都先等一次超时 —— 直接走系统语音，
// 否则每句白等一两秒，对话节奏会明显发木。60 秒后再试一次远程。
let remoteDownUntil = 0;
const REMOTE_RETRY_MS = 60000;

function post(baseURL, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(baseURL.replace(/\/$/, '') + '/v1/audio/speech');
    } catch (e) {
      return reject(new Error('TTS baseURL 非法'));
    }
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        agent,
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
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error('TTS 超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 兜底嗓子：A1X 那台机器不在线（EHOSTUNREACH / 没授权本地网络 / 关机）时，
 * 用 macOS 自带语音念。宁可音色不是设计好的那个，也绝不能一声不吭。
 *
 * 关键：输出参数必须是 LEI16@24000（24k 单声道 16bit），
 * 因为渲染层按 24k/16bit 算时长和波形做口型，格式不一致嘴就对不上。
 */
function systemTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `wb-tts-${process.pid}-${Date.now()}.wav`);
    const args = ['-r', '200', '-o', out, '--data-format=LEI16@24000'];
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

/** 有没有这个系统音色（一次性探测） */
let voiceListCache = null;
function hasSystemVoice(name) {
  if (!name) return false;
  if (voiceListCache) return voiceListCache.has(name.toLowerCase());
  try {
    const out = require('child_process').execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' });
    voiceListCache = new Set(
      out.split('\n').map((l) => l.split(/\s{2,}/)[0].trim().toLowerCase()).filter(Boolean)
    );
  } catch {
    voiceListCache = new Set();
  }
  return voiceListCache.has(name.toLowerCase());
}

/**
 * @param {string} text
 * @param {object} cfg  config.tts
 * @returns {Promise<{buffer:Buffer,ms:number,cached:boolean,fallback?:boolean}>}
 */
async function synthesize(text, cfg) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('空文本');
  if (!cfg || !cfg.enabled) throw new Error('TTS 已关闭');

  const hash = crypto
    .createHash('sha1')
    .update([clean, cfg.model, cfg.instructions, cfg.seed, cfg.speed, cfg.language].join('\u0001'))
    .digest('hex');

  if (cache.has(hash)) return { buffer: cache.get(hash), ms: 0, cached: true };

  const t0 = Date.now();
  let buffer = null;
  let lastErr = null;

  // 首选：A1X 上设计好的那个声音（熔断期内跳过）
  if (cfg.apiKey && cfg.baseURL && Date.now() > remoteDownUntil) {
    try {
      buffer = await post(
        cfg.baseURL,
        cfg.apiKey,
        {
          model: cfg.model,
          input: clean,
          instructions: cfg.instructions,
          seed: cfg.seed,
          speed: cfg.speed,
          language: cfg.language,
          response_format: cfg.format || 'wav',
        },
        cfg.timeoutMs || 12000
      );
    } catch (e) {
      lastErr = e;
      remoteDownUntil = Date.now() + REMOTE_RETRY_MS;
    }
  } else if (cfg.apiKey && cfg.baseURL) {
    lastErr = new Error('远程 TTS 刚失败过，冷却中');
  } else {
    lastErr = new Error('没配远程 TTS');
  }

  // 兜底：系统语音。不能让"她不说话"成为一个可能的状态。
  if (!buffer) {
    const voice = hasSystemVoice(cfg.fallbackVoice) ? cfg.fallbackVoice : '';
    try {
      buffer = await systemTTS(clean, voice);
      cache.set(hash, buffer);
      return { buffer, ms: Date.now() - t0, cached: false, fallback: true, reason: lastErr && lastErr.message };
    } catch (e) {
      throw new Error((lastErr ? lastErr.message + ' / ' : '') + '系统语音也失败：' + e.message);
    }
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(hash, buffer);
  return { buffer, ms: Date.now() - t0, cached: false };
}

async function probe(cfg) {
  const t0 = Date.now();
  try {
    const buf = await synthesize('测试', cfg);
    return { ok: true, ms: Date.now() - t0, bytes: buf.buffer.length };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

module.exports = { synthesize, probe };
