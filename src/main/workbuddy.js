'use strict';
// WorkBuddy's authenticated local broker forwards requests using the active account.
// No account token is copied into workbunny's configuration or renderer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

function openApplication() {
  return new Promise((resolve, reject) => execFile('/usr/bin/open', ['-b', 'com.tencent.workbuddy.mac'], { timeout: 10000 }, error =>
    error ? reject(new Error('未找到 WorkBuddy，请先安装并登录 WorkBuddy。')) : resolve()));
}

function discovery() {
  const file = path.join(os.homedir(), '.workbuddy', 'wbipc', 'endpoint.json');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('不可信的连接配置');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof d.endpoint !== 'string' || typeof d.ticket !== 'string' || !d.ticket) throw new Error('连接配置不完整');
    return d;
  } catch {
    throw new Error('请先打开 WorkBuddy 并登录账号，再重试连接。');
  }
}

function proof(ticket, side, endpoint, clientNonce, serverNonce) {
  const parts = [];
  for (const value of [side === 'server' ? 'wbipc-s' : 'wbipc-c', '1', endpoint, clientNonce, serverNonce]) {
    const b = Buffer.from(value, 'utf8'), len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  }
  return crypto.createHmac('sha256', ticket).update(Buffer.concat(parts)).digest('base64url');
}

function request(params, { signal, timeoutMs = 55000 } = {}) {
  return new Promise((resolve, reject) => {
    let d;
    try { d = discovery(); } catch (e) { reject(e); return; }
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const clientNonce = crypto.randomBytes(16).toString('base64url');
    const socket = net.connect(d.endpoint);
    let buf = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error('WorkBuddy 调用超时，请检查账号和网络。')), timeoutMs);
    const send = (v) => socket.write(JSON.stringify(v) + '\n');
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('连接不到 WorkBuddy，请确认应用已打开并登录。')));
    socket.on('close', () => { if (!settled) finish(new Error('WorkBuddy 连接已断开，请重试。')); });
    socket.on('connect', () => send({
      type: 'session_hello', protocol_min: 1, protocol_max: 1,
      client_nonce: clientNonce,
      ticket_id: crypto.createHash('sha256').update(d.ticket).digest('hex').slice(0, 16),
      client: { kind: 'external-app', id: 'workbunny', version: require('../../package.json').version },
    }));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (Buffer.byteLength(buf) > 2 * 1024 * 1024) { finish(new Error('WorkBuddy 返回内容过大')); return; }
      let nl;
      while (!settled && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const v = JSON.parse(line);
          if (v.type === 'session_challenge') {
            const expected = proof(d.ticket, 'server', d.endpoint, clientNonce, v.server_nonce);
            const received = Buffer.from(String(v.server_proof || ''));
            if (received.length !== expected.length || !crypto.timingSafeEqual(received, Buffer.from(expected))) throw new Error('WorkBuddy 身份验证失败');
            send({ type: 'session_prove', client_proof: proof(d.ticket, 'client', d.endpoint, clientNonce, v.server_nonce) });
          } else if (v.type === 'session_hello_ack') {
            if (!v.pipes?.includes('wb.request')) throw new Error('WorkBuddy 账号尚未就绪，请在 WorkBuddy 中重新登录。');
            send({ jsonrpc: '2.0', id: 1, method: 'broker/GetPipe', params: { pipe: 'wb.request' } });
          } else if (v.type === 'session_hello_error' || v.type === 'pipe_revoked') {
            throw new Error('WorkBuddy 登录状态已变化，请重新连接。');
          } else if (v.error) {
            const code = String(v.error.code || '未知错误');
            const error = new Error(code === 'E_PAYLOAD_TOO_LARGE'
              ? 'WorkBuddy 本地转发的回答超过大小限制，请缩短本轮输出或推理预算。'
              : 'WorkBuddy 请求失败：' + code);
            error.code = code;
            throw error;
          } else if (v.id === 1) {
            if (!v.result?.methods?.includes('http.fetch')) throw new Error('此 WorkBuddy 版本不支持账号接口。');
            send({ jsonrpc: '2.0', id: 2, method: v.result.channel + '/http.fetch', mode: 'call', params });
          } else if (v.id === 2) {
            const r = v.result;
            if (!r || typeof r.body_b64 !== 'string') throw new Error('WorkBuddy 返回格式异常');
            const body = Buffer.from(r.body_b64, 'base64').toString('utf8');
            if (r.status < 200 || r.status >= 300) {
              // Do not surface raw upstream responses that may contain account data.
              const error = new Error(`WorkBuddy 账号接口返回 ${r.status}，请检查模型、账号额度或登录状态。`);
              Object.defineProperty(error, 'responseBody', { value: body });
              throw error;
            }
            finish(null, { body, status: r.status, headers: r.headers || {} });
          }
        } catch (e) { finish(e); }
      }
    });
  });
}

