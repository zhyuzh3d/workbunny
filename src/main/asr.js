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
    this.inputGeneration = -1;
    this.discarded = new WeakSet();
    this.retiring = new WeakSet();
    this.ready = false;
    this.lastError = null;
    this.partial = ''; this.wakeHits = new Map();
    this.log = log;
    this.authWaitTimer = null;
    this.aec = false;      // 回声消除是否可用（决定能不能边说边听）
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
      '--silence', String(opts.silenceMs || 950),
      '--max', String(opts.maxSeconds || 45),
    ];
    if (opts.always) {
      args.push('--always', '--utterances', String(opts.maxUtterances || 30));
    }
    this.wakeHits.clear();
    if (opts.wakeNames?.length) args.push('--wake-names', JSON.stringify(opts.wakeNames));
    if (opts.allowNetwork) args.push('--allow-network');
    if (opts.askSpeech) args.push('--ask-speech');
    args.push('--aec'); // Native audio tries voice processing once, then falls back automatically.
    if (opts.device) args.push('--mic', String(opts.device));
    if (opts.noMicAsk) args.push('--no-mic-ask');
    if (opts.trace === true) args.push('--speech-trace');
    if(this.diagnostic){args.push('--speech-diagnostic-dir',this.diagnostic.directory,'--speech-diagnostic-ms',String(this.diagnostic.durationMs));if(this.diagnostic.pcm)args.push('--speech-diagnostic-pcm');}
    this.traceEnabled = opts.trace === true;this.traceRecognizer++;this.traceSequence=0;
    this.activityClock = createActivityClock();
    this.always = !!opts.always;
    let p;
    try {
      p = this.spawnProcess(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.lastError = e.message;
      this.emit('error', e.message);
      return;
    }
    this.proc = p;
    this.stopping = false;
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
        this.emit('error', sawAuth ? '语音输入准备超时，正在重连。' : '语音权限没有确认。第一次用会弹系统窗口，请点「允许」。');
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
        this.emit('error', '语音模块返回无效响应，正在重连');
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
      this.emit('error', '语音模块启动失败：' + e.message);
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
        this.emit('error', '语音模块被系统拦下了（权限声明缺失），请看「权限」面板。');
      }
      this.emit('exit', code);
    });
  }

  onMessage(m, sourceProc = null) {
    if (sourceProc && (this.proc !== sourceProc || this.discarded.has(sourceProc))) return;
    if(this.stopping&&this.always&&['partial','utterance','retract','final','activity','audioFinal','voiceFeatures'].includes(m.t))return;
    if(['partial','utterance','retract','final','activity','audioFinal'].includes(m.t)&&Number.isSafeInteger(m.gen)&&m.gen>=0)this.inputGeneration=Math.max(this.inputGeneration,m.gen);
    if(this.diagnostic)try{this.diagnostic.record?.(m);}catch{this.kill({discard:true});return;}
    if(['partial','utterance','final'].includes(m.t))this.emitSpeechTrace({stage:'raw-'+m.t,chars:typeof m.v==='string'?m.v.length:0});
    if (typeof m.wakeNameHit === 'boolean' && typeof m.v === 'string' && m.v.length <= 4000 && ['partial','utterance','final'].includes(m.t)) {
      this.wakeHits.set(m.v.trim(), m.wakeNameHit);
      if (this.wakeHits.size > 32) this.wakeHits.delete(this.wakeHits.keys().next().value);
    }
    switch (m.t) {
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
              this.emit('error', '麦克风输入中断，正在重连');
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
          this.emit('error', '语音资源准备超时，请检查网络后重试');
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
        // 系统回声消除开没开：开着就能"边说边听"，主人可以随时打断
        this.aec = !!m.on;
        this.emit('aec', this.aec);
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
      case 'final':
        this.emit('final', m.v || '', this.activityClock.range(m, this.traceRecognizer));
        break;
      case 'end':
        this.emit('end');
        break;
      case 'error':
        this.lastError = m.v || '未知错误';
        this.emit('error', this.lastError);
        break;
      default:
        break;
    }
  }

  wakeHit(text) { return this.wakeHits.get(String(text || '').trim()) ?? this.wakeHits.get(String(text || '').split('\n')[0].trim()); }

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

// Capture readiness alone cannot clear a recurrent VAD/finalization fault.
// Confirmed utterances or a normal recycle reset this counter at the host.
function asrRecovery({mode,code,failures=0}){
  if(code===0)return {failures:0,delayMs:mode==='single'?150:1200,requiresOwner:false};
  const next=failures+1;
  if(code===25&&next>=3)return {failures:next,delayMs:null,requiresOwner:true};
  return {failures:next,delayMs:next>=3?Math.min(60000,4000*next):1200,requiresOwner:false};
}
module.exports = { Asr, probeAccess, asrRecovery, createActivityClock };
