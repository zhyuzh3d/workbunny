'use strict';
/**
 * 语音识别进程管理：spawn bin/asr（原生 SFSpeechRecognizer），解析 JSON 行。
 *
 * 注意（踩过的坑）：
 *  · 裸可执行文件调用 SFSpeechRecognizer 时，TCC 会校验「责任进程」的 Info.plist。
 *    dev 模式的责任进程是 node_modules/electron/dist/Electron.app，打包后是 workbunny.app，
 *    两者都必须含 NSSpeechRecognitionUsageDescription / NSMicrophoneUsageDescription，
 *    否则子进程直接 SIGABRT（134），且 stdout 一行都不吐 —— 表现为「点了麦克风没反应」。
 *  · 所以这里必须给启动加超时：只要 25s 内没收到 auth/ready，就当权限没批，报错给 UI。
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { JsonLines } = require('./json-lines');

const AUTH_TIMEOUT_MS = 25000;
const MAX_ASR_LINE_BYTES = 512 * 1024;
const FINALIZATION_STAGES = new Set(['requested', 'results-ended', 'finalizer-returned', 'committed', 'failed']);
const FINALIZATION_FAILURES = new Set(['finalizer', 'results', 'unconfirmed', 'unexpectedResultsEnd', 'unexpectedFinalizer', 'timeout']);
const CAPTURE_HEALTH_REASONS = new Set(['configuration-changed', 'transport-timeout', 'vad-timeout']);
const FAILURE_KINDS = new Set(['recognition', 'capture', 'permission', 'resources', 'startup', 'protocol', 'unknown']);

// The native owner of a failing operation classifies it. Exit codes and
// localized descriptions overlap between capture and recognition failures.
function asrFailureReceipt(message, recognizer) {
  const failure = { kind: FAILURE_KINDS.has(message.kind) ? message.kind : 'unknown', recognizer };
  if (Number.isSafeInteger(message.code)) failure.code = message.code;
  if (typeof message.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(message.reason)) failure.reason = message.reason;
  if (Number.isSafeInteger(message.gen) && message.gen >= 0) failure.sourceGen = message.gen;
  if (typeof message.fatal === 'boolean') failure.fatal = message.fatal;
  return failure;
}
function shouldNotifyAsrFailure(failure) { return failure?.kind !== 'recognition'; }

// Ordinary operation keeps just the receipts needed to distinguish a stale
// result watermark from a failed finalizer. Never log transcript or audio.
function finalizationReceipt(message, recognizer) {
  if (!FINALIZATION_STAGES.has(message.stage) || !Number.isSafeInteger(message.gen) || message.gen < 0 ||
      typeof message.ok !== 'boolean' || typeof message.current !== 'boolean') return null;
  const value = { stage: message.stage, gen: message.gen, recognizer, ok: message.ok, current: message.current };
  for (const key of ['at', 'inputSeconds']) if (Number.isFinite(message[key]) && message[key] >= 0) value[key] = message[key];
  if (Number.isSafeInteger(message.textChars) && message.textChars >= 0) value.textChars = message.textChars;
  if (typeof message.resultsConfirmed === 'boolean') value.resultsConfirmed = message.resultsConfirmed;
  if (FINALIZATION_FAILURES.has(message.reason)) value.reason = message.reason;
  return value;
}
function acousticReceipt(message, recognizer) {
  const counts = ['gen', 'textChars', 'timedRuns', 'supportedRuns', 'unmappedRuns', 'confidenceRuns'];
  const flags = ['current', 'accepted', 'granular', 'isFinal'];
  if (!counts.every(key => Number.isSafeInteger(message[key]) && message[key] >= 0) ||
      !flags.every(key => typeof message[key] === 'boolean')) return null;
  const value = { recognizer };
  for (const key of [...counts, ...flags]) value[key] = message[key];
  if (Number.isFinite(message.at) && message.at >= 0) value.at = message.at;
  return value;
}
function captureHealthReceipt(message, recognizer) {
  if (!CAPTURE_HEALTH_REASONS.has(message.reason) ||
      !['gen', 'captureEpoch', 'textChars'].every(key => Number.isSafeInteger(message[key]) && message[key] >= 0) ||
      !['current', 'pendingText'].every(key => typeof message[key] === 'boolean')) return null;
  const value = { reason: message.reason, recognizer };
  for (const key of ['gen', 'captureEpoch', 'textChars', 'current', 'pendingText']) value[key] = message[key];
  for (const key of ['at', 'captureAgeMs', 'activityAgeMs']) if (Number.isFinite(message[key]) && message[key] >= 0) value[key] = message[key];
  return value;
}

// Native uptime and host wall time have different origins. A per-process
// minimum receive offset preserves both native observation age and pipe delay.
function createActivityClock({ wallNow = () => Date.now(), monoNow = () => Number(process.hrtime.bigint()) / 1e6 } = {}) {
  let offset = Infinity, sequence = 0, generation = -1, emittedAt = -Infinity;
  const clock = (message, recognizer) => {
    const wall = wallNow(), mono = monoNow();
    const validSeq = Number.isSafeInteger(message.seq) && message.seq > 0;
    const validGen = Number.isSafeInteger(message.gen) && message.gen >= 0;
    const unknown = () => ({ state: 'unknown', quietSeconds: 0, at: wall,
      seq: validSeq ? message.seq : 0, recognizer, sourceGen: validGen ? message.gen : Math.max(0, generation) });
    if (!validSeq || !validGen || message.seq <= sequence || message.gen < generation) return unknown();
    sequence = message.seq; generation = message.gen;
    if (!['unknown', 'active', 'quiet'].includes(message.state) || !Number.isFinite(message.quietSeconds) || message.quietSeconds < 0 ||
        !Number.isFinite(message.at) || message.at < 0 || !Number.isFinite(message.emittedAt) || message.emittedAt < message.at ||
        message.emittedAt < emittedAt || !Number.isFinite(wall) || !Number.isFinite(mono)) return unknown();
    emittedAt = message.emittedAt;
    offset = Math.min(offset, mono - message.emittedAt * 1000);
    const age = mono - (message.at * 1000 + offset);
    if (!Number.isFinite(age) || age < 0) return unknown();
    return { state: age <= 500 ? message.state : 'unknown', quietSeconds: message.state === 'quiet' && age <= 500 ? message.quietSeconds : 0,
      at: wall - age, seq: message.seq, recognizer, sourceGen: message.gen };
  };
  clock.range = (message, recognizer) => {
    const value = { recognizer };
    if (typeof message.speechSupported === 'boolean') value.speechSupported = message.speechSupported;
    if (Number.isSafeInteger(message.gen) && message.gen >= 0) value.sourceGen = message.gen;
    const start = message.audioStartAt, end = message.audioEndAt, emitted = message.emittedAt;
    const wall = wallNow(), mono = monoNow();
    if (![start,end,emitted,wall,mono].every(Number.isFinite) || start < 0 || end < start || emitted < end) return value;
    offset = Math.min(offset, mono - emitted * 1000);
    const from = wall - (mono - (start * 1000 + offset)), to = wall - (mono - (end * 1000 + offset));
    if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to >= from && to <= wall) {
      value.audioStartAtMs = from; value.audioEndAtMs = to;
    }
    return value;
  };
  return clock;
}

class Asr extends EventEmitter {
  constructor(binPath, log = () => {}, spawnProcess = spawn) {
    super();
    this.bin = binPath;
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn;
    this.proc = null;
    this.stopping = false;
    this.inputFailed = false;
    this.inputGeneration = -1;
    this.discarded = new WeakSet();
    this.retiring = new WeakSet();
    this.ready = false;
    this.lastError = null;
    this.lastFailure = null;
    this.contextReceipt = null;
    this.partial = ''; this.wakeHits = new Map();
    this.log = log;
    this.authWaitTimer = null;
    this.aec = false;
    this.echoState = null;
    this.lastCaptureAt = 0;
    this.captureTimer = null;
    this.installing = false;
    this.traceEnabled = false; this.traceRecognizer = 0; this.traceSequence = 0;
    this.activityClock = createActivityClock();
  }

  get running() {
    return !!this.proc;
  }

  start(opts = {}) {
    if (this.proc) return;
    if(opts.diagnostic&&(!require('node:path').isAbsolute(opts.diagnostic.directory)||!Number.isSafeInteger(opts.diagnostic.durationMs)||opts.diagnostic.durationMs<1||opts.diagnostic.durationMs>20000||typeof opts.diagnostic.pcm!=='boolean'))throw Error('E_DIAGNOSTIC_OPTIONS');
    this.diagnostic=opts.diagnostic||null;
    const args = [
      '--lang', opts.lang || 'zh-CN',
      '--silence', String(opts.silenceMs || 600),
      '--sensitivity', String(Number.isInteger(opts.sensitivity) ? opts.sensitivity : 1),
      '--max', String(opts.maxSeconds || 45),
    ];
    if (opts.always) {
      args.push('--always', '--utterances', String(opts.maxUtterances || 30));
    }
    this.wakeHits.clear();
    this.contextReceipt = null;
    if (opts.wakeNames?.length) args.push('--wake-names', JSON.stringify(opts.wakeNames));
    if (opts.contextualStrings !== undefined) args.push('--context-strings', JSON.stringify(require('./hearing-hotwords').normalizeWords(opts.contextualStrings, {max:require('./hearing-hotwords').SYSTEM_LIMIT})));
    if (opts.allowNetwork) args.push('--allow-network');
    if (opts.askSpeech) args.push('--ask-speech');
    args.push('--aec'); // Acoustic processing health is reported independently of capture readiness.
    if (opts.device) args.push('--mic', String(opts.device));
    if (opts.noMicAsk) args.push('--no-mic-ask');
    if (opts.trace === true) args.push('--speech-trace');
    if(this.diagnostic){args.push('--speech-diagnostic-dir',this.diagnostic.directory,'--speech-diagnostic-ms',String(this.diagnostic.durationMs));if(this.diagnostic.pcm)args.push('--speech-diagnostic-pcm');}
    this.traceEnabled = opts.trace === true;this.traceRecognizer++;this.traceSequence=0;
    this.activityClock = createActivityClock(); this.aec = false; this.echoState = null;
    this.always = !!opts.always;
    this.lastError = null; this.lastFailure = null;
    let p;
    try {
      p = this.spawnProcess(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.reportFailure(e.message, { kind: 'startup', reason: 'spawn', fatal: true });
      return;
    }
    this.proc = p;
    this.stopping = false;
    this.inputFailed = false;
    this.inputGeneration = -1;
    this.ready = false;
    this.partial = '';
    this.aec = false;
    this.lastCaptureAt = 0;
    this.installing = false;
    this.writeLog(`[asr] spawn ${this.bin} ${args.join(' ')} pid=${p.pid}`);
    const messages = new JsonLines(MAX_ASR_LINE_BYTES);
    let sawAuth = false;

    // Authentication is not capture readiness. A process can report auth and
    // then stall while preparing its input, before a capture heartbeat exists.
    this.authWaitTimer = setTimeout(() => {
      if (this.proc === p && !this.ready) {
        this.writeLog('[asr] no ready within ' + AUTH_TIMEOUT_MS + 'ms -> kill');
        this.reportFailure(sawAuth ? '语音输入准备超时，正在重连。' : '语音权限没有确认。第一次用会弹系统窗口，请点「允许」。',
          { kind: sawAuth ? 'startup' : 'permission', reason: 'ready-timeout', fatal: true });
        if (this.proc === p) this.kill();
      }
    }, AUTH_TIMEOUT_MS);

    p.stdout.on('data', (chunk) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      try {
        messages.push(chunk, message => {
          if (this.proc !== p) return false;
          if (message.t === 'auth') sawAuth = true;
          this.onMessage(message, p);
        });
      } catch {
        this.reportFailure('语音模块返回无效响应，正在重连', { kind: 'protocol', reason: 'invalid-response', fatal: true });
        if (this.proc === p) this.kill();
      }
    });
    p.stdin.on?.('error', error => {
      if (this.proc !== p) return;
      this.writeLog('[asr] stdin error ' + error.code);
      this.kill();
    });

    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      const s = String(d).trim();
      if (s) this.writeLog('[asr stderr] ' + s.slice(0, 300));
    });

    p.on('error', (e) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      this.writeLog('[asr] spawn error ' + e.message);
      this.reportFailure('语音模块启动失败：' + e.message, { kind: 'startup', reason: 'spawn', fatal: true });
    });

    p.on('close', (code, sig) => {
      if (this.discarded.has(p)) return;
      const isCurrent = this.proc === p;
      if (!isCurrent && (!this.retiring.has(p) || this.proc !== null)) return;
      this.writeLog(`[asr] exit code=${code} sig=${sig}`);
      // Timers are instance state. A stale close may notify recovery after a
      // normal kill, but it must never clear a replacement process's timers.
      if (isCurrent) {
        if (this.authWaitTimer) { clearTimeout(this.authWaitTimer); this.authWaitTimer = null; }
        if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
        this.proc = null;
      }
      this.ready = false;
      // 134 = SIGABRT：几乎一定是 TCC 少了 usage description
      if (!sawAuth && (code === 134 || sig === 'SIGABRT')) {
        this.reportFailure('语音模块被系统拦下了（权限声明缺失），请看「权限」面板。', { kind: 'permission', reason: 'usage-description', fatal: true });
      }
      this.emit('exit', code);
    });
  }

  onMessage(m, sourceProc = null) {
    if (sourceProc && (this.proc !== sourceProc || this.discarded.has(sourceProc))) return;
    if((this.inputFailed||this.stopping&&this.always)&&['partial','utterance','retract','final','activity','audioFinal','voiceFeatures'].includes(m.t))return;
    if(['partial','utterance','retract','final','activity','audioFinal'].includes(m.t)&&Number.isSafeInteger(m.gen)&&m.gen>=0)this.inputGeneration=Math.max(this.inputGeneration,m.gen);
    if(this.diagnostic)try{this.diagnostic.record?.(m);}catch{this.kill({discard:true});return;}
    if(['partial','utterance','final'].includes(m.t))this.emitSpeechTrace({stage:'raw-'+m.t,chars:typeof m.v==='string'?m.v.length:0});
    if (typeof m.wakeNameHit === 'boolean' && typeof m.v === 'string' && m.v.length <= 4000 && ['partial','utterance','final'].includes(m.t)) {
      this.wakeHits.set(m.v.trim(), m.wakeNameHit);
      if (this.wakeHits.size > 32) this.wakeHits.delete(this.wakeHits.keys().next().value);
    }
    switch (m.t) {
      case 'capture-health': {
        const receipt = captureHealthReceipt(m, this.traceRecognizer);
        if (!receipt) break;
        // The native stream has claimed recovery and invalidated this capture
        // epoch. Retire its business input before any observer runs; output
        // already in the pipe must not create a new turn before process exit.
        if (receipt.current) { this.stopping = true; this.emit('inputReset'); }
        this.emit('captureHealth', receipt);
        this.writeLog('[asr] capture-health ' + JSON.stringify(receipt));
        break;
      }
      case 'acoustic-support': {
        const receipt = acousticReceipt(m, this.traceRecognizer);
        if (!receipt) break;
        this.emit('acousticSupport', receipt);
        if (receipt.current && receipt.textChars > 0 && (!receipt.accepted || receipt.isFinal))
          this.writeLog('[asr] acoustic-support ' + JSON.stringify(receipt));
        break;
      }
      case 'finalization': {
        const receipt = finalizationReceipt(m, this.traceRecognizer);
        if (!receipt) break;
        this.emit('finalization', receipt);
        if (receipt.current && (receipt.stage === 'failed' || receipt.stage === 'committed' && receipt.textChars > 0))
          this.writeLog('[asr] finalization ' + JSON.stringify(receipt));
        break;
      }
      case 'activity':
        this.emit('activity', this.activityClock(m, this.traceRecognizer));
        break;
      case 'audioFinal':
        if (Number.isSafeInteger(m.gen) && m.gen >= 0 && Number.isSafeInteger(m.coveredSeq) && m.coveredSeq > 0)
          this.emit('audioFinal', { sourceGen: m.gen, coveredSeq: m.coveredSeq, recognizer: this.traceRecognizer });
        break;
      case 'speechTrace': {
        this.emitSpeechTrace(m);
        break;
      }
      case 'auth':
        this.emit('auth', { speech: m.speech, mic: m.mic, locale: m.locale || '', engine: m.engine || '' });
        break;
      case 'ready':
        this.installing = false;
        this.ready = true;
        if (this.authWaitTimer) { clearTimeout(this.authWaitTimer); this.authWaitTimer = null; }
        this.emit('ready');
        if (m.captureHeartbeat && !this.captureTimer) {
          const p = sourceProc || this.proc;
          this.lastCaptureAt = Date.now();
          this.captureTimer = setInterval(() => {
            if (this.proc === p && p && Date.now() - this.lastCaptureAt > 6000) {
              this.reportFailure('麦克风输入中断，正在重连', { kind: 'capture', reason: 'transport-timeout', fatal: true });
              if (this.proc === p) this.kill();
            }
          }, 1000);
          this.captureTimer.unref?.();
        }
        break;
      case 'installing': {
        const p = sourceProc || this.proc;
        this.installing = true;
        if (this.authWaitTimer) clearTimeout(this.authWaitTimer);
        this.authWaitTimer = setTimeout(() => {
          if (this.proc !== p || !p || !this.installing) return;
          this.reportFailure('语音资源准备超时，请检查网络后重试', { kind: 'resources', reason: 'install-timeout', fatal: true });
          if (this.proc === p) this.kill();
        }, 5 * 60 * 1000);
        this.emit('installing', { locale: m.locale || '' });
        break;
      }
      case 'tap':
      case 'capture':
        this.lastCaptureAt = Date.now();
        this.emit('capture', m);
        break;
      case 'recognitionError':
        if(m.expectedEmpty === true) break;
        if(typeof m.domain==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(m.domain)&&Number.isSafeInteger(m.code))
          this.writeLog('[asr] recognition error '+JSON.stringify({domain:m.domain,code:m.code,rejected:m.rejected===true,hasText:m.hasText===true,ending:m.ending===true,requested:m.requested===true}));
        break;
      case 'partial':
        this.partial = m.v || '';
        this.emit('partial', this.partial, this.activityClock.range(m, this.traceRecognizer));
        break;
      case 'retract':
        if (Number.isSafeInteger(m.gen) && m.gen >= 0) {
          this.partial = '';
          this.emit('retract', {recognizer:this.traceRecognizer,sourceGen:m.gen});
        }
        break;
      case 'voiceFeatures':
        this.emit('voiceFeatures', m);
        break;
      case 'utterance':
        this.partial = '';
        this.emit('utterance', m.v || '', this.activityClock.range(m, this.traceRecognizer));
        break;
      case 'recycle':
        this.emit('recycle', m.v || 0);
        break;
      case 'aec':
        this.aec = m.engine === 'webrtc-aec3' ? m.on === true && m.state === 'active' : m.on === true;
        this.echoState = { on: this.aec, engine: m.engine === 'webrtc-aec3' ? 'webrtc-aec3' : 'legacy',
          state: this.aec ? 'active' : m.state === 'starting' ? 'starting' : 'degraded',
          ...(Number.isSafeInteger(m.referenceCode) ? { referenceCode: m.referenceCode } : {}),
          ...(typeof m.systemDucking === 'boolean' ? { systemDucking: m.systemDucking } : {}) };
        this.emit('aec', this.aec, this.echoState);
        break;
      case 'fmt':
        this.emit('fmt', { hw: m.hw || '', tgt: m.tgt || '' });
        break;
      case 'mic':
        this.micName = m.name || '';
        this.micBound = !!m.on;
        this.emit('micDevice', { on: !!m.on, name: m.name || '', note: m.v || '', identity: m.identity || '' });
        break;
      case 'audio':
        // 最终采用的音频方案（AEC+指定麦 / 指定麦 / 系统默认 …）
        this.audioPlan = m.plan || '';
        this.emit('audioPlan', this.audioPlan);
        break;
      case 'warn':
        // 方案降级的中间过程：只进日志，不打扰主人
        this.writeLog('[asr] ' + (m.v || ''));
        break;
      case 'level':
        this.emit('level', m.v || 0);
        break;
      case 'context':
        if (['queued', 'submitted', 'failed'].includes(m.stage) && Number.isSafeInteger(m.revision) && m.revision >= 0 &&
            Number.isSafeInteger(m.count) && m.count >= 0 && m.count <= 100) {
          if (this.contextReceipt && m.revision < this.contextReceipt.revision) break;
          const receipt = { stage:m.stage, revision:m.revision, count:m.count, recognizer:this.traceRecognizer };
          if (Number.isSafeInteger(m.gen) && m.gen >= 0) receipt.sourceGen = m.gen;
          if (m.stage === 'failed' && Number.isSafeInteger(m.code)) receipt.code = m.code;
          this.contextReceipt = receipt;
          this.writeLog('[asr] vocabulary ' + JSON.stringify(receipt));
          this.emit('context', receipt);
        }
        break;
      case 'final':
        this.emit('final', m.v || '', this.activityClock.range(m, this.traceRecognizer));
        break;
      case 'end':
        this.emit('end');
        break;
      case 'error':
        this.reportFailure(m.v, m);
        break;
      default:
        break;
    }
  }

  wakeHit(text) { return this.wakeHits.get(String(text || '').trim()) ?? this.wakeHits.get(String(text || '').split('\n')[0].trim()); }

  reportFailure(message, metadata = {}) {
    this.lastError = typeof message === 'string' && message ? message : '未知错误';
    this.lastFailure = asrFailureReceipt(metadata, this.traceRecognizer);
    // Retire unconfirmed input before notification/recovery observers run.
    // A failure never supplies the successful audio-final coverage receipt.
    if (this.lastFailure.fatal) {
      const alreadyRetired = this.inputFailed || this.stopping && this.always;
      this.stopping = true; this.inputFailed = true; this.partial = '';
      if (!alreadyRetired) this.emit('inputReset');
    }
    this.emit('error', this.lastError, this.lastFailure);
  }

  writeLog(...args) { if(!this.diagnostic)this.log(...args); }

  emitSpeechTrace(value) {
    if(!this.traceEnabled)return;
    try{const record=require('./speech-trace').sanitizeSpeechTrace(value);if(record)this.emit('speechTrace',{...record,recognizer:this.traceRecognizer,seq:++this.traceSequence});}catch{ /* Diagnostics never interrupt capture. */ }
  }

  /** 抑制自听：娃娃自己出声时别把自己说的当成主人在说话 */
  mute() {
    if (!this.proc) return;
    try { this.proc.stdin.write('mute\n'); } catch {}
  }

  unmute() {
    if (!this.proc) return;
    try { this.proc.stdin.write('unmute\n'); } catch {}
  }

  updateContext(strings) {
    const words = require('./hearing-hotwords').normalizeWords(strings, {max:require('./hearing-hotwords').SYSTEM_LIMIT});
    if (!this.proc || this.stopping || !this.always) return { queued:false, nextStart:true };
    try {
      this.proc.stdin.write('context ' + JSON.stringify(words) + '\n');
      return { queued:true, nextSegment:true };
    } catch { return { queued:false, nextStart:true }; }
  }

  stop() {
    this.emit('inputReset');
    if (!this.proc) return;
    this.stopping = this.always;
    this.ready = false;
    try {
      this.proc.stdin.write(this.always ? 'quit\n' : 'stop\n');
    } catch {}
    const p = this.proc;
    setTimeout(() => {
      if (this.proc === p) {
        this.retiring.add(p);
        try {
          p.kill('SIGKILL');
        } catch {}
        this.proc = null;
      }
    }, 2500);
  }

  checkpoint({recognizer,sourceGen}={}) {
    if(!this.proc||this.stopping||!this.always||recognizer!==this.traceRecognizer||!Number.isSafeInteger(sourceGen)||sourceGen<0||sourceGen!==this.inputGeneration)return false;
    try{this.proc.stdin.write('checkpoint '+sourceGen+'\n');return true;}catch{return false;}
  }

  kill({ discard = false } = {}) {
    this.emit('inputReset');
    this.stopping = true;
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
    if (this.authWaitTimer) { clearTimeout(this.authWaitTimer); this.authWaitTimer = null; }
    if (this.proc) {
      const p = this.proc;
      if (discard) this.discarded.add(p);
      else this.retiring.add(p);
      this.ready = false;
      this.installing = false;
      this.partial = '';
      try {
        p.kill('SIGKILL');
      } catch {}
      if (this.proc === p) this.proc = null;
    }
  }
}

