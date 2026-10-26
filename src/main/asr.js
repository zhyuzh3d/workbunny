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

const AUTH_TIMEOUT_MS = 25000;

class Asr extends EventEmitter {
  constructor(binPath, log = () => {}, spawnProcess = spawn) {
    super();
    this.bin = binPath;
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn;
    this.proc = null;
    this.discarded = new WeakSet();
    this.retiring = new WeakSet();
    this.ready = false;
    this.lastError = null;
    this.partial = '';
    this.log = log;
    this.authWaitTimer = null;
    this.aec = false;      // 回声消除是否可用（决定能不能边说边听）
    this.lastCaptureAt = 0;
    this.captureTimer = null;
    this.installing = false;
  }

  get running() {
    return !!this.proc;
  }

  start(opts = {}) {
    if (this.proc) return;
    const args = [
      '--lang', opts.lang || 'zh-CN',
      '--silence', String(opts.silenceMs || 950),
      '--max', String(opts.maxSeconds || 45),
    ];
    if (opts.always) {
      args.push('--always', '--utterances', String(opts.maxUtterances || 30));
    }
    if (opts.device) args.push('--mic', String(opts.device));
    if (opts.noMicAsk) args.push('--no-mic-ask');
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
    this.ready = false;
    this.partial = '';
    this.aec = false;
    this.lastCaptureAt = 0;
    this.installing = false;
    this.log(`[asr] spawn ${this.bin} ${args.join(' ')} pid=${p.pid}`);
    let buf = '';
    let sawAuth = false;

    // 超时守门：没 auth 也没 ready，就认为权限/设备出了问题
    this.authWaitTimer = setTimeout(() => {
      if (this.proc === p && !sawAuth && !this.ready) {
        this.log('[asr] no auth/ready within ' + AUTH_TIMEOUT_MS + 'ms -> kill');
        this.emit('error', '语音权限没有确认。第一次用会弹系统窗口，请点「允许」。');
        try { p.kill('SIGKILL'); } catch {}
      }
    }, AUTH_TIMEOUT_MS);

    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === 'auth') sawAuth = true;
        this.onMessage(m, p);
      }
    });

    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      const s = String(d).trim();
      if (s) this.log('[asr stderr] ' + s.slice(0, 300));
    });

    p.on('error', (e) => {
      if (this.proc !== p || this.discarded.has(p)) return;
      this.log('[asr] spawn error ' + e.message);
      this.emit('error', '语音模块启动失败：' + e.message);
    });

    p.on('close', (code, sig) => {
      if (this.discarded.has(p)) return;
      const isCurrent = this.proc === p;
      if (!isCurrent && (!this.retiring.has(p) || this.proc !== null)) return;
      this.log(`[asr] exit code=${code} sig=${sig}`);
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
    switch (m.t) {
      case 'auth':
        this.emit('auth', { speech: m.speech, mic: m.mic, locale: m.locale || '', engine: m.engine || '' });
        break;
      case 'ready':
        this.installing = false;
        this.ready = true;
        if (this.authWaitTimer) { clearTimeout(this.authWaitTimer); this.authWaitTimer = null; }
        this.emit('ready');
        if (m.captureHeartbeat && !this.captureTimer) {
          this.lastCaptureAt = Date.now();
          this.captureTimer = setInterval(() => {
            if (this.proc && Date.now() - this.lastCaptureAt > 6000) {
              this.emit('error', '麦克风输入中断，正在重连'); this.kill();
            }
          }, 1000);
          this.captureTimer.unref?.();
        }
        break;
      case 'installing':
        this.installing = true;
        if (this.authWaitTimer) clearTimeout(this.authWaitTimer);
        this.authWaitTimer = setTimeout(() => {
          this.emit('error', '语音资源准备超时，请检查网络后重试'); this.kill();
        }, 5 * 60 * 1000);
        this.emit('installing', { locale: m.locale || '' });
        break;
      case 'tap':
      case 'capture':
        this.lastCaptureAt = Date.now();
        this.emit('capture', m);
        break;
      case 'partial':
        this.partial = m.v || '';
        this.emit('partial', this.partial);
        break;
      case 'utterance':
        this.partial = '';
        this.emit('utterance', m.v || '');
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
        this.emit('micDevice', { on: !!m.on, name: m.name || '', note: m.v || '' });
        break;
      case 'audio':
        // 最终采用的音频方案（AEC+指定麦 / 指定麦 / 系统默认 …）
        this.audioPlan = m.plan || '';
        this.emit('audioPlan', this.audioPlan);
        break;
      case 'warn':
        // 方案降级的中间过程：只进日志，不打扰主人
        this.log('[asr] ' + (m.v || ''));
        break;
      case 'level':
        this.emit('level', m.v || 0);
        break;
      case 'final':
        this.emit('final', m.v || '');
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
    if (!this.proc) return;
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

  kill({ discard = false } = {}) {
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
function probeAccess(binPath, { timeoutMs = 5000, requestMic = false } = {}) {
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
      const args = ['--status'];
      if (requestMic) args.push('--request-mic');
      p = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ speech: -1, mic: false, error: e.message });
    }
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line);
          if (m.t === 'auth') {
            finish({
              speech: m.speech,
              mic: m.mic,
              installed: m.installed !== false,
              locale: m.locale || '',
              engine: m.engine || '',
              error: m.error || '',
            });
          }
          if (m.t === 'error') finish({ speech: -1, mic: false, error: m.v });
        } catch {}
      }
    });
    p.on('exit', (code, sig) => finish({ speech: -1, mic: false, error: `exit code=${code} sig=${sig}` }));
    p.on('error', (e) => finish({ speech: -1, mic: false, error: 'spawn ' + e.message }));
    timer = setTimeout(() => finish({ speech: 0, mic: false, timedOut: true }), timeoutMs);
  });
}

module.exports = { Asr, probeAccess };
