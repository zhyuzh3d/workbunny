'use strict';
/**
 * 大脑：OpenAI 兼容流式接口（Node https，强制 HTTP/1.1 —— 该网关的 HTTP/2 POST 会挂死）。
 * 职责：把流式增量切成"可直接朗读的句子"，同时从文本里剥出动作/表情标签。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

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
const SENT_RE = /[^。！？!?\n…]*[。！？!?\n…]+/g;

function makeSentenceSplitter(onSentence) {
  let buf = '';
  return {
    push(delta) {
      buf += delta;
      let last = 0;
      let m;
      SENT_RE.lastIndex = 0;
      while ((m = SENT_RE.exec(buf))) {
        const s = m[0].trim();
        last = SENT_RE.lastIndex;
        if (s) onSentence(s);
      }
      if (last > 0) buf = buf.slice(last);
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
function chat(opts) {
  if (opts.transport === 'workbuddy') return require('./workbuddy').chat(opts);
  const {
    baseURL, apiKey, model, messages,
    temperature = 0.8, maxTokens = 220, timeoutMs = 30000,
    onDelta, onSentence, signal,
    // 思考强度：只有明确支持的服务商才发这个字段（doubao 用 thinking:{type}，
    // nemotron 用 chat_template_kwargs.thinking）。auto = 什么都不发，让服务方自己定。
    extraBody = {},
  } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(baseURL.replace(/\/$/, '') + '/chat/completions');
    } catch (e) {
      return reject(new Error('baseURL 非法: ' + baseURL));
    }
    const isHttps = u.protocol === 'https:';
    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
      // 部分网关认这个；不认的会忽略
      stream_options: { include_usage: true },
      ...extraBody,
    });

    const req = (isHttps ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        agent: isHttps ? keepAliveHttps : keepAliveHttp,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer ' + apiKey,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => reject(new Error(`LLM ${res.statusCode}: ${body.slice(0, 300)}`)));
          return;
        }
        res.setEncoding('utf8');
        let text = '';
        let usage = null;
        const splitter = makeSentenceSplitter((s) => onSentence && onSentence(s));
        let buf = '';

        res.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (p === '[DONE]') continue;
            let d;
            try {
              d = JSON.parse(p);
            } catch {
              continue;
            }
            if (d.usage) usage = d.usage;
            const ch = (d.choices && d.choices[0]) || null;
            if (!ch) continue;
            const delta = ch.delta || {};
            // 推理模型的思考过程不进正文
            if (delta.content) {
              text += delta.content;
              if (onDelta) onDelta(delta.content);
              splitter.push(delta.content);
            }
          }
        });

        res.on('end', () => {
          splitter.flush();
          const { clean, motions, emos } = extractTags(text);
          if (!clean.trim()) { reject(new Error('模型没有返回回答正文，请检查所选模型和思考设置')); return; }
          resolve({ text: clean.trim(), raw: text, motions, emos, usage, model });
        });
        res.on('error', reject);
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`LLM 超时 ${timeoutMs}ms`));
    });
    req.on('error', (e) => {
      if (signal && signal.aborted) return reject(new Error('aborted'));
      reject(e);
    });
    const abort = () => req.destroy(new Error('aborted'));
    if (signal?.aborted) { abort(); return; }
    if (signal) signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', abort));
    req.write(payload);
    req.end();
  });
}

module.exports = { chat, extractTags, makeSentenceSplitter };
