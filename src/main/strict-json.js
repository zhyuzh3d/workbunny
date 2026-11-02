'use strict';
function stringEnd(source, start) {
  if (source[start] !== '"') return -1;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (c === '"') return i + 1;
    if (c === '\\') { i++; if (i >= source.length) return -1; }
    else if (c.charCodeAt(0) < 0x20) return -2;
  }
  return -1;
}

// A small strict JSON parser is used at flush so duplicate keys cannot be
// silently collapsed by JSON.parse before the action schema is checked.
function parseStrictJson(source) {
  let i = 0;
  const ws = () => { while (/\s/u.test(source[i] || '\0')) i++; };
  const string = () => {
    const end = stringEnd(source, i);
    if (end < 0) throw new Error('JSON字符串无效或不完整');
    const value = JSON.parse(source.slice(i, end)); i = end; return value;
  };
  const value = () => {
    ws();
    if (source[i] === '"') return string();
    if (source[i] === '{') {
      i++; ws(); const out = Object.create(null), keys = new Set();
      if (source[i] === '}') { i++; return out; }
      while (i < source.length) {
        ws(); if (source[i] !== '"') throw new Error('JSON对象键无效');
        const key = string(); if (keys.has(key)) throw new Error(`JSON含重复字段: ${key}`); keys.add(key);
        ws(); if (source[i++] !== ':') throw new Error('JSON对象缺少冒号');
        out[key] = value(); ws();
        const c = source[i++]; if (c === '}') return out; if (c !== ',') throw new Error('JSON对象分隔符无效');
      }
      throw new Error('JSON对象被截断');
    }
    if (source[i] === '[') {
      i++; ws(); const out = [];
      if (source[i] === ']') { i++; return out; }
      while (i < source.length) {
        out.push(value()); ws();
        const c = source[i++]; if (c === ']') return out; if (c !== ',') throw new Error('JSON数组分隔符无效');
      }
      throw new Error('JSON数组被截断');
    }
    const rest = source.slice(i);
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(rest);
    if (!match) throw new Error('JSON值无效');
    i += match[0].length;
    if (match[0] === 'true') return true;
    if (match[0] === 'false') return false;
    if (match[0] === 'null') return null;
    return Number(match[0]);
  };
  const result = value(); ws();
  if (i !== source.length) throw new Error('JSON后存在额外内容');
  return result;
}

module.exports = { parseStrictJson, stringEnd };
