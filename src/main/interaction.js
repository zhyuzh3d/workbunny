'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicPrivate } = require('./vault-crypto');
const REACTIONS = {
  head: [{ text: '嗯？我在呢。', slot: 'greet', emo: 'happy' }, { text: '呵呵，好痒呀。', slot: 'shy', emo: 'happy' }, { text: '诶，摸摸就好啦。', slot: 'tease', emo: 'relaxed' }],
  upper: [{ text: '你好呀。', slot: 'greet', emo: 'happy' }, { text: '嗯呢，陪着你。', slot: 'thanks', emo: 'relaxed' }, { text: '哈哈，别闹啦。', slot: 'shy', emo: 'happy' }],
  lower: [{ text: '哎呦，轻一点嘛。', slot: 'surprise', emo: 'surprised' }, { text: '不要啦。', slot: 'refuse', emo: 'relaxed' }, { text: '诶，戳到我啦。', slot: 'tease', emo: 'surprised' }],
};
class Interactions {
  constructor({ clock = Date.now, random = Math.random } = {}) { this.clock = clock; this.random = random; this.last = -Infinity; this.lastText = ''; this.taps = []; }
  pick(region, { quiet = false } = {}) {
    if (!Object.hasOwn(REACTIONS, region)) return null;
    const now = this.clock(); if (now - this.last < 900) return null;
    this.taps = this.taps.filter(t => now - t < 8000); this.taps.push(now);
    const pool = REACTIONS[region].filter(r => r.text !== this.lastText);
    const selected = this.taps.length >= 5 ? { text: '让我歇一小下嘛。', slot: 'refuse', emo: 'relaxed' } : pool[Math.floor(this.random() * pool.length)];
    const sound = !quiet && now - this.last >= 6000; this.last = now; this.lastText = selected.text;
    return { ...selected, sound };
  }
}
class InteractionAudio {
  constructor(dir) { this.dir = dir; this.pending = new Map(); }
  async audio(text, config, generate) {
    const hash = crypto.createHash('sha256').update(JSON.stringify([config.avatar, config.tts, text])).digest('hex');
    if (this.pending.has(hash)) return this.pending.get(hash);
    const p = this.get(hash, generate); this.pending.set(hash, p);
    try { return await p; } finally { this.pending.delete(hash); }
  }
  async get(hash, generate) {
    const file = path.join(this.dir, hash + '.json');
    try {
      const st = await fs.promises.lstat(file);
      if (st.isFile() && !st.isSymbolicLink() && st.size < 2 * 1024 * 1024 && Date.now() - st.mtimeMs < 30 * 86400000) {
        const r = JSON.parse(await fs.promises.readFile(file, 'utf8')), buffer = Buffer.from(r.buffer, 'base64');
        if (buffer.toString('ascii', 0, 4) === 'RIFF') return { ...r, buffer, cached: true, ms: 0, streamed: false };
      }
    } catch {}
    const r = await generate();
    if (!r.degraded && r.buffer.length < 1024 * 1024) {
      atomicPrivate(file, JSON.stringify({ buffer: r.buffer.toString('base64'), engine: r.engine, voice: r.voice }));
      const all = await fs.promises.readdir(this.dir);
      if (all.length > 64) {
        const stats = await Promise.all(all.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(async f => ({ file: f, ts: (await fs.promises.stat(path.join(this.dir, f))).mtimeMs })));
        for (const old of stats.sort((a, b) => a.ts - b.ts).slice(0, Math.max(0, stats.length - 64))) await fs.promises.unlink(path.join(this.dir, old.file));
      }
    }
    return r;
  }
}
module.exports = { Interactions, InteractionAudio, REACTIONS };
