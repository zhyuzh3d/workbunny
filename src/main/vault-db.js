'use strict';

const { spawn } = require('child_process');

const MAX_LINE = 16 * 1024 * 1024;

class VaultDB {
  constructor({ bin, file, timeoutMs = 30000 } = {}) {
    if (!bin || !file) throw new TypeError('VaultDB requires bin and file paths');
    this.bin = bin;
    this.file = file;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.started = false;
    this._closePromise = null;
  }

  async init() {
    if (this.closed) throw new Error('VaultDB is closed');
    if (!this.started) this._start();
    if (!this._initPromise) this._initPromise = this.request('stats');
    return this._initPromise;
  }

  _start() {
    this.started = true;
    const child = spawn(this.bin, [this.file], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stdout.on('error', (error) => this._fail(error));
    child.stdin.on('error', (error) => this._fail(error));
    child.on('error', (error) => this._fail(error));
    child.on('close', (code, signal) => {
      const reason = new Error(`Vault process closed (${signal || code})`);
      this._fail(reason);
      this.closed = true;
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_LINE && this.buffer.indexOf(10) < 0) {
      this._fail(new Error('Vault response exceeded 16 MB'));
      this.child?.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_LINE) {
        this._fail(new Error('Vault response exceeded 16 MB'));
        this.child?.kill();
        return;
      }
      if (!line.length) continue;
      let response;
      try { response = JSON.parse(line.toString('utf8')); }
      catch { this._fail(new Error('Invalid response from vault process')); this.child?.kill(); return; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (!response.ok) {
        const error = new Error(`Vault request failed: ${response.error || 'unknown_error'}`);
        error.code = response.error || 'unknown_error';
        error.requestId = response.id;
        pending.reject(error);
      } else {
        delete response.id;
        delete response.ok;
        pending.resolve(response);
      }
    }
  }

  _fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  request(op, payload = {}) {
    if (!this.started || !this.child) return Promise.reject(new Error('VaultDB.init() must be called first'));
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) return Promise.reject(new Error('VaultDB is closed'));
    if (typeof op !== 'string' || !op || !payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.reject(new TypeError('Invalid vault request'));
    const id = this.nextId++;
    const wirePayload = { ...payload };
    if (op === 'remove' && Object.hasOwn(payload, 'id')) {
      wirePayload.recordId = payload.id;
      delete wirePayload.id;
    }
    wirePayload.id = id;
    wirePayload.op = op;
    const message = Buffer.from(JSON.stringify(wirePayload) + '\n', 'utf8');
    if (message.length > MAX_LINE) return Promise.reject(new Error('Vault request exceeded 16 MB'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Vault request timed out: ${op}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(message, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this.closed = true;
    this._closePromise = (async () => {
      if (!this.child) return;
      this._fail(new Error('VaultDB closed'));
      const child = this.child;
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    })();
    return this._closePromise;
  }
}

module.exports = { VaultDB };
