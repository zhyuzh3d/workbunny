'use strict';
// Text-stage wake gate: aliases are deliberately limited to the start of speech.
// '我把你写的东西…' must not wake Bunny just because it contains '把你'.
function hit(text, name = '', aliases = []) {
  const names = [String(name).trim(), ...aliases];
  if (['bunny','baby','bab'].includes(String(name).toLowerCase())) names.push('bunny','baby','巴尼','巴妮','邦妮','班尼','把你','伴你','贝比');
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/^[\s，,。.!！?？、:：]+/, '').replace(/^(?:(?:嘿|嗨|喂|你好|那个|请问)[\s，,。!！、]*){0,2}/, '');
  return [...new Set(names.filter(Boolean))].some(alias => {
    const value = alias.normalize('NFKC').toLowerCase();
    if (/^[a-z]+$/.test(value)) return new RegExp('^' + value + '(?![a-z])').test(normalized);
    return normalized.startsWith(value);
  });
}
module.exports = { hit };
