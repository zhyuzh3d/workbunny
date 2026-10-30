'use strict';
const P = require('./tts-http-profile');
const { wav } = require('./qwen-runtime');
const { validateWav } = require('./chp-tts');
const active = new Set();
async function request(address, { headers, body, method = 'POST', signal, timeoutMs = 90000, audio = false } = {}) {
  const u = P.url(address), controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
  active.add(controller); signal?.addEventListener('abort', abort, { once: true });
  const total = setTimeout(() => controller.abort(), timeoutMs);
  let first = audio ? setTimeout(() => controller.abort(), 30000) : null;
  const dispose = () => { controller.abort(); clearTimeout(total); clearTimeout(first); active.delete(controller); signal?.removeEventListener('abort', abort); };
  try {
    const h = { ...headers }; for (const v of Object.values(h)) if (typeof v !== 'string' || /[\r\n]/.test(v)) throw new Error('请求头值无效');
    const fetcher = process.versions.electron ? require('electron').net.fetch : fetch;
    const r = await fetcher(u.href, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...h },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: controller.signal });
    if (!r.ok) throw new Error(`语音接口返回 HTTP ${r.status}，请检查凭据、音色、资源和额度`);
    return { response: r, dispose, async *chunks() {
      let size = 0;
      for await (const bytes of r.body) { size += bytes.length; if (size > 32 * 1024 ** 2) throw new Error('语音响应超过上限'); yield Buffer.from(bytes); }
    }, gotAudio() { clearTimeout(first); first = null; } };
  } catch (e) {
    clearTimeout(total); clearTimeout(first); active.delete(controller); signal?.removeEventListener('abort', abort);
    if (controller.signal.aborted) throw Object.assign(new Error(signal?.aborted ? '语音已取消' : '语音接口超时'), { name: signal?.aborted ? 'AbortError' : 'Error' });
    throw new Error(/^语音接口返回|请求头/.test(e.message) ? e.message : '无法连接语音接口，请检查地址与网络');
  }
}
async function synthesize(text, cfg, { signal } = {}) {
  const h = cfg.http || {}, p = P.validate(h.profile), started = Date.now();
  if (!text || Array.from(text).length > 2000) throw new Error('语音文本须为 1 至 2000 字');
  const params = { ...h.params, text, requestId: require('crypto').randomUUID() };
  const headers = P.bind(p.headers || {}, params, h.secrets || {}), body = P.bind(p.body || {}, params, h.secrets || {});
  const wire = await request(p.url, { headers, body, signal, audio: true });
  const parts = []; let decoded = 0, finished = false;
  const spec = p.response;
  function bytes(value) {
    if (typeof value !== 'string' || !value.length) return;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('语音 Base64 数据无效');
    const b = Buffer.from(value, 'base64'); decoded += b.length;
    if (decoded > 48000 * 60 + 4096) throw new Error('语音超过 60 秒上限');
    if (b.length) { parts.push(b); wire.gotAudio(); }
  }
  function object(raw) {
    let value; try { value = JSON.parse(raw); } catch { throw new Error('语音接口 JSON 格式无效'); }
    if (spec.statusPath) {
      const code = P.get(value, spec.statusPath);
      if (spec.doneCodes.includes(code)) finished = true;
      else if (!spec.chunkCodes.includes(code)) throw new Error('语音服务拒绝合成，请检查资源、音色权限或额度');
    }
    const data = P.get(value, spec.audioPath);
    if (data !== null && data !== undefined && data !== '') { if (finished) throw new Error('结束事件不应包含音频'); bytes(data); }
  }
  try {
    let buf = '', sseData = []; const decoder = new TextDecoder('utf-8', { fatal: true });
    const line = l => {
      l = l.replace(/\r$/, '');
      if (spec.framing !== 'sse') { if (l.trim()) object(l); return; }
      if (!l) { if (sseData.length) { object(sseData.join('\n')); sseData = []; } }
      else if (l.startsWith('data:')) sseData.push(l.slice(5).replace(/^ /, ''));
    };
    for await (const b of wire.chunks()) {
      if (spec.framing === 'binary') { decoded += b.length; if (decoded > 48000 * 60 + 4096) throw new Error('语音超过上限'); parts.push(b); wire.gotAudio(); }
      else { buf += decoder.decode(b, { stream: true }); if (buf.length > 8 * 1024 ** 2) throw new Error('语音事件过大');
        if (spec.framing !== 'json') { let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } } }
    }
    if (spec.framing !== 'binary') { buf += decoder.decode(); if (spec.framing === 'json') object(buf); else { if (buf) line(buf); if (sseData.length) object(sseData.join('\n')); } }
    if (signal?.aborted) throw Object.assign(new Error('语音已取消'), { name: 'AbortError' });
    if (spec.statusPath && spec.doneCodes.length && !finished && !spec.allowEOF) throw new Error('语音接口提前结束，未收到完成事件');
    const audio = Buffer.concat(parts); if (!audio.length) throw new Error('语音接口未返回音频');
    const buffer = spec.audio.format === 'wav' ? validateWav(audio) : (audio.length % 2 ? (() => { throw new Error('PCM 数据不完整'); })() : wav(audio));
    return { buffer, voice: params.voice, engine: 'http', ms: Date.now() - started };
  } finally { wire.dispose(); }
}
async function catalog(cfg, kind) {
  const h = cfg.http || {}, p = P.validate(h.profile), c = p.catalogs?.[kind];
  if (!c) return { items: [], manual: true };
  const wire = await request(c.url, { method: c.method || 'GET', headers: P.bind(c.headers || {}, h.params || {}, h.secrets || {}),
    body: c.body ? P.bind(c.body, h.params || {}, h.secrets || {}) : undefined, timeoutMs: 15000 });
  try {
    const b = []; for await (const part of wire.chunks()) b.push(part);
    const data = P.get(JSON.parse(Buffer.concat(b).toString()), c.itemsPath);
    if (!Array.isArray(data)) throw new Error('目录不是列表');
    return { items: data.slice(0, 500).flatMap(v => { const id = P.get(v, c.idPath); return typeof id === 'string' && id.length <= 200 ? [{ id, label: String(P.get(v, c.labelPath) || id).slice(0, 200) }] : []; }) };
  } catch { throw new Error('无法获取目录，可手工填写模型或音色 ID'); }
  finally { wire.dispose(); }
}
module.exports = { synthesize, catalog, cancel() { for (const c of active) c.abort(); } };
