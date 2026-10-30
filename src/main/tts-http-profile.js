'use strict';
const crypto = require('crypto');
const PARAMS = new Set(['text', 'voice', 'model', 'resourceId', 'language', 'speed', 'requestId']);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function safeTree(value, depth = 0) {
  if (depth > 12) throw new Error('配置嵌套超过 12 层');
  if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('配置包含控制字符');
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (forbidden.has(k)) throw new Error('配置包含不允许的字段');
    safeTree(v, depth + 1);
  }
}
function url(value) {
  let u; try { u = new URL(value); } catch { throw new Error('请填写完整的 HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('地址不允许携带凭据或片段');
  for (const k of u.searchParams.keys()) if (/key|token|secret|password|auth/i.test(k)) throw new Error('凭据请填在密钥栏，不放入地址');
  return u;
}
function path(value, optional = false) {
  if (optional && value === undefined) return;
  if (!Array.isArray(value) || value.length > 12 || value.some(k => !(typeof k === 'string' || Number.isInteger(k)) || forbidden.has(String(k)))) throw new Error('字段路径须为键名或数组位置');
}
function validate(profile, { allowEmptyURL = false } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Buffer.byteLength(JSON.stringify(profile)) > 128 * 1024) throw new Error('语音配置格式错误或超过 128KiB');
  safeTree(profile);
  if (profile.format !== 'workbunny-tts-http/v1') throw new Error('不支持的语音配置版本');
  if (!(allowEmptyURL && !profile.url)) url(profile.url);
  if (!['binary', 'json', 'jsonl', 'sse'].includes(profile.response?.framing)) throw new Error('返回方式须为 binary/json/jsonl/sse');
  const a = profile.response.audio;
  if (!a || !['binary', 'base64'].includes(a.encoding) || !['pcm16le', 'wav'].includes(a.format) || a.sampleRate !== 24000 || a.channels !== 1) throw new Error('音频须为 24kHz 单声道 PCM16 或 WAV');
  if (profile.response.framing !== 'binary') {
    path(profile.response.audioPath); path(profile.response.statusPath, true);
    if (profile.response.statusPath && (!Array.isArray(profile.response.chunkCodes) || !Array.isArray(profile.response.doneCodes))) throw new Error('请配置分片和结束状态码');
  }
  function checkHeaders(input) {
  const headers = Object.entries(input || {});
  if (headers.length > 32) throw new Error('请求头超过 32 项');
  const seen = new Set();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (!/^[a-z0-9-]+$/i.test(key) || seen.has(lower) || /^(host|cookie|content-length|connection|transfer-encoding)$/i.test(key)) throw new Error('不允许或重复的请求头');
    if (typeof value === 'string' && /[\r\n]/.test(value)) throw new Error('请求头包含换行');
    seen.add(lower);
  }
  }
  checkHeaders(profile.headers);
  function bindings(v) {
    if (!v || typeof v !== 'object') return;
    if ('$param' in v || '$secret' in v) {
      if (Object.keys(v).length !== 1 || ('$param' in v ? !PARAMS.has(v.$param) : !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(v.$secret))) throw new Error('无效的参数或密钥绑定');
    } else Object.values(v).forEach(bindings);
  }
  bindings(profile);
  if (!JSON.stringify(profile.body || {}).includes('"$param":"text"')) throw new Error('请求正文必须绑定 text 参数');
  function noLiteralCredentials(v) {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/^(api[_-]?key|access[_-]?key|token|access[_-]?token|secret|password|authorization)$/i.test(k) && typeof x === 'string' && x) throw new Error('正文凭据须使用 $secret 引用，不能直接填写');
      noLiteralCredentials(x);
    }
  }
  noLiteralCredentials(profile.body);
  for (const c of Object.values(profile.catalogs || {})) noLiteralCredentials(c.body);
  for (const c of Object.values(profile.catalogs || {})) { url(c.url); checkHeaders(c.headers); path(c.itemsPath); path(c.idPath); path(c.labelPath, true); if (c.method && !['GET', 'POST'].includes(c.method)) throw new Error('目录仅支持 GET/POST'); }
  return profile;
}
function bind(value, params, secrets) {
  if (!value || typeof value !== 'object') return value;
  if ('$param' in value || '$secret' in value) {
    const result = '$param' in value ? params[value.$param] : secrets[value.$secret];
    if (result === undefined || result === '') throw new Error('请填写参数或凭据：' + (value.$param || value.$secret));
    return result;
  }
  return Array.isArray(value) ? value.map(v => bind(v, params, secrets)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, params, secrets)]));
}
function get(value, keys) { return keys?.reduce((o, k) => o && Object.hasOwn(o, k) ? o[k] : undefined, value); }
function template(kind = 'jsonl') {
  return { format: 'workbunny-tts-http/v1', url: '', headers: kind === 'binary' ? { Authorization: { $secret: 'authorization' } } : {
    'X-Api-Key': { $secret: 'apiKey' }, 'X-Api-Resource-Id': { $param: 'resourceId' }, 'X-Api-Request-Id': { $param: 'requestId' } },
  body: kind === 'binary' ? { input: { $param: 'text' }, model: { $param: 'model' }, voice: { $param: 'voice' }, response_format: 'wav' } : {
    req_params: { text: { $param: 'text' }, speaker: { $param: 'voice' }, audio_params: { format: 'pcm', sample_rate: 24000 } } },
  response: { framing: kind, ...(kind === 'binary' ? {} : { audioPath: ['data'], statusPath: ['code'], chunkCodes: [0], doneCodes: [20000000] }),
    audio: { encoding: kind === 'binary' ? 'binary' : 'base64', format: kind === 'binary' ? 'wav' : 'pcm16le', sampleRate: 24000, channels: 1 } } };
}
function publicHTTP(value = {}) {
  const p = structuredClone(value); const secrets = p.secrets || {};
  p.hasSecrets = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v])); delete p.secrets;
  // Imported literal headers are credentials too. Rebind at save, never echo.
  for (const headers of [p.profile?.headers, ...Object.values(p.profile?.catalogs || {}).map(c => c.headers)]) if (headers) for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') headers[k] = { $secret: 'header_' + k.replace(/-/g, '_') };
  return p;
}
function normalize(value, prior = {}) {
  const out = structuredClone(value); validate(out.profile, { allowEmptyURL: true });
  out.secrets = { ...prior.secrets, ...out.secrets };
  delete out.hasSecrets;
  for (const headers of [out.profile.headers, ...Object.values(out.profile.catalogs || {}).map(c => c.headers)]) for (const [k, v] of Object.entries(headers || {})) if (typeof v === 'string') {
    const name = 'header_' + k.replace(/-/g, '_'); out.secrets[name] = v; out.profile.headers[k] = { $secret: name };
  }
  return out;
}
function identity(value) { return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex'); }
module.exports = { validate, bind, get, url, template, publicHTTP, normalize, identity };
