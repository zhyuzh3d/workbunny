'use strict';
const SPEAKERS = [
  { id: 'serena', label: 'Serena · 温柔女声', language: 'zh' },
  { id: 'vivian', label: 'Vivian · 明亮女声', language: 'zh' },
  { id: 'uncle_fu', label: 'Uncle Fu · 沉稳男声', language: 'zh' },
  { id: 'dylan', label: 'Dylan · 北京男声', language: 'zh' },
  { id: 'eric', label: 'Eric · 四川男声', language: 'zh' },
  { id: 'ryan', label: 'Ryan · 英语男声', language: 'en' },
  { id: 'aiden', label: 'Aiden · 美式男声', language: 'en' },
  { id: 'ono_anna', label: 'Ono Anna · 日语女声', language: 'ja' },
  { id: 'sohee', label: 'Sohee · 韩语女声', language: 'ko' },
];
function normalize(q = {}) {
  const custom = q.modelKind === 'customvoice';
  return { ...q, modelKind: 'customvoice', voice: SPEAKERS.some((v) => v.id === q.voice) ? q.voice : 'serena',
    dir: custom ? q.dir || '' : '', ready: custom && !!q.ready,
    streaming: custom && !!q.streaming, activeTrack: null };
}
module.exports = { SPEAKERS, normalize };
