'use strict';

const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function resembles(text, reference) {
  const a = clean(text), b = clean(reference);
  if (a.length < 2 || b.length < 2) return false;
  if (b.includes(a)) return true;
  if (a.length < 4 || a.length > 240) return false;
  // Bounded semiglobal alignment tolerates recognition substitutions without
  // deleting the start of a long spoken sentence or joining unrelated replies.
  const limit = Math.min(3, Math.floor(a.length / 4));
  let previous = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint16Array(b.length + 1); row[0] = i;
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous.some(distance => distance <= limit);
}

class SpeechEcho {
  constructor({ now = Date.now, tailMs = 3000 } = {}) { this.now = now; this.tailMs = tailMs; this.rows = []; }
  prepare(id, text) {
    this.rows = this.rows.filter(row => this.now() - (row.endedAt ?? this.now()) < 60000 && row.id !== id).slice(-31);
    this.rows.push({ id, text: String(text || '').slice(0, 6000), startedAt: null, endedAt: null });
  }
  start(id) {
    const row = this.rows.find(row => row.id === id);
    if (!row || row.endedAt !== null || row.startedAt !== null) return false;
    row.startedAt = this.now(); return true;
  }
  end(id) {
    const row = this.rows.find(row => row.id === id);
    if (!row || row.endedAt !== null) return null;
    row.endedAt = this.now();
    return row.startedAt === null ? null : { elapsedMs: row.endedAt - row.startedAt };
  }
  matches(text, metadata = {}) {
    const start = metadata?.audioStartAtMs, end = metadata?.audioEndAtMs;
    const ranged = Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= this.now() + 250;
    const eligible = this.rows.filter(row => {
      if (row.startedAt === null) return false;
      const until = row.endedAt === null ? this.now() : row.endedAt + this.tailMs;
      // A recognizer may deliver its final well after the loudspeaker stopped.
      // Prefer actual capture overlap; callback arrival time is only fallback.
      const overlaps = ranged ? end >= row.startedAt && start <= until : this.now() <= until;
      return overlaps;
    });
    let group = '', previous = null, alignmentBudget = 1500000;
    const normalized = clean(text);
    const compare = reference => {
      const value = clean(reference);
      if (normalized.length >= 2 && value.includes(normalized)) return true;
      const cost = normalized.length * value.length;
      if (normalized.length < 4 || normalized.length > 240 || cost > alignmentBudget) return false;
      alignmentBudget -= cost; return resembles(normalized, value);
    };
    for (const row of eligible) {
      if (compare(row.text)) return true;
      // Continuous queued sentences belong to one acoustic utterance. Join
      // only actually played, adjacent audio; an unplayed queue is no evidence.
      group = previous && previous.endedAt !== null && row.startedAt - previous.endedAt <= 1200 ? group + row.text : row.text;
      if (group.length > 18000) group = row.text;
      if (group !== row.text && compare(group)) return true;
      previous = row;
    }
    return false;
  }
}
module.exports = { SpeechEcho, resembles };
