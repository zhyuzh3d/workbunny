'use strict';
// WorkBuddy's authenticated local broker forwards requests using the active account.
// No account token is copied into workbunny's configuration or renderer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { JsonLines } = require('./json-lines');
const { parseChatBody, sanitizeUsage } = require('./chat-response');
let readiness = () => true, disconnected = () => {}, recoverConnection = null, connectionVersion = () => 0;
function configureConnection({ ready, onDisconnect, recover, version }) { readiness = ready; disconnected = onDisconnect; recoverConnection = recover || null; connectionVersion = version || (() => 0); }
function isTransientConnectionError(error) {
  return !/身份验证|登录状态已变化|重新登录/.test(error?.message || '') &&
    (error?.code === 'E_UPSTREAM_TRANSIENT' || /连接|调用超时|ECONN|EPIPE|ETIMEDOUT/.test(String(error?.code || '') + ' ' + String(error?.message || '')));
}

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

function request(params, { signal, timeoutMs = 55000, discover = discovery } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); return; }
    const { endpoint, ticket } = discover();
    if (!(params.method === 'GET' && params.path === '/v2/enterprises/personal/models') && !readiness({ endpoint, ticket })) {
      reject(new Error('请先连接 WorkBuddy 并登录账号')); return;
    }
    const generation = connectionVersion();
    const clientNonce = crypto.randomBytes(16).toString('base64url');
    const socket = net.connect(endpoint);
    const frames = new JsonLines(2 * 1024 * 1024);
    let stage = 'challenge', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      frames.reset();
      socket.destroy();
      if (error && (error.code === 'E_AUTH_SESSION' || /连接不到|连接已断开|身份验证|登录状态已变化|账号尚未就绪/.test(error.message))) {
        try { disconnected(); } catch {}
      }
      if (error) reject(error);
      else if (generation !== connectionVersion()) reject(Object.assign(new Error('WorkBuddy 授权会话已变化'), { code: 'E_AUTH_SESSION' }));
      else resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => finish(new Error('WorkBuddy 调用超时，请检查账号和网络。')), timeoutMs);
    const send = value => socket.write(JSON.stringify(value) + '\n');
    const expect = expected => {
      if (stage !== expected) throw new Error('WorkBuddy 身份验证或请求顺序无效');
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('连接不到 WorkBuddy，请确认应用已打开并登录。')));
    socket.on('close', () => { if (!settled) finish(new Error('WorkBuddy 连接已断开，请重试。')); });
    socket.on('connect', () => send({
      type: 'session_hello', protocol_min: 1, protocol_max: 1, client_nonce: clientNonce,
      ticket_id: crypto.createHash('sha256').update(ticket).digest('hex').slice(0, 16),
      client: { kind: 'external-app', id: 'workbunny', version: require('../../package.json').version },
    }));
    socket.on('data', chunk => {
      if (settled) return;
      try {
        frames.push(chunk, frame => {
          if (frame.type === 'session_challenge') {
            expect('challenge');
            if (typeof frame.server_nonce !== 'string' || !frame.server_nonce || frame.server_nonce.length > 256) throw new Error('WorkBuddy 身份验证失败');
            const expected = Buffer.from(proof(ticket, 'server', endpoint, clientNonce, frame.server_nonce));
            const received = Buffer.from(String(frame.server_proof || ''));
            if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('WorkBuddy 身份验证失败');
            stage = 'ack';
            send({ type: 'session_prove', client_proof: proof(ticket, 'client', endpoint, clientNonce, frame.server_nonce) });
          } else if (frame.type === 'session_hello_ack') {
            expect('ack');
            if (!frame.pipes?.includes('wb.request')) throw new Error('WorkBuddy 账号尚未就绪，请在 WorkBuddy 中重新登录。');
            stage = 'pipe';
            send({ jsonrpc: '2.0', id: 1, method: 'broker/GetPipe', params: { pipe: 'wb.request' } });
          } else if (frame.type === 'session_hello_error' || frame.type === 'pipe_revoked') {
            throw new Error('WorkBuddy 登录状态已变化，请重新连接。');
          } else if (frame.id === 1 || frame.id === 2) {
            expect(frame.id === 1 ? 'pipe' : 'result');
            if (frame.error) {
              const supplied = String(frame.error.code || '');
              const code = /^(?:E_[A-Z0-9_]{1,80}|-?\d{1,10})$/u.test(supplied) ? supplied : 'E_BROKER';
              throw Object.assign(new Error(code === 'E_PAYLOAD_TOO_LARGE'
                ? 'WorkBuddy 本地转发的回答超过大小限制，请缩短本轮输出或推理预算。' : 'WorkBuddy 请求失败：' + code), { code });
            }
            const result = frame.result;
            if (frame.id === 1) {
              if (!result?.methods?.includes('http.fetch') || typeof result.channel !== 'string') throw new Error('此 WorkBuddy 版本不支持账号接口。');
              stage = 'result';
              send({ jsonrpc: '2.0', id: 2, method: result.channel + '/http.fetch', mode: 'call', params });
            } else {
              if (!Number.isInteger(result?.status) || typeof result.body_b64 !== 'string') throw new Error('WorkBuddy 返回格式异常');
              const body = Buffer.from(result.body_b64, 'base64').toString('utf8');
              if (result.status < 200 || result.status >= 300) {
                const error = new Error(`WorkBuddy 账号接口返回 ${result.status}，请检查模型、账号额度或登录状态。`);
                Object.defineProperty(error, 'responseBody', { value: body });
                error.statusCode = result.status;
                error.code = [401, 403].includes(result.status) ? 'E_AUTH_SESSION' :
                  [408, 429, 500, 502, 503, 504].includes(result.status) ? 'E_UPSTREAM_TRANSIENT' : 'E_UPSTREAM';
                if (require('./context-budget').isContextError(result.status, body)) error.code = 'E_CONTEXT_WINDOW';
                throw error;
              }
              finish(null, { body, status: result.status, headers: result.headers || {} });
              return false;
            }
          }
        });
      } catch (error) {
        if (error.code === 'E_JSON_LINE_LIMIT') error = Object.assign(new Error('WorkBuddy 返回内容过大'), { code: 'E_PAYLOAD_TOO_LARGE' });
        else if (error instanceof SyntaxError) error = new Error('WorkBuddy 返回格式异常');
        finish(error);
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

async function chatWithTransport(opts, transport) {
  opts = require('./context-budget').fitRequest({ ...opts, provider: 'workbuddy' });
  const { model = 'hy3', signal, onDelta, onSentence } = opts;
  const payload = chatPayload(opts);
  const r = await transport({ method: 'POST', path: '/v2/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body_b64: Buffer.from(JSON.stringify(payload)).toString('base64'),
  }, { signal, timeoutMs: opts.timeoutMs });
  const { raw, model: usedModel, usage, toolCalls } = parseChatBody(r.body, model);
  if (toolCalls?.length) return { text: '', raw: '', model: usedModel, usage, provider: 'workbuddy', toolCalls };
  if (onDelta) onDelta(raw);
  const { extractTags, makeSentenceSplitter } = require('./llm');
  if (onSentence) { const split = makeSentenceSplitter(onSentence); split.push(raw); split.flush(); }
  const parsed = extractTags(raw);
  return { ...parsed, text: parsed.clean.trim(), raw, model: usedModel, usage, provider: 'workbuddy' };
}

async function chat(opts) {
  const deadline = Date.now() + (opts.timeoutMs || 55000);
  const version = connectionVersion();
  try { return await chatWithTransport(opts, request); }
  catch (error) {
    // Retry inference only; no GUI action, task or message is replayed.
    if (!recoverConnection || opts.signal?.aborted || !isTransientConnectionError(error) || deadline - Date.now() < 1500) throw error;
    const status = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (failure, value) => {
        if (settled) return; settled = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', abort);
        failure ? reject(failure) : resolve(value);
      };
      const abort = () => finish(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      const timer = setTimeout(() => finish(Object.assign(new Error('WorkBuddy 重新连接超时，任务已保留'), { code: 'E_CONNECTION_TIMEOUT' })), Math.max(1, deadline - Date.now()));
      opts.signal?.addEventListener('abort', abort, { once: true });
      if (opts.signal?.aborted) { abort(); return; }
      Promise.resolve().then(recoverConnection).then(value => finish(null, value), failure => finish(failure));
    });
    if (version !== connectionVersion()) throw Object.assign(new Error('WorkBuddy 授权会话已变化，未向新会话重放原请求'), { code: 'E_AUTH_SESSION' });
    if (!status?.ready || opts.signal?.aborted || deadline <= Date.now()) throw error;
    return chatWithTransport({ ...opts, timeoutMs: deadline - Date.now() }, request);
  }
}

module.exports = { configureConnection, chat: opts => require('./owner-security').withPrinciples(chat,opts), request, discovery, chatPayload, parseChatBody, openApplication, sanitizeUsage, chatWithTransport, isTransientConnectionError };
