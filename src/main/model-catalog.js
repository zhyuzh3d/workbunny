'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'], hint: '填写官方 API Key，再获取当前账号可用的模型。' },
  { id: 'openai', label: 'ChatGPT', baseURL: 'https://api.openai.com/v1', models: ['gpt-4.1'], hint: '填写 OpenAI API Key，获取模型后选择。' },
  { id: 'grok', label: 'Grok', baseURL: 'https://api.x.ai/v1', models: ['grok-4.7', 'grok-4.6', 'grok-4.5'], hint: '填写 xAI 官方 API Key，再获取当前账号可用的对话模型。' },
];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LABELS = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '极致', ultra: '极致' };
const AUTO = { id: 'auto', label: '模型默认' };
const OFF = { id: 'off', label: '关闭思考' };
const ON = { id: 'on', label: '开启思考' };
const clean = (s, limit = 200) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const levels = (xs) => [...new Set(Array.isArray(xs) ? xs.filter(x => EFFORTS.includes(x) || x === 'none') : [])];
function options(provider, efforts = [], canDisable = false, canEnable = false) {
  const result = [{ ...AUTO }];
  if (canDisable || efforts.includes('none')) result.push({ ...OFF });
  for (const id of efforts.filter(x => x !== 'none')) {
    const label = id === 'max' && provider === 'deepseek' ? '最高' : id === 'xhigh' && provider === 'grok' ? '最高' : LABELS[id];
    result.push({ id, label: `${label}（${id}）` });
  }
  if (canEnable && !efforts.length) result.push({ ...ON });
  return result;
}
function fallbackThinking(provider, id) {
  if (provider === 'workbuddy' && /^hy3(?:-x)?$/.test(id)) return options(provider, ['low', 'high']);
  if (provider === 'deepseek') {
    if (id === 'deepseek-reasoner') return options(provider, [], false, false);
    if (/^deepseek-(?:flash|v4(?:\.\d+)?-(?:flash|pro))$/.test(id)) return options(provider, ['low', 'high', 'max'], true);
  }
  if (provider === 'grok') {
    if (/^grok-4\.20-multi-agent(?:$|-)/.test(id)) return options(provider, ['low', 'medium', 'high', 'xhigh']).map(t => ({ ...t,
      label: ['low', 'medium'].includes(t.id) ? `4 个代理（${t.id}）` : ['high', 'xhigh'].includes(t.id) ? `16 个代理（${t.id}）` : t.label }));
    if (/^grok-4\.[67](?:$|-)/.test(id)) return options(provider, ['low', 'medium', 'high', 'xhigh']);
    if (/^grok-4\.5(?:$|-)/.test(id)) return options(provider, ['low', 'medium', 'high']);
    if (/^grok-4\.3(?:$|-)/.test(id)) return options(provider, ['none', 'low', 'medium', 'high']);
    if (/^grok-3-mini(?:$|-)/.test(id)) return options(provider, ['low', 'high']);
  }
  return [{ ...AUTO }];
}
function normalize(provider, items) {
  if (!Array.isArray(items)) throw new Error('模型列表格式不正确');
  const seen = new Set(), models = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = clean(item.id);
    if (!id || seen.has(id) || item.disabled || (item.configurable && !item.configured)) continue;
    if (provider === 'openai' && /(?:embedding|whisper|tts|dall-e|image|realtime|transcribe|audio|moderation|codex|search|computer-use|deep-research|^o[13]-pro|^o1-(?:mini|preview)|^gpt-5(?:\.\d+)?-pro)/i.test(id)) continue;
    if (provider === 'workbuddy' && item.tags?.includes('text-to-image')) continue;
    if (Array.isArray(item.output_modalities) && !item.output_modalities.includes('text')) continue;
    if (Array.isArray(item.input_modalities) && !item.input_modalities.includes('text')) continue;
    const r = item.reasoning || {}, capabilities = item.capabilities || {};
    let thinking = fallbackThinking(provider, id);
    if (provider === 'workbuddy') {
      const explicit = levels(r.supportedEfforts);
      if (Array.isArray(r.supportedEfforts)) thinking = options(provider, explicit, r.canDisableThinking === true || item.canDisableThinking === true);
      else if (item.supportsReasoning && !item.onlyReasoning) thinking = options(provider, [], true, true);
      else if (item.supportsReasoning === false) thinking = [{ ...AUTO }];
    } else if (provider === 'deepseek' && Array.isArray(item.effort?.supported_levels)) {
      thinking = options(provider, levels(item.effort.supported_levels), true);
    } else if (provider === 'grok' && Array.isArray(capabilities.reasoning_effort)) {
      thinking = options(provider, levels(capabilities.reasoning_effort));
    }
    if (provider === 'grok' && /^grok-4\.20-multi-agent(?:$|-)/.test(id)) thinking = thinking.map(t => ({ ...t,
      label: ['low', 'medium'].includes(t.id) ? `4 个代理（${t.id}）` : ['high', 'xhigh'].includes(t.id) ? `16 个代理（${t.id}）` : t.label }));
    const name = clean(item.name || item.display_name || id);
    const label = name === id ? id : `${name} · ${id}`;
    const maxOutputTokens = Number(item.max_output_tokens || item.maxOutputTokens);
    const maxInputTokens = Number(item.max_input_tokens || item.maxInputTokens);
    const contextWindow = Number(item.context_window || item.contextWindow || item.context_length || item.contextLength || maxInputTokens);
    models.push({ id, label, thinking, ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}), ...(Number.isSafeInteger(maxInputTokens) && maxInputTokens > 0 ? { maxInputTokens } : {}), ...(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}) });
    seen.add(id);
  }
  if (!models.length) throw new Error('当前账号没有返回可用的对话模型');
  return models;
}
// Dedicated providers share the Chat Completions transport, not their capability rules.
function apiBase(value) {
  const u = require('./tts-http-profile').url(value);
  if (u.search) throw new Error('服务地址不能包含查询参数');
  return u.href.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
}
function apiThinking(provider, model, selection = 'none') {
  const choice = ['none', 'low', 'medium', 'high'].includes(selection) ? selection : selection === 'off' ? 'none' : 'low';
  if (provider === 'deepseek') {
    if (model === 'deepseek-chat' || model === 'deepseek-reasoner') return {};
    return { thinking: { type: choice === 'none' ? 'disabled' : 'enabled' }, reasoning_effort: choice };
  }
  if (provider === 'grok') {
    // Fixed non-reasoning and older reasoning variants reject reasoning_effort.
    if (/(?:^|-)non-reasoning(?:$|-)/.test(model)) return {};
    if (/^grok-4\.[567](?:$|-)/.test(model) || /^grok-4\.20-multi-agent(?:$|-)/.test(model)) return { reasoning_effort: choice === 'none' ? 'low' : choice };
    if (/^grok-3-mini(?:$|-)/.test(model)) return { reasoning_effort: choice === 'high' ? 'high' : 'low' };
    if (/^grok-4\.3(?:$|-)/.test(model)) return { reasoning_effort: choice };
    return {}; // Older Grok models reject this parameter.
  }
  if (provider === 'openai' && !/chat-latest/.test(model) && /^(?:gpt-5|o[134])(?:[.-]|$)/.test(model)) {
    // GPT-5 before 5.1 and o-series do not accept 'none'.
    const supportsNone = /^gpt-5\.(?:[1-9]|[1-9]\d)/.test(model);
    return { reasoning_effort: choice === 'none' && !supportsNone ? 'low' : choice };
  }
  return {};
}
async function requestJSON(url, apiKey) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const fetcher = process.versions.electron ? require('electron').net.fetch : fetch;
    const response = await fetcher(url, { headers:{ Authorization:'Bearer ' + apiKey, Accept:'application/json' }, redirect:'error', signal:controller.signal });
    if (response.status !== 200) throw new Error(response.status === 401 || response.status === 403 ? 'API Key 无效或没有模型访问权限' : `获取模型失败（HTTP ${response.status}）`);
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 3 * 1024 * 1024) throw new Error('模型列表返回内容过大'); parts.push(Buffer.from(part)); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('服务返回的模型列表不是有效 JSON'); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型列表超时，请检查网络');
    throw new Error(/^(API Key|获取模型失败|模型列表返回|服务返回的模型列表)/.test(error.message) ? error.message : '无法获取模型列表，请检查地址、密钥与网络');
  } finally { clearTimeout(timer); controller.abort(); }
}
function connectionKey(provider, apiKey, baseURL) {
  const p = PROVIDERS.find(item => item.id === provider);
  return crypto.createHash('sha256').update(JSON.stringify([provider, apiBase(baseURL || p?.baseURL), String(apiKey || '').trim()])).digest('hex');
}
function createCatalog({ request = requestJSON, workbuddyRequest = (...args) => require('./workbuddy').request(...args) } = {}) {
  let file, cache = {};
  function setPath(value) {
    file = value; cache = {};
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Read only our whitelisted metadata, never propagate credentials or arbitrary response fields.
      for (const id of ['workbuddy', 'deepseek', 'openai', 'grok']) {
        const row = disk[id];
        if (Array.isArray(row?.models)) cache[id] = { at: Number(row.at) || 0, ...(/^[a-f0-9]{64}$/.test(row.connectionKey || '') ? {connectionKey:row.connectionKey} : {}), models: row.models.filter(m => clean(m.id) && Array.isArray(m.thinking)).map(m => ({
          id: clean(m.id), label: clean(m.label), thinking: m.thinking.filter(t => ['auto', 'off', 'on', ...EFFORTS].includes(t.id)).map(t => ({ id: t.id, label: clean(t.label) })),
          ...(Number.isSafeInteger(m.maxOutputTokens) && m.maxOutputTokens > 0 ? { maxOutputTokens: m.maxOutputTokens } : {}),
        })) };
      }
    } catch {}
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function get(provider) {
    const stored = cache[provider];
    if (stored?.models.length) return JSON.parse(JSON.stringify(stored));
    const ids = provider === 'workbuddy' ? ['hy3'] : PROVIDERS.find(p => p.id === provider)?.models || [];
    return { at: 0, models: ids.map(id => ({ id, label: id === 'hy3' ? '混元三 · Hy3' : id, thinking: fallbackThinking(provider, id) })) };
  }
  function forConnection(provider, apiKey, baseURL) {
    if (provider === 'workbuddy') return get(provider);
    let current = false;
    try { current = !!apiKey && cache[provider]?.connectionKey === connectionKey(provider,apiKey,baseURL); } catch {}
    const value = current ? get(provider) : { at:0, models:[] };
    delete value.connectionKey; return { ...value, current };
  }
  function thinking(provider, id) { return get(provider).models.find(m => m.id === id)?.thinking || fallbackThinking(provider, id); }
  function body(provider, id, selection) {
    const allowed = thinking(provider, id);
    const t = allowed.some(x => x.id === selection) ? selection : 'auto';
    if (t === 'auto') return {};
    if (provider === 'deepseek' || provider === 'workbuddy') {
      if (t === 'off') return { thinking: { type: 'disabled' } };
      if (t === 'on') return { thinking: { type: 'enabled' } };
      return { ...(provider === 'deepseek' ? { thinking: { type: 'enabled' } } : {}), reasoning_effort: t };
    }
    if (provider === 'grok') return { reasoning_effort: t === 'off' ? 'none' : t };
    return {};
  }
  async function refresh(provider, apiKey = '', baseURL) {
    let models;
    if (provider === 'workbuddy') {
      const response = await workbuddyRequest({ method: 'GET', path: '/v2/enterprises/personal/models' }, { timeoutMs: 20000 });
      let data; try { data = JSON.parse(response.body); } catch { throw new Error('WorkBuddy 模型列表格式不正确'); }
      if (data.code && data.code !== 0) throw new Error('WorkBuddy 未能返回模型列表，请检查登录状态');
      models = normalize(provider, (data.data || data).models);
    } else {
      const p = PROVIDERS.find(p => p.id === provider);
      if (!p) throw new Error('不支持的模型服务商');
      if (!String(apiKey).trim()) throw new Error('请先填写该服务商的 API Key');
      // Grok's language endpoint excludes image/video generators and includes capability metadata.
      const data = await request(apiBase(baseURL || p.baseURL) + (provider === 'grok' ? '/language-models' : '/models'), String(apiKey).trim());
      models = normalize(provider, provider === 'grok' ? data.models : data.data);
    }
    const previous = cache[provider];
    cache[provider] = { at:Date.now(), models, ...(provider === 'workbuddy' ? {} : {connectionKey:connectionKey(provider,apiKey,baseURL)}) };
    try { save(); } catch { cache[provider] = previous; throw new Error('模型列表已获取，但本地保存失败'); }
    return get(provider);
  }
  function invalidate(provider) { delete cache[provider]; save(); }
  return { setPath, get, forConnection, thinking, body, refresh, invalidate };
}
module.exports = { ...createCatalog(), createCatalog, PROVIDERS, normalize, fallbackThinking, requestJSON, apiBase, apiThinking };
