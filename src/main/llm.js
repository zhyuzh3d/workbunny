'use strict';
/**
 * 大脑：OpenAI 兼容流式接口（Node https，强制 HTTP/1.1 —— 该网关的 HTTP/2 POST 会挂死）。
 * 职责：把流式增量切成"可直接朗读的句子"，同时从文本里剥出动作/表情标签。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { ChatResponse } = require('./chat-response');

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 4 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 4 });

/** 从文本里剥出 <m>x</m> / <e>x</e>，返回干净文本与标签
 * 动作名允许数字/连字符：greeting2、show_full_body 这类名字真实存在，
 * 只认字母的话标签剥不掉，会被原样念出来（"greeting二"）。 */
function extractTags(raw) {
  const motions = [];
  const emos = [];
  const clean = raw
    .replace(/<m>\s*([A-Za-z0-9_-]+)\s*<\/m>/g, (_, k) => (motions.push(k), ''))
    .replace(/<e>\s*([A-Za-z0-9_-]+)\s*<\/e>/g, (_, k) => (emos.push(k), ''))
    .replace(/<\/?[me]>/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  return { clean, motions, emos };
}

/** Keep short spoken replies as well; never consume and discard “好。” / “嗯。” */
function makeSentenceSplitter(onSentence) {
  let buf = '';
  const separators = /[。！？!?\n…]+/g;
  return {
    push(delta) {
      let start = 0;
      separators.lastIndex = 0;
      while (separators.exec(delta)) {
        const sentence = (buf + delta.slice(start, separators.lastIndex)).trim();
        start = separators.lastIndex;
        buf = '';
        if (sentence) onSentence(sentence);
      }
      buf += delta.slice(start);
    },
    flush() {
      const s = buf.trim();
      buf = '';
      if (s) onSentence(s);
    },
    get pending() {
      return buf;
    },
  };
}

/**
 * @returns {Promise<{text:string,motions:string[],emos:string[],usage:any,ms:number}>}
 */
function chat(opts) { return require('./owner-security').withPrinciples(chatUnfiltered,opts); }
function chatUnfiltered(opts) {
  if (opts.transport === 'workbuddy') return opts.webSearch === true || opts.recallSession || opts.contextSession
    ? require('./conversation-search').chatWithSearch(opts) : require('./workbuddy').chat(opts);
  if ((opts.recallSession||opts.contextSession) && !opts._toolRound) return require('./conversation-search').chatWithSearch(opts, {
    chat: request => chat({ ...request, _toolRound: true, recallSession: undefined,contextSession:undefined, webSearch: false }),
  });
  if (opts.transport === 'apikey' && !String(opts.apiKey || '').trim()) return Promise.reject(new Error('请先在智力设置中填写 API Key'));
  // Fit once the recall/search layer has attached its rules and tool schemas.
  opts = require('./context-budget').fitRequest(opts, { retainLanes: true });
  return requestHTTP(opts);
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 8192;

function responseError(status, body) {
  const error = new Error(`模型接口返回 HTTP ${status}，请检查密钥、所选模型、额度或请求频率`);
  if (status === 400 && /does not support parameter reasoningEffort|unsupported.{0,80}reasoning[_ ]?effort|reasoning[_ ]?effort.{0,80}(?:not supported|unsupported)/i.test(body)) {
    error.message = '所选模型不支持当前思考参数，请更新模型配置或应用';
    error.code = 'E_MODEL_PARAMETER';
  }
  if (require('./context-budget').isContextError(status, body)) error.code = 'E_CONTEXT_WINDOW';
  return error;
}

function requestHTTP({ baseURL, apiKey, model, messages, maxTokens = 220, timeoutMs = 30000, provider,
  onDelta, onSentence, signal, extraBody = {} }) {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) { reject(aborted()); return; }
    let url;
    try { url = new URL(baseURL.replace(/\/$/, '') + '/chat/completions'); }
    catch { reject(new Error('模型接口地址无效')); return; }
    if (!['https:', 'http:'].includes(url.protocol)) { reject(new Error('模型接口须使用 HTTP 或 HTTPS')); return; }

    const payload = JSON.stringify({
      ...(provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      stream_options: { include_usage: true },
      ...extraBody,
      model,
      messages: messages.map(require('./context-budget').wire),
      stream: true,
    });
    const secure = url.protocol === 'https:';
    let request, response, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(result);
    };
    const abort = () => finish(aborted());
    // The deadline includes socket queueing and slow streaming responses.
    const timer = setTimeout(() => finish(Object.assign(new Error(`LLM 超时 ${timeoutMs}ms`), { code: 'E_MODEL_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      request = (secure ? https : http).request(url, {
        method: 'POST',
        agent: secure ? keepAliveHttps : keepAliveHttp,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer ' + apiKey,
        },
      }, res => {
        response = res;
        res.setEncoding('utf8');
        res.on('error', finish);
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', chunk => {
            errorBody += chunk.slice(0, MAX_ERROR_BYTES - errorBody.length);
            if (errorBody.length >= MAX_ERROR_BYTES) finish(responseError(res.statusCode, errorBody));
          });
          res.on('end', () => finish(responseError(res.statusCode, errorBody)));
          return;
        }

        const isJSON = /application\/(?:[\w.+-]*\+)?json/i.test(res.headers['content-type'] || '');
        const splitter = onSentence && makeSentenceSplitter(onSentence);
        const chat = new ChatResponse(model, { onDelta: delta => { onDelta?.(delta); splitter?.push(delta); } });
        let bytes = 0, tail = '';
        const json = [];
        res.on('data', chunk => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(Object.assign(new Error('模型回答超过大小限制'), { code: 'E_PAYLOAD_TOO_LARGE' }));
            return;
          }
          if (isJSON) { json.push(chunk); return; }
          const lines = chunk.split('\n');
          if (lines.length === 1) { tail += chunk; return; }
          lines[0] = tail + lines[0];
          tail = lines.pop();
          try { for (const line of lines) chat.line(line.trimStart()); }
          catch (error) { finish(error); }
        });
        res.on('end', () => {
          if (settled) return;
          try {
            if (isJSON) chat.event(JSON.parse(json.join('')));
            else if (tail) chat.line(tail.trimStart());
            const result = chat.result();
            if (result.toolCalls) { finish(null, { ...result, text: '' }); return; }
            splitter?.flush();
            const { clean, motions, emos } = extractTags(result.raw);
            if (!clean.trim()) throw Object.assign(new Error('模型没有返回回答正文，请检查所选模型和思考设置'), { code: 'E_EMPTY_RESPONSE' });
            finish(null, { ...result, text: clean.trim(), motions, emos });
          } catch (error) {
            finish(error instanceof SyntaxError ? Object.assign(new Error('模型接口返回无效 JSON'), { code: 'E_MODEL_PROTOCOL' }) : error);
          }
        });
      });
      request.on('error', finish);
      request.end(payload);
    } catch (error) { finish(error); }
  });
}

module.exports = { chat, extractTags, makeSentenceSplitter };
