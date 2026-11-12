'use strict';
const { randomUUID } = require('node:crypto');
function meaningful(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ''));
}
// Text revisions and acoustic activity have separate clocks. Partial text is
// display-only; a request starts only after a confirmed, acoustically quiet seal.
function createVoiceTurns({ onRequest, onInvalidate, onRemember, onLive = () => {}, onError = () => {}, onTrace = null,
  onCheckpoint = null,
  pauseMs = 350, turnMs = 350, finalWaitMs = 8000, requireActivity = false, activityFreshMs = 500,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, sessionId = randomUUID(),
  deferRecognition = false }) {
  let current = null, retained = null, serial = 0, requestTimer, confirmationTimer, checkpointTimer, activityTimer, latestActivity = null, rejectedPartialKey = null, finalizedSource = null;
  const reasons = { none: 0, text: 1, reset: 2, epoch: 3, stopped: 4, confirmation: 5, commit: 6, next: 7, active: 8, unknown: 9, stale: 10, completed: 11, acoustic: 12, ineligible: 13 };
  const contentKey = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[。.!?！？]+$/u, '').trim();
  const audioSource = meta => meta && ['recognizer','sourceGen'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0)
    ? {recognizer:meta.recognizer,sourceGen:meta.sourceGen} : null;
  const sameSource = (a,b) => a && b ? a.recognizer === b.recognizer && a.sourceGen === b.sourceGen : !a && !b;
  const recordAudio = (t, meta) => {
    if (!meta || !Number.isFinite(meta.audioStartAtMs) || !Number.isFinite(meta.audioEndAtMs) || meta.audioEndAtMs < meta.audioStartAtMs) return;
    t.audioStartAtMs = Math.min(t.audioStartAtMs ?? Infinity, meta.audioStartAtMs);
    t.audioEndAtMs = Math.max(t.audioEndAtMs ?? -Infinity, meta.audioEndAtMs);
  };
  const textOf = t => [...t.segments, t.partial].filter(Boolean).join('\n');
  const activityRequired = () => { try { return typeof requireActivity === 'function' ? requireActivity() === true : requireActivity === true; } catch { return true; } };
  const accepted = t => !!t?.request?.valid;
  const owns = t => current === t || retained === t;
  const blocksRetained=()=>current&&!current.skipped&&!(current.request?.semanticAccepted&&current.request.turnDisposition==='keep');
  const commitReady = t => owns(t) && !!t?.finalized && !t.awaitingAudioFinal && quiet() &&
    !(deferRecognition && retained === t && blocksRetained());
  const live = (t, phase, text = t ? textOf(t) : '') => onLive(text, { turn: t?.id || 0, turnId: t ? `${sessionId}:${t.id}` : null,
    phase, final: !!t?.finalized, pending: accepted(t) && (!deferRecognition || t.request.semanticAccepted) });
  const trace = (stage, t = current, reasonCode = reasons.none) => { if (typeof onTrace !== 'function') return; try {
    const acoustic = latestActivity ? { activityAgeMs: Math.max(0, now() - latestActivity.at), activitySeq: latestActivity.seq, sourceGen: latestActivity.sourceGen, quietSeconds: latestActivity.quietSeconds } : {};
    for (const key of Object.keys(acoustic)) if (!Number.isFinite(acoustic[key])) delete acoustic[key];
    onTrace({ stage, turn: t?.id || 0, segments: t?.segments.length || 0, partialChars: t?.partial.length || 0, chars: t ? textOf(t).length : 0, finalized: !!t?.finalized, requested: accepted(t), accepted: accepted(t), commitReady: accepted(t) && commitReady(t), waitingAudio: !!t?.awaitingAudioFinal, gateClosedMs: t?.gateClosedAt == null ? 0 : Math.max(0, now() - t.gateClosedAt), reasonCode, remembered: !!t?.remembered, skipped: !!t?.skipped, ...acoustic });
  } catch {} };
  const boundaryAt = t => Math.max(t.lastTextAt, t.lastAudioActiveAt ?? t.lastTextAt);
  const quiet = () => !activityRequired() || !!latestActivity && latestActivity.state === 'quiet' &&
    now() >= latestActivity.at && now() - latestActivity.at <= activityFreshMs && latestActivity.quietSeconds >= pauseMs / 1000;
  const ready = t => current === t && t.finalized && !t.awaitingAudioFinal && now() - boundaryAt(t) >= turnMs && quiet();
  function remember(t, conversation = false) {
    if (!t || t.skipped) return;
    if (t.remembered) return t.receipt;
    if (!accepted(t) || !owns(t) || deferRecognition && !t.request.semanticAccepted || !t.finalized || (!conversation && !commitReady(t)) || !meaningful(textOf(t))) return;
    t.remembered = true; trace('turn-remember', t);
    t.receipt = onRemember(textOf(t), { turnId: `${sessionId}:${t.id}`, heardAt: t.lastTextAt,audioEndAtMs:t.audioEndAtMs,
      ...(typeof t.observation?.configuredNameMatch === 'boolean' ? {asrNameMatch:t.observation.configuredNameMatch} : {}) });
    return t.receipt;
  }
  function clearGate(t) { if (!t) return; clearTimer(t.gateTimer); t.gateTimer = null; t.gateClosedAt = null; }
  function settle(token, value) { for (const resolve of [...token.waiters]) resolve(value); }
  function invalidate(t = current, reasonCode = reasons.reset) {
    if (!t?.request || !t.request.valid) return;
    const token = t.request; token.valid = false; clearGate(t); settle(token, false); if(retained===t)retained=null;onInvalidate(token);
    trace('turn-invalidated', t, reasonCode); t.request = null;
  }
  function clearTurnTimers() { clearTimer(requestTimer); clearTimer(confirmationTimer); clearTimer(checkpointTimer); }
  function complete(t, token) {
    if (!token.isCurrent()) return false;
    const wasCurrent = current === t;
    token.valid = false; token.completed = true; clearGate(t); settle(token, false);
    t.request = null;
    if(wasCurrent){clearTurnTimers();current=null;rejectedPartialKey=null;}else if(retained===t)retained=null;
    if(!current&&!retained)clearTimer(activityTimer);
    // The caller has finished the response/effect boundary. Its lifecycles now
    // own TTS/Task cancellation; retiring this input must not abort them.
    trace('turn-completed', t, reasons.completed); if(wasCurrent)live(t, 'completed', '');if(retained)updateGate(retained);return true;
  }
  function reset(reasonCode = reasons.reset) { const t = current, old=retained; trace('turn-reset', current, reasonCode); clearTurnTimers(); clearTimer(activityTimer); invalidate(current, reasonCode);invalidate(old,reasonCode); clearGate(current);current = null;retained=null; rejectedPartialKey = null;
    if (latestActivity) latestActivity = { ...latestActivity, state: 'unknown', quietSeconds: 0, at: now() };
    live(t, 'reset', '');
  }
  function unconfirmed(message, reason, reasonCode, t = current) {
    if (!t) return;
    const wasCurrent=current===t,text = textOf(t), hasWords = meaningful(text), rejected = contentKey(t.partial || t.segments.at(-1));
    const metadata = { reason, turn: t.id, turnId: `${sessionId}:${t.id}`,
      admitted: accepted(t), effectWaiting: t.request?.commitRequested === true && t.request?.semanticAccepted === true,
      awaitingAudioFinal: t.awaitingAudioFinal, finalized: t.finalized,
      partialChars: t.partial.length, segments: t.segments.length, chars: text.length,
      lastTextAt: t.lastTextAt, recognizer: latestActivity?.recognizer ?? null, sourceGen: latestActivity?.sourceGen ?? null };
    trace('turn-unconfirmed', t, reasonCode);
    // A newer unconfirmed candidate cannot erase an older held inference.
    // A recognizer failure can also retire the held inference itself.
    if(t===retained)invalidate(t,reasonCode);
    else if(deferRecognition&&retained){clearTurnTimers();invalidate(t,reasonCode);current=null;live(t,'reset','');updateGate(retained);}else reset(reasonCode);
    if(wasCurrent)rejectedPartialKey = rejected;
    if (hasWords) onError(message, metadata);
  }
  function fresh(at) { return { id: ++serial, segments: [], partial: '', finalized: false, awaitingAudioFinal: false,
    awaitingAudioSource: null, lastTextAt: at, lastAudioActiveAt: null, acousticWaitStartedAt: null,
    coverageCheckpointRequested: false,
    remembered: false, skipped: false, request: null, gateClosedAt: null, gateTimer: null }; }
  function updateGate(t, reasonCode = reasons.none) {
    if (!accepted(t)) return;
    if(deferRecognition&&retained===t&&blocksRetained()){
      // Interpretation has its own think deadline. Do not charge that time
      // against acoustic recovery, or a slow ignore would cancel real work.
      if(t.gateClosedAt!=null)t.gateRemainingMs=Math.max(0,(t.gateRemainingMs??finalWaitMs)-(now()-t.gateClosedAt));
      clearGate(t);return;
    }
    if (commitReady(t)) {
      const wasClosed = t.gateClosedAt != null; clearGate(t);
      if (wasClosed) trace('turn-gate-ready', t);
      t.gateRemainingMs=finalWaitMs;settle(t.request, true); return;
    }
    if (t.gateClosedAt == null) { t.gateClosedAt = now(); trace('turn-gate-closed', t, reasonCode); }
    const token = t.request;
    // Ambient uncertainty must not expire an ordinary conversation. Only an
    // actual effect waiter owns the bounded permission deadline.
    if (!token.commitRequested || t.gateTimer != null) return;
    t.gateTimer = setTimer(() => {
      if (!owns(t) || t.request !== token || !token.valid) return;
      if (commitReady(t)) { updateGate(t); return; }
      if(retained===t){const effectWaiting=t.request?.commitRequested===true&&t.request?.semanticAccepted===true;invalidate(t,reasons.commit);onError('前句的后续音频尚未确认，待提交操作已暂停。',{reason:'commit-timeout',turn:t.id,admitted:true,effectWaiting});}
      else unconfirmed('前句已经确认，但后续声音或音频状态尚未确认；待提交操作尚未执行，已暂停本轮，请完整重说或输入文字。', 'commit-timeout', reasons.commit);
    }, t.gateRemainingMs??finalWaitMs);
  }
  function schedule() {
    clearTurnTimers();
    if (!current&&!retained) return;
    const t = current||retained;
    // Native phrase endpoints may wait longer than this turn's acoustic seal.
    // When a successor contains only unconfirmed sounds, ask the existing
    // finalizer to drain that exact source during a real fresh quiet window.
    // This request supplies neither words nor commit permission. If native
    // misses the window, a later nonquiet/quiet transition permits another
    // request without renewing any confirmation or effect deadline.
    const source = t.awaitingAudioSource;
    if (typeof onCheckpoint === 'function' && activityRequired() && t.finalized && !t.partial &&
        t.awaitingAudioFinal && !t.coverageCheckpointRequested && quiet() && source &&
        source.recognizer === latestActivity.recognizer && source.sourceGen === latestActivity.sourceGen) {
      t.coverageCheckpointRequested = true; trace('turn-checkpoint', t);
      try { onCheckpoint({ recognizer: source.recognizer, sourceGen: source.sourceGen, turn: t.id }); } catch {}
      if (current !== t) return;
    }
    if (accepted(t)) { updateGate(t); return; }
    // A completed, quiet fragment which cannot form a request has no pending
    // confirmation to wait for. Retire its display now instead of leaving a
    // lone letter on screen for the full eight-second recovery deadline.
    // Provisional words and allowed short answers retain their normal path.
    if (t.finalized && !t.awaitingAudioFinal && quiet() && !meaningful(textOf(t))) {
      reset(reasons.ineligible); return;
    }
    // A native final satisfies the word-confirmation deadline. Acoustic
    // coverage, fresh quiet and the semantic seal have their own fixed budget;
    // repeated finals, empty coverage and heartbeats cannot renew it.
    const finalized = t.finalized;
    const deadline = (finalized ? t.acousticWaitStartedAt : t.lastTextAt) + finalWaitMs;
    if (!t.request) confirmationTimer = setTimer(() => {
      if (current !== t || t.request || t.finalized !== finalized ||
          (t.finalized ? t.acousticWaitStartedAt : t.lastTextAt) + finalWaitMs !== deadline) return;
      // At an exact timer tie, the already-ready request may take its turn.
      if (finalized && ready(t) && meaningful(textOf(t))) return;
      if (finalized) unconfirmed('这句语音文字已定稿，但后续音频覆盖或安静封口尚未确认，未提交交办；请完整重说，或直接输入文字。', 'acoustic-timeout', reasons.acoustic);
      else unconfirmed('这段语音尚未确认，未提交交办；请完整重说，或直接输入文字。', 'confirmation-timeout', reasons.confirmation);
    }, Math.max(0, deadline - now()));
    if(typeof onCheckpoint==='function'&&activityRequired()&&!t.finalized&&t.partial&&!t.checkpointRequested&&
       ['recognizer','sourceGen'].every(key=>Number.isSafeInteger(t.partialSource?.[key])&&t.partialSource[key]>=0)){
      // Reserve the existing three-second native finalizer budget plus a small
      // IPC margin inside the original deadline. This does not seal speech or
      // renew that deadline; subsequent audio still enters the next Analyzer.
      checkpointTimer=setTimer(()=>{
        if(current!==t||t.finalized||t.checkpointRequested)return;
        t.checkpointRequested=true;trace('turn-checkpoint',t);
        try{onCheckpoint({...t.partialSource,turn:t.id});}catch{}
      },Math.max(0,t.lastTextAt+Math.max(0,finalWaitMs-3200)-now()));
    }
    if (!t.finalized || t.awaitingAudioFinal || t.request || !meaningful(textOf(t)) || !quiet()) return;
    requestTimer = setTimer(() => {
      if (!ready(t) || t.request) return;
      clearTimer(confirmationTimer);
      const token = { accepted: true, semanticAccepted:!deferRecognition,valid: true, completed: false, waiters: new Set(), text: textOf(t), id: t.id, turnId: `${sessionId}:${t.id}`, heardAt: t.lastTextAt,
        audioStartAtMs: t.audioStartAtMs, audioEndAtMs: t.audioEndAtMs,
        observation:t.observation,
        managesCommitDeadline:true,
        hold:()=>{if(token.isCurrent())t.held=true;},
        recognize:({replace=true}={})=>{if(!token.isCurrent())return false;if(current===t&&retained&&retained!==t&&replace)invalidate(retained,reasons.next);token.semanticAccepted=true;token.turnDisposition=replace?'replace':'keep';if(current===t)live(t,'pending');if(retained)updateGate(retained);return true;},
        isCurrent: () => owns(t) && t.request === token && token.valid,
        canCommit: () => token.isCurrent() && commitReady(t),
        waitForCommit: ({ signal } = {}) => {
          if (!token.isCurrent() || signal?.aborted) return Promise.resolve(false);
          token.commitRequested = true;
          updateGate(t);
          if (token.canCommit()) return Promise.resolve(true);
          return new Promise(resolve => {
            const finish = value => { token.waiters.delete(finish); signal?.removeEventListener('abort', aborted); resolve(value && token.canCommit()); };
            const aborted = () => finish(false); token.waiters.add(finish); signal?.addEventListener('abort', aborted, { once: true });
          });
        },
        remember: () => { if (token.canCommit()) return remember(t); },
        rememberConversation: () => { if (token.isCurrent()) return remember(t, true); },
        skip: () => { if (token.isCurrent()) {t.skipped = true;if(retained)updateGate(retained);} },
        complete: () => complete(t, token) };
      t.request = token; trace('turn-request', t); live(t, deferRecognition?'candidate':'pending');
      // Semantic admission is stable across raw acoustic uncertainty. Effects
      // must independently wait for and recheck canCommit at their boundary.
      try { if (token.isCurrent()) Promise.resolve(onRequest(token)).catch(() => {}); } catch {}
    }, Math.max(0, boundaryAt(t) + turnMs - now()));
  }
  function detachHeld() {
    if(!deferRecognition||!current?.held||!accepted(current))return;
    if(retained&&retained!==current)invalidate(current,reasons.next);else retained=current;
    current=null;
  }
  function partial(raw, meta) {
    const text = String(raw || '').trim();
    if (!text || !current && contentKey(text) === rejectedPartialKey) return;
    detachHeld();
    if(text===current?.partial){if(meta)current.partialSource={recognizer:meta.recognizer,sourceGen:meta.sourceGen};return;}
    rejectedPartialKey = null;
    if (current?.partial && contentKey(text) === contentKey(current.partial)) {
      current.partial = text; live(current, 'partial'); return;
    }
    if (current?.remembered || current?.skipped) { invalidate(current, reasons.next); current = null; }
    else invalidate(current, reasons.text);
    if (!current) current = fresh(now());
    if(!current.partial)current.audioBeforePartial={audioStartAtMs:current.audioStartAtMs,audioEndAtMs:current.audioEndAtMs,acousticWaitStartedAt:current.acousticWaitStartedAt};
    recordAudio(current, meta);
    if(meta?.voiceObservation)current.observation={...meta.voiceObservation};
    current.partial = text; current.partialSource = meta ? {recognizer:meta.recognizer,sourceGen:meta.sourceGen} : null;
    current.finalized = false; current.acousticWaitStartedAt = null; current.lastTextAt = now(); current.skipped = false;
    trace('turn-partial'); live(current, 'partial'); if(retained)updateGate(retained,reasons.text);schedule();
  }
  function final(raw, meta) {
    const text = String(raw || '').trim();
    if (!text) return;
    const source = audioSource(meta);
    // Native finals are immutable receipts for monotonically increasing
    // sources. Retirement/reset cannot make a sealed source a fresh command.
    if(source&&finalizedSource&&(source.recognizer<finalizedSource.recognizer||
       source.recognizer===finalizedSource.recognizer&&source.sourceGen<=finalizedSource.sourceGen))return;
    rejectedPartialKey = null;
    if (current?.finalized && !current.partial && contentKey(current.segments.at(-1)) === contentKey(text) &&
        sameSource(current.finalSource,source)) {
      // This receipt already sealed its source. Replaying it cannot cover
      // audio observed later, even when the old transcript is identical.
      // Older recognizers have no source metadata; retain their existing
      // final-event contract rather than inventing a generation for them.
      if(!source&&current.awaitingAudioFinal){current.awaitingAudioFinal=false;current.awaitingAudioSource=null;trace('turn-final');live(current,accepted(current)?'pending':'final');schedule();}
      return;
    }
    detachHeld();
    if (current?.remembered || current?.skipped) { invalidate(current, reasons.next); current = null; }
    if (!current) current = fresh(now());
    recordAudio(current, meta);
    if(meta?.voiceObservation)current.observation={...meta.voiceObservation};
    const newSource = !!source && !!current.finalSource && !sameSource(current.finalSource,source);
    current.finalSource=source;
    // A native final is complete audio coverage even while its interpretation
    // is pending. The candidate still vetoes the retained request's effects.
    if(retained?.awaitingAudioFinal&&meta&&latestActivity&&
       meta.recognizer===retained.awaitingAudioSource?.recognizer&&meta.sourceGen===retained.awaitingAudioSource?.sourceGen&&
       meta.recognizer===latestActivity.recognizer&&meta.sourceGen===latestActivity.sourceGen){
      retained.lastAudioActiveAt=retained.awaitingAudioSource.previousActiveAt;retained.awaitingAudioFinal=false;retained.awaitingAudioSource=null;
    }
    const changed = newSource || contentKey(text) !== contentKey(current.partial || current.segments.at(-1));
    if (changed || current.partial) invalidate(current, reasons.text);
    if (changed) current.lastTextAt = now();
    if (changed || current.acousticWaitStartedAt == null) current.acousticWaitStartedAt = now();
    if (newSource || current.segments.at(-1) !== text || current.partial) current.segments.push(text);
    current.partial = ''; current.partialSource = null; current.audioBeforePartial = null; current.finalized = true; current.awaitingAudioFinal = false; current.awaitingAudioSource = null;
    if(source)finalizedSource=source;
    trace('turn-final'); live(current, 'final');if(retained)updateGate(retained,reasons.text); schedule();
  }
  function activity(meta) {
    const clock = now();
    if (!meta || !['unknown', 'active', 'quiet'].includes(meta.state) ||
      !['seq', 'recognizer', 'sourceGen'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0)) return false;
    if (latestActivity && (meta.recognizer < latestActivity.recognizer || meta.recognizer === latestActivity.recognizer &&
      (meta.seq <= latestActivity.seq || meta.sourceGen < latestActivity.sourceGen))) return false;
    if (latestActivity && meta.recognizer > latestActivity.recognizer) {
      if(retained)unconfirmed('语音识别已重新连接，前句待提交操作已暂停，请完整重说或输入文字。','recognizer-changed',reasons.epoch,retained);
      if (accepted(current) || current && (!current.finalized || current.awaitingAudioFinal)) unconfirmed('语音识别已重新连接，本轮已暂停，请完整重说或输入文字。', 'recognizer-changed', reasons.epoch);
      latestActivity = null; rejectedPartialKey = null;
    }
    if (latestActivity && Number.isFinite(meta.at) && meta.at < latestActivity.at) return false;
    const valid = Number.isFinite(meta.at) && meta.at >= 0 && meta.at <= clock && Number.isFinite(meta.quietSeconds) && meta.quietSeconds >= 0;
    const next = { state: valid ? meta.state : 'unknown', quietSeconds: valid ? meta.quietSeconds : 0,
      at: valid ? meta.at : clock, seq: meta.seq, recognizer: meta.recognizer, sourceGen: meta.sourceGen };
    if (latestActivity && next.sourceGen > latestActivity.sourceGen) rejectedPartialKey = null;
    latestActivity = next; clearTimer(activityTimer);
    if (current && next.state !== 'quiet') current.coverageCheckpointRequested = false;
    for(const observed of [current,retained].filter(Boolean))if(next.state==='active'){
      // Retain the first uncovered source. A later empty segment cannot
      // cover an earlier segment whose words were rejected by input filters.
      if (!observed.awaitingAudioFinal) observed.awaitingAudioSource = { recognizer: next.recognizer, sourceGen: next.sourceGen,
        previousActiveAt: observed.lastAudioActiveAt };
      observed.lastAudioActiveAt = clock; observed.awaitingAudioFinal = true;
    }
    if (accepted(current)) updateGate(current, next.state === 'active' ? reasons.active : next.state === 'unknown' ? reasons.unknown : reasons.stale);
    if(accepted(retained))updateGate(retained,next.state==='active'?reasons.active:reasons.unknown);
    activityTimer = setTimer(() => {
      if (latestActivity !== next || !activityRequired()) return;
      updateGate(current, reasons.stale); schedule();
      updateGate(retained,reasons.stale);
    }, Math.max(0, next.at + activityFreshMs + 1 - clock));
    schedule(); return valid;
  }
  function audioFinal(meta) {
    if(retained?.finalized&&!retained.partial&&retained.awaitingAudioFinal&&latestActivity&&meta&&
      ['recognizer','sourceGen','coveredSeq'].every(key=>Number.isSafeInteger(meta[key])&&meta[key]>=0)&&
      meta.recognizer===retained.awaitingAudioSource?.recognizer&&meta.sourceGen===retained.awaitingAudioSource?.sourceGen&&
      meta.recognizer===latestActivity.recognizer&&meta.sourceGen===latestActivity.sourceGen&&meta.coveredSeq===latestActivity.seq&&latestActivity.state==='quiet'){
      retained.lastAudioActiveAt=retained.awaitingAudioSource.previousActiveAt;retained.awaitingAudioFinal=false;retained.awaitingAudioSource=null;updateGate(retained);
    }
    // Only the native finalizer's empty, fully drained successor may cover
    // raw activity. It cannot add words, authenticate input, clear a partial,
    // resurrect a cancelled turn, or cover newer/out-of-order audio.
    if (!current?.finalized || current.partial || !current.awaitingAudioFinal || !latestActivity ||
        !meta || !['recognizer', 'sourceGen', 'coveredSeq'].every(key => Number.isSafeInteger(meta[key]) && meta[key] >= 0) ||
        meta.recognizer !== current.awaitingAudioSource?.recognizer || meta.sourceGen !== current.awaitingAudioSource?.sourceGen ||
        meta.recognizer !== latestActivity.recognizer || meta.sourceGen !== latestActivity.sourceGen ||
        meta.coveredSeq !== latestActivity.seq || latestActivity.state !== 'quiet') return false;
    // Proven-empty audio must stop extending the semantic seal too. Restore
    // the prior boundary so now-covered ambient activity does not needlessly
    // delay confirmed words; real speech retains its original seal.
    current.lastAudioActiveAt = current.awaitingAudioSource.previousActiveAt;
    current.awaitingAudioFinal = false; current.awaitingAudioSource = null; trace('turn-audio-final'); schedule(); return true;
  }
  function retract(meta) {
    if (!current?.partial || !meta || !['recognizer','sourceGen'].every(key=>Number.isSafeInteger(meta[key]) && meta[key]>=0 && meta[key]===current.partialSource?.[key])) return false;
    const t=current;invalidate(t,reasons.text);t.partial='';t.partialSource=null;
    Object.assign(t,t.audioBeforePartial||{audioStartAtMs:undefined,audioEndAtMs:undefined});t.audioBeforePartial=null;
    if(!t.segments.length){if(deferRecognition&&retained){clearTurnTimers();current=null;live(t,'reset','');updateGate(retained);schedule();}else reset(reasons.text);return true;}
    // Earlier native finals retain their words. Withdrawing text is not an
    // empty finalizer receipt and cannot cover newer, unconfirmed audio.
    t.finalized=true;trace('turn-retracted');live(t,'final');schedule();return true;
  }
  return { partial, final, activity, audioFinal, reset, retract,
    recognizerStopped: ({ graceful = false } = {}) => {
      if(retained)unconfirmed('语音识别中断，前句待提交操作已暂停，请完整重说或输入文字。','recognizer-stopped',reasons.stopped,retained);
      if (!current) return;
      if (graceful && !accepted(current) && current.finalized && !current.awaitingAudioFinal) {
        if (latestActivity) latestActivity = { ...latestActivity, state: 'unknown', quietSeconds: 0, at: now() };
        schedule(); return;
      }
      if (accepted(current) || !current.finalized || current.awaitingAudioFinal || activityRequired()) unconfirmed('语音识别中断，本轮已暂停，请完整重说或输入文字。', 'recognizer-stopped', reasons.stopped);
    },
    snapshot: () => current ? { text: textOf(current), id: current.id, requested: !!current.request,
      finalized: current.finalized, awaitingAudioFinal: current.awaitingAudioFinal, accepted: accepted(current), commitReady: accepted(current) && commitReady(current), waitingAudio: current.awaitingAudioFinal,
      gateClosedMs: current.gateClosedAt == null ? 0 : Math.max(0, now() - current.gateClosedAt), acousticWaitStartedAt: current.acousticWaitStartedAt,
      silenceMs: now() - boundaryAt(current), lastTextAt: current.lastTextAt, lastAudioActiveAt: current.lastAudioActiveAt } : null };
}
module.exports = { createVoiceTurns, meaningful };
