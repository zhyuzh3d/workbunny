'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function defaultBinary() {
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'bin', 'desktop')
    : path.join(__dirname, '..', '..', 'bin', 'desktop');
}

/** Persistent client for the bounded native desktop JSONL bridge. */
class DesktopNative extends EventEmitter {
  constructor(binaryPath = defaultBinary(), options = {}) {
    super();
    this.binaryPath = binaryPath;
    this.spawnProcess = options.spawn || spawn;
    this.maxResponseLineBytes = options.maxResponseLineBytes || 64 * 1024 * 1024;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.terminal = false;
    this.stopPromise = null;
  }

  _start() {
    if (this.terminal) throw new Error('桌面原生客户端已关闭');
    if (this.stopPromise) throw new Error('桌面原生模块正在停止');
    if (this.proc && this.closed) throw new Error('桌面原生模块正在退出');
    if (this.proc && !this.closed) return;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    let child;
    try { child = this.spawnProcess(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { throw new Error(`桌面原生模块启动失败：${error.message}`); }
    this.proc = child;
    child.stdout.on('data', chunk => this._onData(chunk));
    child.stdout.on('error', error => {
      this.closed = true;
      this._failAll(new Error(`桌面原生 stdout 错误：${error.message}`));
      try { child.kill('SIGKILL'); } catch {}
    });
    child.stderr.on('data', chunk => this.emit('stderr', String(chunk).trim()));
    child.stderr.on('error', error => this.emit('stderrError', error));
    child.stdin.on('error', error => {
      this.closed = true;
      this._failAll(new Error(`桌面原生 stdin 错误：${error.message}`));
      try { child.kill('SIGKILL'); } catch {}
    });
    child.on('error', error => this._failAll(new Error(`桌面原生模块启动失败：${error.message}`)));
    child.on('close', (code, signal) => {
      if (this.proc === child) {
        this.proc = null;
        this.closed = true;
        this._failAll(new Error(`桌面原生模块已退出（code=${code}, signal=${signal || ''}）`));
      }
      this.emit('close', { code, signal });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let index;
    while ((index = this.buffer.indexOf(0x0a)) >= 0) {
      if (index > this.maxResponseLineBytes) return this._protocolOverflow();
      const line = this.buffer.subarray(0, index).toString('utf8').trim();
      this.buffer = this.buffer.subarray(index + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch { this.emit('protocolError', line.slice(0, 300)); continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error || '桌面原生请求失败'));
    }
    if (this.buffer.length > this.maxResponseLineBytes) this._protocolOverflow();
  }

  _protocolOverflow() {
    this.closed = true;
    this._failAll(new Error('桌面原生模块响应行超过 64 MiB'));
    try { this.proc?.kill('SIGKILL'); } catch {}
  }

  _failAll(error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  request(op, payload = {}, timeoutMs = 12000) {
    if (typeof op !== 'string' || !op || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Promise.reject(new TypeError('op 和对象 payload 为必填项'));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new RangeError('timeoutMs 须为 1 至 30000 毫秒'));
    }
    try { this._start(); } catch (error) { return Promise.reject(error); }
    const id = this.nextId++;
    const message = { ...payload, id, op, timeoutMs, sentAtMs: Date.now() };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`桌面原生请求超时：${op}`));
      }, timeoutMs + 500);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async _stop(reason) {
    if (this.stopPromise) return this.stopPromise;
    const child = this.proc;
    this.closed = true;
    this._failAll(new Error(`桌面原生请求已取消：${reason}`));
    if (!child) return;
    this.stopPromise = (async () => {
      let onClose;
      const exited = new Promise(resolve => { onClose = resolve; child.once('close', resolve); });
      let killTimer, exitTimer;
      try {
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          if (this.proc === child) { try { child.kill('SIGKILL'); } catch {} }
        }, 500);
        const exitTimeout = new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('桌面原生模块未能退出')), 3000); });
        await Promise.race([exited, exitTimeout]);
      } finally {
        if (killTimer) clearTimeout(killTimer);
        if (exitTimer) clearTimeout(exitTimer);
        child.removeListener('close', onClose);
        if (this.proc === child) this.proc = null;
        this.closed = true;
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  close() {
    this.terminal = true;
    return this._stop('close');
  }

  cancel() {
    return this._stop('cancel');
  }
}

module.exports = { DesktopNative, defaultBinary };
