'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicPrivate } = require('./vault-crypto');
const { validateWav } = require('./chp-tts');
const REACTIONS = {
  head: [{ text: '嗯？我在呢。', slot: 'greet', emo: 'happy' }, { text: '呵呵，好痒呀。', slot: 'shy', emo: 'happy' }, { text: '诶，摸摸就好啦。', slot: 'tease', emo: 'relaxed' }],
  upper: [{ text: '你好呀。', slot: 'greet', emo: 'happy' }, { text: '嗯呢，陪着你。', slot: 'thanks', emo: 'relaxed' }, { text: '哈哈，别闹啦。', slot: 'shy', emo: 'happy' }],
  lower: [{ text: '哎呦，轻一点嘛。', slot: 'surprise', emo: 'surprised' }, { text: '不要啦。', slot: 'refuse', emo: 'relaxed' }, { text: '诶，戳到我啦。', slot: 'tease', emo: 'surprised' }],
};
class Interactions {
  constructor({ clock = Date.now, random = Math.random } = {}) { this.clock = clock; this.random = random; this.last = -Infinity; this.lastText = ''; this.taps = []; this.lastMotion = ''; }
  pick(region, { quiet = false, motions } = {}) {
    if (!Object.hasOwn(REACTIONS, region)) return null;
    const now = this.clock(); if (now - this.last < 900) return null;
    this.taps = this.taps.filter(t => now - t < 8000); this.taps.push(now);
    const eligible = motions?.length ? REACTIONS[region].filter(r => motions.some(m => m.slot === r.slot)) : REACTIONS[region];
    const choices = eligible.length ? eligible : REACTIONS[region];
    const fresh = choices.filter(r => r.text !== this.lastText);
    const pool = fresh.length ? fresh : choices;
    const selected = this.taps.length >= 5 ? { text: '让我歇一小下嘛。', slot: 'refuse', emo: 'relaxed' } : pool[Math.floor(this.random() * pool.length)];
    // The 900 ms debounce above throttles the whole reaction. An accepted tap
    // must not show a spoken phrase while silently skipping its speech queue.
    const sound = !quiet; this.last = now; this.lastText = selected.text;
    let slotMotions = (motions || []).filter(m => m.slot === selected.slot);
    if (!slotMotions.length) slotMotions = (motions || []).filter(m => m.slot === 'idle');
    const alternatives = slotMotions.filter(m => m.key !== this.lastMotion);
    const available = alternatives.length ? alternatives : slotMotions;
    const motion = available.length ? available[Math.floor(this.random() * available.length)].key : selected.slot;
    this.lastMotion = motion;
    // A concrete action has a stable phrase across body regions and restarts.
    // Replaying the same action/model/voice therefore never needs a new phrase.
    const phrases = Object.values(REACTIONS).flat().filter(r => r.slot === selected.slot);
    const phrase = available.length && phrases.length ? phrases[crypto.createHash('sha256').update(motion).digest().readUInt32BE(0) % phrases.length] : selected;
    this.lastText = phrase.text;
    return { ...phrase, sound, motion };
  }
}
class InteractionAudio {
  constructor(dir, { maxBytes = 128 * 1024 * 1024, maxEntries = 1024 } = {}) {
    this.dir = dir; this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.pending = new Map();
  }
  async audio(action, text, voiceProfile, generate) {
    // Only the active synthesis model/voice and audible settings belong here.
    // Appearance, API keys and unrelated engine settings never invalidate audio.
    if (!voiceProfile) return generate();
    const hash = crypto.createHash('sha256').update(JSON.stringify(['interaction-audio/v2', action, voiceProfile, text])).digest('hex');
    if (this.pending.has(hash)) return this.pending.get(hash);
    const p = this.get(hash, generate); this.pending.set(hash, p);
    try { return await p; } finally { this.pending.delete(hash); }
  }
  async get(hash, generate) {
    const file = path.join(this.dir, hash + '.json');
    try {
      const st = await fs.promises.lstat(file);
      if (st.isFile() && !st.isSymbolicLink() && st.size < 4 * 1024 * 1024) {
        const r = JSON.parse(await fs.promises.readFile(file, 'utf8')), buffer = Buffer.from(r.buffer, 'base64');
        if (r.version === 2 && r.key === hash) {
          validateWav(buffer);
          const now = new Date(); await fs.promises.utimes(file, now, now).catch(() => {});
          return { buffer, engine: r.engine, voice: r.voice, cached: true, ms: 0, streamed: false };
        }
      }
    } catch {}
    const r = await generate();
    if (!r.degraded && Buffer.isBuffer(r.buffer) && r.buffer.length < 2 * 1024 * 1024) {
      try {
        validateWav(r.buffer);
        atomicPrivate(file, JSON.stringify({ version: 2, key: hash, buffer: r.buffer.toString('base64'), engine: r.engine, voice: r.voice }));
        await this.prune();
      } catch { /* A cache write failure must not suppress freshly generated speech. */ }
    }
    return r;
  }
  async prune() {
    const names = (await fs.promises.readdir(this.dir)).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    const files = (await Promise.all(names.map(async name => {
      const stat = await fs.promises.lstat(path.join(this.dir, name));
      return { name, size: stat.size, ts: stat.mtimeMs, regular: stat.isFile() && !stat.isSymbolicLink() };
    }))).filter(f => f.regular).sort((a, b) => a.ts - b.ts);
    let bytes = files.reduce((n, f) => n + f.size, 0), count = files.length;
    for (const file of files) {
      if (bytes <= this.maxBytes && count <= this.maxEntries) break;
      await fs.promises.unlink(path.join(this.dir, file.name)); bytes -= file.size; count--;
    }
  }
}
module.exports = { Interactions, InteractionAudio, REACTIONS };
