'use strict';
const { randomUUID } = require('node:crypto');
function meaningful(text, allowShort = false) {
  const words = String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return words.length >= 2 || allowShort && /^(?:嗯|好|对|是|不|行|哦|唔|啊)$/u.test(words);
}
// Text revisions and acoustic activity have separate clocks. Partial text is
// display-only; a request starts only after a confirmed, acoustically quiet seal.
function createVoiceTurns({ onRequest, onInvalidate, onRemember, onLive = () => {}, onError = () => {}, onTrace = null,
  pauseMs = 1000, turnMs = 3000, finalWaitMs = 8000, requireActivity = false, activityFreshMs = 500,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, sessionId = randomUUID(), allowShort = () => false }) {
  let current = null, serial = 0, requestTimer, confirmationTimer, activityTimer, latestActivity = null, rejectedPartialKey = null;
  const reasons = { none: 0, text: 1, reset: 2, epoch: 3, stopped: 4, confirmation: 5, commit: 6, next: 7, active: 8, unknown: 9, stale: 10, completed: 11 };
  const contentKey = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[。.!?！？]+$/u, '').trim();
  const textOf = t => [...t.segments, t.partial].filter(Boolean).join('\n');
  const activityRequired = () => { try { return typeof requireActivity === 'function' ? requireActivity() === true : requireActivity === true; } catch { return true; } };
  const accepted = t => !!t?.request?.valid;
  const commitReady = t => current === t && !!t?.finalized && !t.awaitingAudioFinal && quiet();
  const trace = (stage, t = current, reasonCode = reasons.none) => { if (typeof onTrace !== 'function') return; try {
    const acoustic = latestActivity ? { activityAgeMs: Math.max(0, now() - latestActivity.at), activitySeq: latestActivity.seq, sourceGen: latestActivity.sourceGen, quietSeconds: latestActivity.quietSeconds } : {};
    for (const key of Object.keys(acoustic)) if (!Number.isFinite(acoustic[key])) delete acoustic[key];
    onTrace({ stage, turn: t?.id || 0, segments: t?.segments.length || 0, partialChars: t?.partial.length || 0, chars: t ? textOf(t).length : 0, finalized: !!t?.finalized, requested: accepted(t), accepted: accepted(t), commitReady: accepted(t) && commitReady(t), waitingAudio: !!t?.awaitingAudioFinal, gateClosedMs: t?.gateClosedAt == null ? 0 : Math.max(0, now() - t.gateClosedAt), reasonCode, remembered: !!t?.remembered, skipped: !!t?.skipped, ...acoustic });
  } catch {} };
  const boundaryAt = t => Math.max(t.lastTextAt, t.lastAudioActiveAt ?? t.lastTextAt);
  const quiet = () => !activityRequired() || !!latestActivity && latestActivity.state === 'quiet' &&
    now() >= latestActivity.at && now() - latestActivity.at <= activityFreshMs && latestActivity.quietSeconds >= pauseMs / 1000;
  const ready = t => current === t && t.finalized && !t.awaitingAudioFinal && now() - boundaryAt(t) >= turnMs && quiet();
  function remember(t) {
    if (!t || t.skipped) return;
    if (t.remembered) return t.receipt;
    if (!accepted(t) || !commitReady(t) || !meaningful(textOf(t), allowShort())) return;
    t.remembered = true; trace('turn-remember', t);
    t.receipt = onRemember(textOf(t), { turnId: `${sessionId}:${t.id}`, heardAt: t.lastTextAt });
    return t.receipt;
  }
  function clearGate(t) { if (!t) return; clearTimer(t.gateTimer); t.gateClosedAt = null; }
  function settle(token, value) { for (const resolve of [...token.waiters]) resolve(value); }
  function invalidate(t = current, reasonCode = reasons.reset) {
    if (!t?.request || !t.request.valid) return;
    const token = t.request; token.valid = false; clearGate(t); settle(token, false); onInvalidate();
    trace('turn-invalidated', t, reasonCode); t.request = null;
  }
  function clearTurnTimers() { clearTimer(requestTimer); clearTimer(confirmationTimer); }
  function complete(t, token) {
    if (!token.isCurrent()) return false;
    token.valid = false; token.completed = true; clearGate(t); settle(token, false);
    clearTurnTimers(); clearTimer(activityTimer); t.request = null; current = null; rejectedPartialKey = null;
    // The caller has confirmed its final effects. Their own lifecycles now
    // own TTS/Task cancellation; retiring this input must not abort them.
    trace('turn-completed', t, reasons.completed); return true;
  }
  function reset(reasonCode = reasons.reset) { trace('turn-reset', current, reasonCode); clearTurnTimers(); clearTimer(activityTimer); invalidate(current, reasonCode); clearGate(current); current = null; rejectedPartialKey = null;
    if (latestActivity) latestActivity = { ...latestActivity, state: 'unknown', quietSeconds: 0, at: now() };
  }
  function unconfirmed(message, reason, reasonCode) {
    if (!current) return;
    const text = textOf(current), hasWords = meaningful(text, allowShort()), rejected = contentKey(current.partial || current.segments.at(-1));
    const metadata = { reason, turn: current.id, turnId: `${sessionId}:${current.id}`,
      admitted: accepted(current), awaitingAudioFinal: current.awaitingAudioFinal, finalized: current.finalized,
      partialChars: current.partial.length, segments: current.segments.length, chars: text.length,
      lastTextAt: current.lastTextAt, recognizer: latestActivity?.recognizer ?? null, sourceGen: latestActivity?.sourceGen ?? null };
    trace('turn-unconfirmed', current, reasonCode); reset(reasonCode); onLive('', { final: false, pending: false });
    rejectedPartialKey = rejected;
    if (hasWords) onError(message, metadata);
  }
  function fresh(at) { return { id: ++serial, segments: [], partial: '', finalized: false, awaitingAudioFinal: false,
    lastTextAt: at, lastAudioActiveAt: null, remembered: false, skipped: false, request: null, gateClosedAt: null, gateTimer: null }; }
  function updateGate(t, reasonCode = reasons.none) {
    if (!accepted(t)) return;
    if (commitReady(t)) {
      const wasClosed = t.gateClosedAt != null; clearGate(t);
      if (wasClosed) trace('turn-gate-ready', t);
      settle(t.request, true); return;
    }
    if (t.gateClosedAt != null) return;
    t.gateClosedAt = now(); trace('turn-gate-closed', t, reasonCode);
    const token = t.request;
    t.gateTimer = setTimer(() => {
      if (current !== t || t.request !== token || !token.valid) return;
      if (commitReady(t)) { updateGate(t); return; }
      unconfirmed('前句已经确认，但后续声音或音频状态尚未确认；待提交操作尚未执行，已暂停本轮，请完整重说或输入文字。', 'commit-timeout', reasons.commit);
    }, finalWaitMs);
  }
  function schedule() {
    clearTurnTimers();
    if (!current) return;
    const t = current;
    if (accepted(t)) { updateGate(t); return; }
    if (!t.request) confirmationTimer = setTimer(() => {
      if (current === t && !t.request) unconfirmed('这段语音尚未确认，未提交交办；请完整重说，或直接输入文字。', 'confirmation-timeout', reasons.confirmation);
    }, Math.max(0, t.lastTextAt + finalWaitMs - now()));
    if (!t.finalized || t.awaitingAudioFinal || t.request || !meaningful(textOf(t), allowShort()) || !quiet()) return;
    requestTimer = setTimer(() => {
      if (!ready(t) || t.request) return;
      clearTimer(confirmationTimer);
      const token = { accepted: true, valid: true, completed: false, waiters: new Set(), text: textOf(t), id: t.id, turnId: `${sessionId}:${t.id}`, heardAt: t.lastTextAt,
        isCurrent: () => current === t && t.request === token && token.valid,
        canCommit: () => token.isCurrent() && commitReady(t),
        waitForCommit: ({ signal } = {}) => {
          if (!token.isCurrent() || signal?.aborted) return Promise.resolve(false);
          updateGate(t);
          if (token.canCommit()) return Promise.resolve(true);
          return new Promise(resolve => {
            const finish = value => { token.waiters.delete(finish); signal?.removeEventListener('abort', aborted); resolve(value && token.canCommit()); };
            const aborted = () => finish(false); token.waiters.add(finish); signal?.addEventListener('abort', aborted, { once: true });
          });
        },
        remember: () => { if (token.canCommit()) return remember(t); },
        skip: () => { if (token.isCurrent()) t.skipped = true; },
        complete: () => complete(t, token) };
      t.request = token; trace('turn-request', t);
      // Semantic admission is stable across raw acoustic uncertainty. Effects
      // must independently wait for and recheck canCommit at their boundary.
      try { if (token.isCurrent()) Promise.resolve(onRequest(token)).catch(() => {}); } catch {}
    }, Math.max(0, boundaryAt(t) + turnMs - now()));
  }
  function partial(raw) {
    const text = String(raw || '').trim();
    if (!text || !current && contentKey(text) === rejectedPartialKey || text === current?.partial) return;
    rejectedPartialKey = null;
    if (current?.partial && contentKey(text) === contentKey(current.partial)) {
      current.partial = text; onLive(textOf(current), { final: false, pending: !!current.request }); return;
    }
    if (current?.remembered || current?.skipped) { invalidate(current, reasons.next); current = null; }
    else invalidate(current, reasons.text);
    if (!current) current = fresh(now());
    current.partial = text; current.finalized = false; current.lastTextAt = now(); current.skipped = false;
    trace('turn-partial'); onLive(textOf(current), { final: false, pending: false }); schedule();
  }
  function final(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    rejectedPartialKey = null;
    if (current?.finalized && !current.partial && contentKey(current.segments.at(-1)) === contentKey(text)) {
      if (current.awaitingAudioFinal) { current.awaitingAudioFinal = false; trace('turn-final'); onLive(textOf(current), { final: true, pending: accepted(current) }); schedule(); }
      return;
    }
    if (current?.remembered || current?.skipped) { invalidate(current, reasons.next); current = null; }
    if (!current) current = fresh(now());
    const changed = contentKey(text) !== contentKey(current.partial || current.segments.at(-1));
    if (changed || current.partial) invalidate(current, reasons.text);
    if (changed) current.lastTextAt = now();
    if (current.segments.at(-1) !== text || current.partial) current.segments.push(text);
    current.partial = ''; current.finalized = true; current.awaitingAudioFinal = false;
    trace('turn-final'); onLive(textOf(current), { final: true, pending: !!current.request }); schedule();
  }
  function activity(meta) {
    const clock = now();
    if (!meta || !['unknown', 'active', 'quiet'].includes(meta.state) ||
      !['seq', 'recognizer', 'sourceGen'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0)) return false;
    if (latestActivity && (meta.recognizer < latestActivity.recognizer || meta.recognizer === latestActivity.recognizer &&
      (meta.seq <= latestActivity.seq || meta.sourceGen < latestActivity.sourceGen))) return false;
    if (latestActivity && meta.recognizer > latestActivity.recognizer) {
      if (accepted(current) || current && (!current.finalized || current.awaitingAudioFinal)) unconfirmed('语音识别已重新连接，本轮已暂停，请完整重说或输入文字。', 'recognizer-changed', reasons.epoch);
      latestActivity = null; rejectedPartialKey = null;
    }
    if (latestActivity && Number.isFinite(meta.at) && meta.at < latestActivity.at) return false;
    const valid = Number.isFinite(meta.at) && meta.at >= 0 && meta.at <= clock && Number.isFinite(meta.quietSeconds) && meta.quietSeconds >= 0;
    const next = { state: valid ? meta.state : 'unknown', quietSeconds: valid ? meta.quietSeconds : 0,
      at: valid ? meta.at : clock, seq: meta.seq, recognizer: meta.recognizer, sourceGen: meta.sourceGen };
    if (latestActivity && next.sourceGen > latestActivity.sourceGen) rejectedPartialKey = null;
    latestActivity = next; clearTimer(activityTimer);
    if (current && next.state === 'active') {
      current.lastAudioActiveAt = clock; current.awaitingAudioFinal = true;
    }
    if (accepted(current)) updateGate(current, next.state === 'active' ? reasons.active : next.state === 'unknown' ? reasons.unknown : reasons.stale);
    activityTimer = setTimer(() => {
      if (latestActivity !== next || !activityRequired()) return;
      updateGate(current, reasons.stale); schedule();
    }, Math.max(0, next.at + activityFreshMs + 1 - clock));
    schedule(); return valid;
  }
  return { partial, final, activity, reset,
    recognizerStopped: ({ graceful = false } = {}) => {
      if (!current) return;
      if (graceful && !accepted(current) && current.finalized && !current.awaitingAudioFinal) {
        if (latestActivity) latestActivity = { ...latestActivity, state: 'unknown', quietSeconds: 0, at: now() };
        schedule(); return;
      }
      if (accepted(current) || !current.finalized || current.awaitingAudioFinal || activityRequired()) unconfirmed('语音识别中断，本轮已暂停，请完整重说或输入文字。', 'recognizer-stopped', reasons.stopped);
    },
    snapshot: () => current ? { text: textOf(current), id: current.id, requested: !!current.request,
      finalized: current.finalized, awaitingAudioFinal: current.awaitingAudioFinal, accepted: accepted(current), commitReady: accepted(current) && commitReady(current), waitingAudio: current.awaitingAudioFinal,
      gateClosedMs: current.gateClosedAt == null ? 0 : Math.max(0, now() - current.gateClosedAt),
      silenceMs: now() - boundaryAt(current), lastTextAt: current.lastTextAt, lastAudioActiveAt: current.lastAudioActiveAt } : null };
}
module.exports = { createVoiceTurns, meaningful };
