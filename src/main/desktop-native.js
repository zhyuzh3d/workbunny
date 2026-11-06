'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { JsonLines, MAX_NATIVE_LINE_BYTES } = require('./json-lines');
const displayBridges=new Map();
const DISPLAY_OPS=new Set(['capture','visualSample','visualCommit','visualForget']);

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
    this.shareDisplay=options.sharedDisplay??!options.spawn;
    this.displayBridge=null;
    this.maxResponseLineBytes = options.maxResponseLineBytes || MAX_NATIVE_LINE_BYTES;
    this.proc = null;
    this.responses = new JsonLines(this.maxResponseLineBytes);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.terminal = false;
    this.stopPromise = null;
    this.recoveryGeneration = 0;
  }

  _start() {
    if (this.terminal) throw new Error('桌面原生客户端已关闭');
    if (this.stopPromise) throw new Error('桌面原生模块正在停止');
    if (this.proc && this.closed) throw new Error('桌面原生模块正在退出');
    if (this.proc && !this.closed) return;
    this.closed = false;
    this.responses.reset();
    let child;
    try { child = this.spawnProcess(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { throw new Error(`桌面原生模块启动失败：${error.message}`); }
    this.proc = child;
    child.stdout.on('data', chunk => { if (this.proc === child && !this.closed) this._onData(chunk); });
    child.stdout.on('error', error => this._break(child, new Error(`桌面原生 stdout 错误：${error.message}`)));
    child.stderr.on('data', chunk => this.emit('stderr', String(chunk).trim()));
    child.stderr.on('error', error => this.emit('stderrError', error));
    child.stdin.on('error', error => this._break(child, new Error(`桌面原生 stdin 错误：${error.message}`)));
    child.on('error', error => this._break(child, new Error(`桌面原生模块启动失败：${error.message}`)));
    child.on('close', (code, signal) => {
      if (this.proc === child) {
        this.proc = null;
        this.closed = true;
        this.responses.reset();
        this._failAll(new Error(`桌面原生模块已退出（code=${code}, signal=${signal || ''}）`));
      }
      this.emit('close', { code, signal });
    });
  }

  _onData(chunk) {
    try {
      this.responses.push(chunk, response => {
        if (!Number.isSafeInteger(response.id) || typeof response.ok !== 'boolean') throw new Error('Invalid desktop response');
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.result);
        else {
          const error = new Error(response.error || '桌面原生请求失败');
          if (typeof response.code === 'string') error.code = response.code;
          pending.reject(error);
        }
      });
    } catch (error) {
      this._break(this.proc, new Error(error.code === 'E_JSON_LINE_LIMIT'
        ? '桌面原生模块响应行超过 64 MiB' : '桌面原生模块返回无效响应'));
    }
  }

  _break(child, error) {
    if (this.proc !== child || this.closed) return;
    this.closed = true;
    this.responses.reset();
    this._failAll(error);
    try { child.kill('SIGKILL'); } catch {}
  }

  _failAll(error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  async request(op, payload = {}, timeoutMs = 12000) {
    if(this.shareDisplay&&DISPLAY_OPS.has(op)){
      if(this.terminal)throw new Error('桌面原生客户端已关闭');
      if(!this.displayBridge){
        const key=path.resolve(this.binaryPath);let bridge=displayBridges.get(key);
        if (bridge?.closing) {
          const generation = this.recoveryGeneration;
          await bridge.closing;
          if (generation !== this.recoveryGeneration) throw new Error('截图请求已取消');
          return this.request(op, payload, timeoutMs);
        }
        if(!bridge){bridge={native:new DesktopNative(this.binaryPath,{sharedDisplay:false,spawn:this.spawnProcess,maxResponseLineBytes:this.maxResponseLineBytes}),clients:new Set(),tail:Promise.resolve(),key};displayBridges.set(key,bridge);}
        bridge.clients.add(this);this.displayBridge=bridge;
      }
      const bridge=this.displayBridge,generation=this.recoveryGeneration;
      // A single system display connection owns all capture state. In this macOS
      // session, a second live helper's CGDisplayStream initializer hangs. GUI
      // clients keep independent input bridges; stopping one cannot kill capture
      // or replay another client's input.
      const execute=()=>{if(this.terminal||generation!==this.recoveryGeneration)throw new Error('截图请求已取消');return bridge.native.request(op,payload,timeoutMs);};
      const result=bridge.tail.then(execute);bridge.tail=result.catch(()=>{});
      const value=await result;if(this.terminal||generation!==this.recoveryGeneration)throw new Error('截图请求已取消');return value;
    }
    const generation = this.recoveryGeneration;
    for (let attempt = 0; ; attempt++) {
      try { return await this._requestOnce(op, attempt && op === 'capture' && payload.windowId ? { ...payload, captureMode: 'displayCrop' } : payload, timeoutMs); }
      catch (error) {
        const captureTimeout = (op === 'capture' || op === 'visualSample') &&
          (/^截图请求超时/.test(error.message) || error.message === `桌面原生请求超时：${op}`);
        if (!captureTimeout || generation !== this.recoveryGeneration || this.terminal) throw error;
        // A stuck SCK call can outlive its response; reap the whole bridge before
        // accepting another capture. In-flight writes are rejected, never replayed.
        await this._stop('截图超时恢复');
        if (op !== 'capture' || attempt !== 0 || generation !== this.recoveryGeneration || this.terminal) throw error;
      }
    }
  }

  _requestOnce(op, payload = {}, timeoutMs = 12000) {
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
      let onClose, didExit = false;
      const exited = new Promise(resolve => { onClose = resolve; child.once('close', resolve); });
      let killTimer, exitTimer;
      try {
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          if (this.proc === child) { try { child.kill('SIGKILL'); } catch {} }
        }, 500);
        const exitTimeout = new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('桌面原生模块未能退出')), 3000); });
        await Promise.race([exited, exitTimeout]);
        didExit = true;
      } finally {
        if (killTimer) clearTimeout(killTimer);
        if (exitTimer) clearTimeout(exitTimer);
        child.removeListener('close', onClose);
        if (this.proc === child && didExit) this.proc = null;
        this.closed = true;
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  async close() {
    this.recoveryGeneration++;
    this.terminal = true;
    try {
      await this._stop('close');
    } finally {
      const bridge = this.displayBridge;
      if (bridge) {
        this.displayBridge = null;
        bridge.clients.delete(this);
        if (!bridge.clients.size) {
          const remove = () => { if (displayBridges.get(bridge.key) === bridge) displayBridges.delete(bridge.key); };
          // Leave the closing bridge registered until its display lease has
          // actually been released by process exit.
          bridge.closing = bridge.native.close().finally(() => {
            if (!bridge.native.proc) remove();
            else bridge.native.once('close', remove);
          });
          await bridge.closing;
        }
      }
    }
  }

  cancel() {
    this.recoveryGeneration++;
    return this._stop('cancel');
  }
}

module.exports = { DesktopNative, defaultBinary };
