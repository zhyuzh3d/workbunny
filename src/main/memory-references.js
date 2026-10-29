'use strict';
const crypto = require('node:crypto');
const { containsSecret } = require('./conversation-input');
const GENERIC = new Set(['工作', '生活', '开心', '难过', '用户', '主人', '记忆', '对话', '偏好', '任务', '今天', '昨天', '这个', '那个', '主动记忆', '自动记忆']);
function localDay(at, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function validDay(day) { return /^\d{4}-\d{2}-\d{2}$/u.test(day) && Number.isFinite(Date.parse(day)) && new Date(day + 'T00:00:00Z').toISOString().startsWith(day); }
function key(value, type = 'topic') { return 'bunny_ref_' + crypto.createHash('sha256').update(type + ':' + value.normalize('NFKC').trim().toLowerCase()).digest('hex').slice(0, 32); }
function normalize(text, { at = Date.now(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, keywords = [], entities = [], timeUnknown = false } = {}) {
  text = String(text || '');
  const day = localDay(at, timezone), dates = [];
  const quotes = [];
  let unquoted = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, part => {
    if (!/今天|昨天|明天|前天|后天|上周|下周|本周|这周|上个月|这个月|去年|今年|明年|\b(?:today|yesterday|tomorrow)\b/iu.test(part)) return part;
    quotes.push(part); return `\uE000${quotes.length - 1}\uE001`;
  });
  const quotedCount = quotes.length;
  if (timeUnknown) unquoted = unquoted.replace(/前天|昨天|今天|明天|后天|上周|下周|本周|这周|上个月|这个月|本月|下个月|去年|今年|明年|\b(?:the day before yesterday|yesterday|today|tomorrow)\b/giu,
    word => { quotes.push(word); return `\uE000${quotes.length - 1}\uE001`; });
  const recurrences = [...text.matchAll(/每(?:周|星期)([一二三四五六日天])/gu)].map(m => ({ frequency: 'weekly', weekday: ['日', '天'].includes(m[1]) ? 7 : '一二三四五六'.indexOf(m[1]) + 1 }));
  let canonical = unquoted.replace(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]/gu, (raw, y, m, d) => {
    const value = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return validDay(value) ? value : raw;
  });
  if (!timeUnknown && !/生日|出生|每年|周年/u.test(text)) canonical = canonical.replace(/(?<!\d)(\d{1,2})月\s*(\d{1,2})[日号]/gu, (raw, m, d) => {
    const value = `${day.slice(0, 4)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; return validDay(value) ? value : raw;
  });
  canonical = canonical.replace(/前天|昨天|今天|明天|后天|\bthe day before yesterday\b|\byesterday\b|\btoday\b|\btomorrow\b/giu, word => {
    const delta = { 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2, 'the day before yesterday': -2, yesterday: -1, today: 0, tomorrow: 1 }[word.toLowerCase()];
    return addDays(day, delta);
  });
  canonical = canonical.replace(/(上|本|这|下)(?:周|星期)([一二三四五六日天])/gu, (_raw, relative, weekdayName) => {
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay() || 7;
    const wanted = ['日', '天'].includes(weekdayName) ? 7 : '一二三四五六'.indexOf(weekdayName) + 1;
    return addDays(day, wanted - weekday + (relative === '上' ? -7 : relative === '下' ? 7 : 0));
  });
  canonical = canonical.replace(/上周|本周|这周|下周/gu, word => {
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay() || 7;
    const start = addDays(day, 1 - weekday + (word === '上周' ? -7 : word === '下周' ? 7 : 0));
    dates.push({ start, end: addDays(start, 7), precision: 'week' }); return `${start}至${addDays(start, 6)}`;
  });
  canonical = canonical.replace(/上个月|这个月|本月|下个月|去年|今年|明年/gu, word => {
    const d = new Date(day + 'T12:00:00Z');
    if (/年/u.test(word)) {
      const year = d.getUTCFullYear() + ({ 去年: -1, 今年: 0, 明年: 1 }[word]);
      dates.push({ start: `${year}-01-01`, end: `${year + 1}-01-01`, precision: 'year' }); return `${year}年`;
    }
    const delta = word === '上个月' ? -1 : word === '下个月' ? 1 : 0;
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta + 1, 1)).toISOString().slice(0, 10);
    dates.push({ start, end, precision: 'month' }); return `${start}至${addDays(end, -1)}`;
  });
  canonical = canonical.replace(/(\d{4}-\d{2}-\d{2})\s*(至|到|[~～—])\s*(\d{1,2})[日号]/gu, (raw, start, join, endDay) => {
    const end = start.slice(0, 8) + endDay.padStart(2, '0'); return validDay(end) ? `${start}${join}${end}` : raw;
  });
  const ranges = [];
  for (const m of canonical.matchAll(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|[~～—]|\s-\s)\s*(\d{4}-\d{2}-\d{2})/gu)) {
    if (validDay(m[1]) && validDay(m[2]) && m[1] <= m[2]) ranges.push({ start: m[1], end: addDays(m[2], 1), precision: 'range' });
  }
  dates.push(...ranges);
  for (const match of canonical.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)) if (validDay(match[0]) && !dates.some(d => d.start <= match[0] && match[0] < d.end)) dates.push({ start: match[0], end: addDays(match[0], 1), precision: 'day' });
  const resolvedEntities = entities.filter(e => e && typeof e.id === 'string' && typeof e.name === 'string' &&
    !containsSecret(e.name) && [e.name, ...(e.aliases || [])].some(alias => alias && text.includes(alias)));
  const unresolved = [...new Set((canonical.match(/那座城市|这座城市|那个地方|这个项目|那个项目|那个人|这个人|这件事|那件事|这里|那里|那天|那次|这个|那个/gu) || []))];
  if (quotedCount) unresolved.push('引用中的相对时间');
  if (timeUnknown) unresolved.push('原话日期未知');
  const topics = [...new Set(keywords.filter(t => typeof t === 'string').map(t => t.normalize('NFKC').trim().toLowerCase())
    .filter(t => t.length >= 2 && t.length <= 48 && !GENERIC.has(t) && !/今天|昨天|明天|这个|那个|那座|这里|那里/u.test(t) && !containsSecret(t)))].slice(0, 8);
  canonical = canonical.replace(/\uE000(\d+)\uE001/gu, (_, i) => quotes[Number(i)]);
  return { canonical, references: { schema: 'memory-references/v1', normalizer: 2, recordedAt: at, timezone, ...(timeUnknown ? { timeUnknown: true } : {}),
    eventStatus: /计划|打算|准备|将要|预约|明天|后天|下周|下个月|tomorrow/iu.test(text) ? 'planned' : 'unspecified',
    recurrences, validFrom: null, validUntil: null, dates: [...new Map(dates.map(d => [JSON.stringify(d), d])).values()].slice(0, 8),
    entities: resolvedEntities.map(e => ({ id: e.id, name: e.name, type: e.type || 'entity', ...(e.sourceId ? { sourceId: e.sourceId } : {}) })).slice(0, 8), unresolved,
    keys: [...new Set([...topics.map(t => key(t)), ...resolvedEntities.map(e => key(e.id, 'entity'))])].slice(0, 16) } };
}
// Dyadic day intervals: a range needs O(log days) encrypted keys. Querying
// covering ancestors and contained nodes finds overlap before the SQL LIMIT,
// without putting plaintext dates or an unbounded list of days in SQLite.
function dateNodes(dates = []) {
  const nodes = [];
  for (const d of dates.slice(0, 8)) {
    if (!validDay(d.start) || !validDay(d.end) || d.start >= d.end) continue;
    let left = Math.floor(Date.parse(d.start) / 86400000) + 4194304, right = Math.floor(Date.parse(d.end) / 86400000) + 4194304, level = 0;
    while (left < right && level <= 23) {
      if (left % 2) nodes.push([level, left++]);
      if (right % 2) nodes.push([level, --right]);
      left = Math.floor(left / 2); right = Math.floor(right / 2); level++;
    }
  }
  return nodes;
}
function temporalTokens(references, querying = false) {
  const out = new Set();
  for (const [level, bucket] of dateNodes(references?.dates)) {
    if (querying) out.add(`bunny_dt_a_${level}_${bucket}`);
    else out.add(`bunny_dt_c_${level}_${bucket}`);
    for (let l = level, b = bucket; l <= 23; l++, b = Math.floor(b / 2)) {
      if (querying) out.add(`bunny_dt_c_${l}_${b}`);
      else if (l > level) out.add(`bunny_dt_a_${l}_${b}`);
    }
  }
  return [...out];
}
function tokens(value) {
  const r = value?.references;
  if (!r || r.schema !== 'memory-references/v1') return [];
  const dated = temporalTokens(r);
  return [...(r.keys || []).filter(k => /^bunny_ref_[a-f0-9]{32}$/u.test(k)), ...(dated.length ? ['bunny_dated_v2', ...dated] : [])];
}
function query(text, options = {}) {
  const n = normalize(text, options);
  return { text: n.canonical.replace(/那座城市|那个地方|这个项目|那个项目|那个人|这个人|那里|那天|那次|今天|昨天|明天|这个|那个/gu, ' '), references: n.references };
}
function temporaryExpiry(source) {
  return /^我(?:今天|这几天|最近).{0,20}(?:累|忙|开心|难过|疲惫|生病)/u.test(source?.value?.content || '') ? source.ts + 2 * 86400000 : null;
}
module.exports = { normalize, query, tokens, temporalTokens, temporaryExpiry, key, localDay, addDays };