function chatPayload(opts) {
  const { model = 'hy3', messages, thinking = 'auto' } = opts;
  // The current WorkBuddy endpoint only accepts streaming chat. Its broker
  // buffers the SSE response, so callers must bound reasoning/output budgets.
  const extraBody = opts.extraBody || {};
  const payload = { model, messages, max_tokens: opts.maxTokens || 4096, ...extraBody };
  if (!Object.hasOwn(extraBody, 'reasoning_effort') && (thinking === 'low' || thinking === 'high')) payload.reasoning_effort = thinking;
  payload.stream = true;
  return payload;
}

function sanitizeFinishReason(value) {
  if (typeof value !== 'string') return null;
  const safe = value.trim().toLowerCase();
  if (!safe) return null;
  return ['stop', 'length', 'max_tokens', 'max_output_tokens', 'content_filter', 'tool_calls', 'function_call', 'error', 'cancelled', 'timeout'].includes(safe) ? safe : 'other';
}
function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    const n = value[key];
    if (Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  if (typeof value.credit === 'number' && Number.isFinite(value.credit) && value.credit >= 0) result.credit = value.credit;
  return Object.keys(result).length ? result : null;
}
function hasReasoningContent(value) {
  return !!value && typeof value === 'object' && [value.reasoning_content, value.reasoning].some(v => typeof v === 'string' && v.length > 0);
}
function parseChatBody(body, model = 'hy3') {
  let raw = '', usedModel = model, usage = null, finishReason = null, hasReasoning = false;
  let object;
  try { object = JSON.parse(body); } catch { /* Older brokers may still return SSE. */ }
  if (object) {
    const data = object.data?.choices ? object.data : object;
    usedModel = data.model || model;
    usage = sanitizeUsage(data.usage);
    const choice = data.choices?.[0];
    finishReason = sanitizeFinishReason(choice?.finish_reason ?? choice?.finishReason);
    hasReasoning = hasReasoningContent(choice?.message);
    const content = choice?.message?.content;
    raw = typeof content === 'string' ? content : '';
  } else for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const text = line.slice(5).trim();
    if (!text || text === '[DONE]') continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    const data = event.data?.choices ? event.data : event;
    if (data.model) usedModel = data.model;
    if (data.usage) usage = sanitizeUsage(data.usage);
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = sanitizeFinishReason(choice.finish_reason);
    const delta = choice?.delta;
    if (hasReasoningContent(delta)) hasReasoning = true;
    raw += delta?.content || '';
  }
  if (!raw.trim()) {
    const limited = ['length', 'max_tokens', 'max_output_tokens', 'token_limit'].includes(String(finishReason || '').toLowerCase());
    const error = new Error(limited ? 'WorkBuddy 输出达到 token 上限，整理结果不完整。' : 'WorkBuddy 没有返回可用回答，请重试。');
    error.code = limited ? 'E_OUTPUT_LIMIT' : 'E_EMPTY_RESPONSE';
    error.finishReason = finishReason;
    error.usage = usage;
    error.hasReasoning = hasReasoning;
    throw error;
  }
  return { raw, model: usedModel, usage, finishReason, hasReasoning };
}
async function chat(opts) {
  const { model = 'hy3', signal, onDelta, onSentence } = opts;
  const payload = chatPayload(opts);
  const r = await request({ method: 'POST', path: '/v2/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body_b64: Buffer.from(JSON.stringify(payload)).toString('base64'),
  }, { signal, timeoutMs: opts.timeoutMs });
  const { raw, model: usedModel, usage } = parseChatBody(r.body, model);
  if (onDelta) onDelta(raw);
  const { extractTags, makeSentenceSplitter } = require('./llm');
  if (onSentence) { const split = makeSentenceSplitter(onSentence); split.push(raw); split.flush(); }
  const parsed = extractTags(raw);
  return { ...parsed, text: parsed.clean.trim(), raw, model: usedModel, usage, provider: 'workbuddy' };
}

module.exports = { chat, request, discovery, chatPayload, parseChatBody, openApplication, sanitizeUsage };
