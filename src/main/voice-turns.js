'use strict';
const { randomUUID } = require('node:crypto');
// One speculative request per stable revision. ASR finals refine segments;
// they do not restart the pause clock or create a second model request.
function createVoiceTurns({ onRequest, onInvalidate, onRemember, onLive = () => {}, onError = () => {},
  pauseMs = 1000, turnMs = 3000, finalWaitMs = 8000,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, sessionId = randomUUID() }) {
  let current = null, serial = 0, requestTimer, sealTimer, confirmationTimer;
  const canonical = s => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const contentKey = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[。.!?！？]+$/u, '').trim();
  const textOf = t => [...t.segments, t.partial].filter(Boolean).join('\n');
  function remember(t) {
    if (!t || t.skipped) return;
    if (t.remembered) return t.receipt;
    const text = textOf(t);
    if (canonical(text).length < 2) return;
    t.remembered = true;
    // The final punctuation may differ from the speculative request. A stable
    // turn identity and the actual write receipt link replies to that final.
    t.receipt = onRemember(text, { turnId: `${sessionId}:${t.id}`, heardAt: t.lastActivity });
    return t.receipt;
  }
  function invalidate(t = current) {
    if (!t?.request || !t.request.valid) return;
    t.request.valid = false; t.request.release(false); onInvalidate();
    t.request = null;
  }
  function clearTimers() { clearTimer(requestTimer); clearTimer(sealTimer); clearTimer(confirmationTimer); }
  function unconfirmed(reason) {
    if (!current || current.finalized) return;
    const meaningful = canonical(textOf(current)).length >= 2;
    reset(); onLive('', { final: false, pending: false });
    if (meaningful) onError(reason);
  }
  function fresh(at) { return { id: ++serial, segments: [], partial: '', finalized: false,
    lastActivity: at, remembered: false, skipped: false, request: null }; }
  function touch(at) {
    if (current && at - current.lastActivity >= turnMs) {
      remember(current); invalidate(); current = null;
    } else invalidate();
    if (!current) current = fresh(at);
    current.lastActivity = at; current.skipped = false;
    schedule();
  }
  function schedule() {
    clearTimers();
    if (!current) return;
    const t = current;
    requestTimer = setTimer(() => {
      if (current !== t) return;
      const text = textOf(t);
      if (canonical(text).length < 2 || t.request) return;
      let release;
      const settled = new Promise(r => { release = r; });
      const token = { valid: true, release, text, id: t.id, turnId: `${sessionId}:${t.id}`, heardAt: t.lastActivity,
        isCurrent: () => current === t && token.valid,
        waitForCommit: () => settled,
        remember: () => { if (token.isCurrent()) return remember(t); },
        skip: () => { if (token.isCurrent()) t.skipped = true; },
      };
      t.request = token;
      if (t.finalized && now() - t.lastActivity >= turnMs) release(true);
      if (!t.finalized) confirmationTimer = setTimer(() => {
        if (current === t && t.request === token) unconfirmed('系统识别未能确认这句话，请再说一次。');
      }, finalWaitMs);
      // The owner handles its errors; the coordinator never leaves an unhandled promise.
      Promise.resolve(onRequest(token)).catch(() => {});
    }, Math.max(0, t.lastActivity + pauseMs - now()));
    sealTimer = setTimer(() => { if (current === t && t.finalized) t.request?.release(true); }, Math.max(0, t.lastActivity + turnMs - now()));
  }
  function partial(raw) {
    const text = String(raw || '').trim();
    if (!text || text === current?.partial) return;
    if (current?.partial && contentKey(text) === contentKey(current.partial)) {
      current.partial = text;
      onLive(textOf(current), { final: false, pending: !!current.request });
      return;
    }
    touch(now()); current.partial = text; current.finalized = false;
    onLive(textOf(current), { final: false, pending: !!current.request }); schedule();
  }
  function final(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    if (current?.finalized && contentKey(current.segments.at(-1)) === contentKey(text)) return;
    if (current && !current.partial && now() - current.lastActivity >= turnMs) {
      remember(current); invalidate(); current = null;
    }
    if (!current) current = fresh(now());
    // A final that only adds punctuation confirms the already requested words.
    const changed = contentKey(text) !== contentKey(current.partial);
    if (changed && current.request) invalidate();
    if (current.segments.at(-1) !== text || current.partial) current.segments.push(text);
    current.partial = ''; current.finalized = true;
    onLive(textOf(current), { final: true, pending: !!current.request }); schedule();
  }
  // Meter amplitude is not a speech detector. Only ASR text revises the turn.
  function reset() { clearTimers(); invalidate(); current = null; }
  return { partial, final, reset,
    recognizerStopped: () => unconfirmed('语音识别中断，这句话尚未确认，请再说一次。'),
    snapshot: () => current ? { text: textOf(current), id: current.id,
    requested: !!current.request, silenceMs: now() - current.lastActivity } : null };
}
module.exports = { createVoiceTurns };