/**
 * 只查状态，不采集、默认也不弹窗（macOS 26 SpeechAnalyzer 不需要 Siri/听写，
 * 所以「能力是否可用」= 语言资产装了 + 麦克风授权了）。
 * 返回 { speech, mic, installed, locale, engine, error }
 * speech: 3 可用 / 1 缺语言包 / 0 待定 / -1 出错
 */
function probeAccess(binPath, { timeoutMs = 5000, requestMic = false, lang = 'zh-CN' } = {}) {
  return new Promise((resolve) => {
    let done = false, timer;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p && p.kill('SIGKILL'); } catch {}
      resolve(r);
    };
    let p;
    try {
      const args = ['--status', '--lang', lang];
      if (requestMic) args.push('--ask-speech');
      if (requestMic) args.push('--request-mic');
      p = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ speech: -1, mic: false, error: e.message });
    }
    const messages = new JsonLines(MAX_ASR_LINE_BYTES);
    p.stdout.on('data', chunk => {
      if (done) return;
      try {
        messages.push(chunk, m => {
          if (m.t === 'auth') {
            finish({
              speech: m.speech,
              mic: m.mic,
              installed: m.installed !== false,
              locale: m.locale || '',
              engine: m.engine || '', mode: m.mode, available: m.available, onDevice: m.onDevice,
              error: m.error || '',
            });
          }
          if (m.t === 'error') finish({ speech: -1, mic: false, error: m.v });
          return !done;
        });
      } catch {
        finish({ speech: -1, mic: false, error: '语音模块返回无效响应' });
      }
    });
    p.on('close', (code, sig) => finish({ speech: -1, mic: false, error: `exit code=${code} sig=${sig}` }));
    p.on('error', (e) => finish({ speech: -1, mic: false, error: 'spawn ' + e.message }));
    timer = setTimeout(() => finish({ speech: 0, mic: false, timedOut: true }), timeoutMs);
  });
}

// Capture readiness alone cannot clear a recurrent input fault.
// Confirmed utterances or a normal recycle reset this counter at the host.
function asrRecovery({mode,code,failures=0,failure}){
  if(code===0&&!failure?.fatal)return {failures:0,delayMs:mode==='single'?150:1200,requiresOwner:false};
  const next=failures+1;
  // Failed recognition does not prove a user spoke or a capture/permission
  // fault needs owner intervention. Back off to
  // prevent a retry storm while continuing to restore normal listening.
  if(failure?.kind==='recognition')return {failures:next,delayMs:Math.min(8000,1200*2**Math.min(3,next-1)),requiresOwner:false};
  if(code===25&&next>=3)return {failures:next,delayMs:null,requiresOwner:true};
  return {failures:next,delayMs:next>=3?Math.min(60000,4000*next):1200,requiresOwner:false};
}
module.exports = { Asr, probeAccess, asrRecovery, shouldNotifyAsrFailure, createActivityClock };
