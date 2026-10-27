'use strict';

const net = require('node:net');
const { containsSecret } = require('./conversation-input');
const wb = require('./workbuddy');

function publicURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || containsSecret(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') ||
        net.isIP(host.replace(/^\[|\]$/gu, '')) || /(?:^|\.)(?:localhost|local|lan|internal|home|invalid|test)$/u.test(host)) return null;
    return url.href;
  } catch { return null; }
}
function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, max) : '';
}
function searchQuery(value) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 300 || containsSecret(value) ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw Object.assign(new Error('搜索词须为简短公开主题，不包含密码或密钥。'), { code: 'E_SEARCH_QUERY' });
  return value.trim();
}

async function searchPublicWeb({ query, signal, timeoutMs = 22000 }, { request = wb.request, clock = Date.now } = {}) {
  query = searchQuery(query);
  if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'E_ABORTED' });
  const response = await request({ method: 'POST', path: '/agenttool/v1/search',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body_b64: Buffer.from(JSON.stringify({ query, type: 'text2text', max_results: 3 })).toString('base64'),
  }, { signal, timeoutMs: Math.min(22000, Math.max(1, timeoutMs)) });
  if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'E_ABORTED' });
  let body;
  try { body = JSON.parse(response.body); } catch { throw Object.assign(new Error('搜索结果暂不可用'), { code: 'E_WEB_SEARCH' }); }
  if ((response.status && response.status !== 200) || (body.code !== undefined && body.code !== 0))
    throw Object.assign(new Error('WorkBuddy 搜索服务暂不可用'), { code: 'E_WEB_SEARCH' });
  const raw = body.results || body.data?.results;
  if (!Array.isArray(raw)) throw Object.assign(new Error('搜索结果格式不正确'), { code: 'E_WEB_SEARCH' });
  const seen = new Set(), results = [];
  for (const item of raw.slice(0, 20)) {
    const url = publicURL(item?.url), title = clean(item?.title, 180), snippet = clean(item?.snippet, 1000);
    if (!url || !title || containsSecret(snippet) || seen.has(url)) continue;
    seen.add(url); results.push({ title, url, snippet });
    if (results.length === 3) break;
  }
  return { query, searchedAt: clock(), results };
}

module.exports = { searchPublicWeb, publicURL, searchQuery };
