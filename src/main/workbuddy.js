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
            throw new Error('WorkBuddy 请求失败：' + String(v.error.code || '未知错误'));
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
  const payload = { model, messages, stream: true, max_tokens: opts.maxTokens || 4096, ...opts.extraBody };
  if (!opts.extraBody && (thinking === 'low' || thinking === 'high')) payload.reasoning_effort = thinking;
  return payload;
}
async function chat(opts) {
  const { model = 'hy3', signal, onDelta, onSentence } = opts;
  const payload = chatPayload(opts);
  const r = await request({ method: 'POST', path: '/v2/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body_b64: Buffer.from(JSON.stringify(payload)).toString('base64'),
  }, { signal });
  let raw = '', usedModel = model, usage = null;
  for (const line of r.body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const text = line.slice(5).trim();
    if (!text || text === '[DONE]') continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    const data = event.data?.choices ? event.data : event;
    if (data.model) usedModel = data.model;
    if (data.usage) usage = data.usage;
    raw += data.choices?.[0]?.delta?.content || '';
  }
  if (!raw.trim()) throw new Error('WorkBuddy 没有返回回答，请重试。');
  if (onDelta) onDelta(raw);
  const { extractTags, makeSentenceSplitter } = require('./llm');
  if (onSentence) { const split = makeSentenceSplitter(onSentence); split.push(raw); split.flush(); }
  const parsed = extractTags(raw);
  return { ...parsed, text: parsed.clean.trim(), raw, model: usedModel, usage, provider: 'workbuddy' };
}

module.exports = { chat, request, discovery, chatPayload, openApplication };
