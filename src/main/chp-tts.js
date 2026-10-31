'use strict';
// CHP chp/2, pinned contract: haminn-chp 102364862d2ba0be8b10ac8a89504c4aaefa6975.
// GET discovers capabilities; POST sends text unchanged and the key in the body.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const active = new Set();
const catalogs = new Map();
const abortError = () => Object.assign(new Error('语音请求已停止'), { name: 'AbortError' });
async function electronRequest(url, { key, body, timeoutMs = 10000, signal } = {}) {
  const controller = new AbortController();
  const operation = { destroy: reason => controller.abort(reason) };
  const abort = () => controller.abort(abortError());
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', abort, { once: true }); active.add(operation);
  const timer = setTimeout(() => controller.abort(new Error('CHP 请求超时，请检查地址与服务状态')), timeoutMs);
  try {
    const response = await require('electron').net.fetch(url.href, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: body === undefined ? { Accept: 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }
        : { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parts = []; let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > (body === undefined ? 3 : 32) * 1024 * 1024) { controller.abort(); throw new Error('CHP 返回内容过大'); }
      parts.push(Buffer.from(part));
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), buffer: Buffer.concat(parts) };
  } catch (e) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    if (/CHP/.test(e.message)) throw e;
    throw new Error(/ERR_NETWORK_ACCESS_DENIED|ERR_ADDRESS_UNREACHABLE/.test(e.message)
      ? 'CHP 网络不可达，请检查 macOS 本地网络权限' : '无法连接 CHP，请检查地址与局域网');
  } finally { clearTimeout(timer); active.delete(operation); signal?.removeEventListener('abort', abort); }
}
function address(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 CHP 地址（http:// 或 https://）'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search)
    throw new Error('CHP 地址只支持 HTTP/HTTPS，访问密钥请填在密钥栏');
  return u;
}
function identity(cfg) { return address(cfg.baseURL).href + '\0' + crypto.createHash('sha256').update(cfg.apiKey || '').digest('hex'); }
function failure(status, data) {
  const code = data?.error?.code || data?.error;
  return new Error(status === 401 ? 'CHP 访问密钥不正确' : status === 403 ? '此密钥没有语音权限' : status === 409 || code === 'no_engine' ? 'CHP 语音引擎未就绪，请检查服务端配置' : code === 'unsupported_voice' ? '音色已变化，请重新获取模型与音色' : `CHP 请求失败（HTTP ${status}）`);
}
function request(url, { key, body, timeoutMs = 10000, signal } = {}) {
  // Use the application's native network stack in Electron, including its OS
  // permission handling. Node transport remains available for contract tests.
  if (process.versions.electron) return electronRequest(url, { key, body, timeoutMs, signal });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined ? { Accept: 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }
      : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'audio/wav' };
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: payload === undefined ? 'GET' : 'POST', headers }, res => {
      const parts = []; let size = 0;
      res.on('data', part => { size += part.length; if (size > (payload ? 32 * 1024 * 1024 : 3 * 1024 * 1024)) req.destroy(new Error('CHP 返回内容过大')); else parts.push(part); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(parts) }));
      res.on('aborted', () => reject(new Error('CHP 音频连接中断，请检查服务端引擎')));
      res.on('error', () => reject(new Error('CHP 响应读取失败')));
    });
    active.add(req);
    const abort = () => req.destroy(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => req.destroy(new Error('CHP 请求超时，请检查地址与服务状态')), timeoutMs);
    req.on('close', () => { clearTimeout(timer); active.delete(req); signal?.removeEventListener('abort', abort); });
    req.on('error', error => reject(error.name === 'AbortError' || /CHP/.test(error.message) ? error : Object.assign(new Error(
      error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH' ? 'CHP 网络不可达，请检查 macOS 本地网络权限' :
      error.code === 'ECONNREFUSED' ? 'CHP 端口未开放，请检查服务地址' : '无法连接 CHP，请检查地址与局域网'), { code: error.code })));
    req.end(payload);
  });
}
function json(response) { try { return JSON.parse(response.buffer.toString('utf8')); } catch { return null; } }
function parse(doc, infoURL) {
  if (doc?.spec !== 'chp/2') throw new Error('这个地址不是 CHP 服务');
  const speech = doc.speech;
  if (!speech) throw new Error('此 CHP 版本尚未提供语音能力，请更新服务端');
  const rule = speech.rules?.find(r => r.signature === 'txt-2-sph' && r.input === 'txt-2-sph/v1');
  if (!rule) throw new Error('此密钥没有可用的 TTS 能力');
  const schema = speech.input_schemas?.[rule.input];
  if (!schema?.properties?.text || !schema.properties.voice) throw new Error('CHP 语音请求格式不兼容');
  let endpoint; try { endpoint = new URL(doc.endpoints?.speech, infoURL); } catch { throw new Error('CHP 没有提供有效的语音地址'); }
  if (!doc.endpoints?.speech || endpoint.origin !== infoURL.origin || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new Error('CHP 语音地址须与信息接口位于同一服务');
  const abilities = Array.isArray(speech.abilities) ? speech.abilities : [];
  // chp/2 speech declares one loaded engine, with no client-side model selector.
  if (abilities.length !== 1) throw new Error('当前 CHP 协议需要一个明确的服务端语音模型');
  const a = abilities[0];
  if (!a.ready) throw new Error('CHP 语音模型未就绪，请检查服务端引擎与音色配置');
  if (a.audio?.sample_rate !== 24000 || a.audio?.channels !== 1 || !a.audio.formats?.includes('wav'))
    throw new Error('CHP 音频需支持 24 kHz 单声道 WAV');
  const seen = new Set(), voices = [];
  for (const v of Array.isArray(a.voices) ? a.voices : []) {
    if (typeof v?.id !== 'string' || !v.id.trim() || v.id.length > 200 || seen.has(v.id)) continue;
    voices.push({ id: v.id, label: typeof v.label === 'string' ? v.label.slice(0, 200) : v.id }); seen.add(v.id);
  }
  if (!voices.length) throw new Error('CHP 没有提供可用音色');
  return { infoURL: infoURL.href, endpoint: endpoint.href, at: Date.now(), version: String(doc.plugin?.version || ''),
    model: String(a.name || 'TTS').slice(0, 200), file: String(a.files?.engine || '').slice(0, 300), voices,
    maxText: Math.min(2000, Number(schema.properties.text.maxLength) || 2000) };
}
async function discover(cfg, { timeoutMs } = {}) {
  const original = address(cfg.baseURL), candidates = [original];
  if (original.pathname === '/') candidates.push(new URL('/chp/info', original));
  for (let i = 0; i < candidates.length; i++) {
    const response = await request(candidates[i], { key: cfg.apiKey || '', ...(timeoutMs ? { timeoutMs } : {}) }), doc = json(response);
    // A CHP 401 proves the address; do not hide a wrong key behind another URL attempt.
    if (doc?.spec === 'chp/2') {
      if (response.status !== 200) throw failure(response.status, doc);
      const catalog = parse(doc, candidates[i]);
      if (catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(identity(cfg), catalog); return structuredClone(catalog);
    }
    if (i === candidates.length - 1) throw new Error('这个地址不是 CHP 信息接口，请检查地址或安装 CHP');
  }
}
function cached(cfg) { try { const c = catalogs.get(identity(cfg)); return c ? structuredClone(c) : null; } catch { return null; } }
function validateWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('CHP 没有返回有效 WAV 音频');
  let fmt = false, audio = false;
  for (let p = 12; p + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', p, p + 4), size = buffer.readUInt32LE(p + 4), end = p + 8 + size;
    if (end > buffer.length) throw new Error('CHP WAV 音频不完整');
    if (id === 'fmt ') { fmt = size >= 16 && buffer.readUInt16LE(p + 8) === 1 && buffer.readUInt16LE(p + 10) === 1 && buffer.readUInt32LE(p + 12) === 24000 && buffer.readUInt16LE(p + 22) === 16; }
    if (id === 'data') audio = size > 0 && size % 2 === 0;
    p = end + (size % 2);
  }
  if (!fmt || !audio) throw new Error('CHP 音频需为 24 kHz 单声道 16 位 PCM WAV');
  return buffer;
}
async function synthesize(text, cfg, options = {}) {
  const c = cached(cfg) || await discover(cfg);
  const voice = cfg.chp?.voice || c.voices[0].id;
  if (!c.voices.some(v => v.id === voice)) throw new Error('所选 CHP 音色已不可用，请重新获取音色');
  if (Array.from(text).length > c.maxText) throw new Error('文本超过此 CHP 服务的单次语音上限');
  const response = await request(new URL(c.endpoint), { signal: options.signal, timeoutMs: Math.min(120000, Math.max(60000, cfg.timeoutMs || 60000)),
    body: { text, voice, stream: false, response_format: 'wav', chp_params: { password: cfg.apiKey || '' } } });
  if (response.status !== 200) { catalogs.delete(identity(cfg)); throw failure(response.status, json(response)); }
  if (!/^audio\/wav(?:;|$)/i.test(response.headers['content-type'] || '')) throw new Error('CHP 返回的音频类型不是 WAV');
  return { buffer: validateWav(response.buffer), voice };
}
function cancel() { for (const req of active) req.destroy(abortError()); }
module.exports = { discover, cached, synthesize, cancel, parse, validateWav };
