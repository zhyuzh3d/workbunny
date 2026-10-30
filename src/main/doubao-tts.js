'use strict';
const P = require('./tts-http-profile');
const URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const MODELS = [
  { id: 'seed-tts-2.0', label: '语音合成 2.0' },
  { id: 'seed-icl-2.0', label: '声音复刻 2.0' },
];
// Official public catalog, not an account entitlement list. Custom voice IDs remain editable.
// https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh
const VOICES = [
  ['zh_female_vv_uranus_bigtts', 'Vivi 2.0'],
  ['zh_female_xiaohe_uranus_bigtts', '小何 2.0'],
  ['zh_male_m191_uranus_bigtts', '云舟 2.0'],
  ['zh_male_taocheng_uranus_bigtts', '小天 2.0'],
  ['zh_male_liufei_uranus_bigtts', '刘飞 2.0'],
  ['zh_female_sophie_uranus_bigtts', '魅力苏菲 2.0'],
  ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声 2.0'],
  ['zh_female_cancan_uranus_bigtts', '知性灿灿 2.0'],
].map(([id, label]) => ({ id, label }));
function normalize(value = {}) {
  const out = { url: value.url || URL, apiKey: value.apiKey || '', model: value.model || MODELS[0].id, voice: value.voice ?? VOICES[0].id };
  if (Object.values(out).some(v => typeof v !== 'string' || /[\r\n\u0000]/.test(v))) throw new Error('豆包语音配置格式不正确');
  P.url(out.url);
  if (!MODELS.some(m => m.id === out.model)) throw new Error('请选择豆包语音模型');
  if (out.voice.length > 200 || out.apiKey.length > 4096) throw new Error('音色或 API Key 过长');
  return out;
}
function httpConfig(value) {
  const c = normalize(value);
  if (!c.apiKey.trim()) throw new Error('请填写豆包语音 API Key');
  if (!c.voice.trim()) throw new Error('请选择或填写音色');
  const profile = P.template(); profile.url = c.url;
  // The current HTTP API documents code=0 chunks followed by a clean HTTP EOF.
  // Unlike SSE, it need not send a separate 20000000 completion event.
  profile.response.allowEOF = true;
  if (c.model === 'seed-icl-2.0') profile.body.req_params.model = 'seed-tts-2.0-standard';
  return { http: { profile, params: { resourceId: c.model, voice: c.voice }, secrets: { apiKey: c.apiKey.trim() } } };
}
async function synthesize(text, cfg, options) {
  const result = await require('./tts-http').synthesize(text, httpConfig(cfg.doubao), options);
  return { ...result, engine: 'doubao' };
}
module.exports = { URL, MODELS, VOICES, normalize, httpConfig, synthesize };
