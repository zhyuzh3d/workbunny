'use strict';

const { spawn } = require('child_process');
const { JsonLines, MAX_NATIVE_LINE_BYTES } = require('./json-lines');
// An encoded SQLite row can carry up to 2 MiB before JSON framing.
const VAULT_PAGE_SIZE = 24;

const NATIVE_VAULT_CODES=new Set(['checkpoint_busy','database_in_use','database_moved_snapshot','database_open_failed','database_operation_failed','database_permissions_failed','database_version_newer','invalid_record','invalid_request','invalid_source','restore_requires_empty_database','sequence_exhausted','stale_epoch','unknown_operation']);
const VAULT_OPERATIONS=new Set(['begin_restore','checkpoint','clear','end_restore','get','memory_sample','query','remove','search','stats','write']);
function vaultErrorDiagnostic(error){
 const result={};if(NATIVE_VAULT_CODES.has(error?.code))result.nativeCode=error.code;
 if(VAULT_OPERATIONS.has(error?.vaultOperation))result.operation=error.vaultOperation;
 if(Number.isSafeInteger(error?.requestId)&&error.requestId>0)result.requestId=error.requestId;
 return Object.keys(result).length?result:null;
}

class VaultDB {
  constructor({ bin, file, timeoutMs = 30000 } = {}) {
    if (!bin || !file) throw new TypeError('VaultDB requires bin and file paths');
    this.bin = bin;
    this.file = file;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.responses = new JsonLines();
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
    child.stdout.on('data', chunk => { if (!this.closed) this._onData(chunk); });
    child.stdout.on('error', error => this._break(error));
    child.stdin.on('error', error => this._break(error));
    child.on('error', error => this._break(error));
    child.on('close', (code, signal) => {
      const reason = new Error(`Vault process closed (${signal || code})`);
      this.responses.reset();
      this._fail(reason);
      this.closed = true;
    });
  }

  _onData(chunk) {
    try {
      this.responses.push(chunk, response => {
        if (response.type === 'fatal') {
          const messages = { database_in_use: '资料库正被另一个 Bunny 进程使用，请先退出该进程', database_moved_snapshot: '此目录是迁移前的快照，请连接当前资料库', database_version_newer: '资料库来自更新版本，请使用更新版本打开' };
          const error = new Error(messages[response.error] || '资料库无法打开，请检查位置、权限或备份');
          error.code = response.error;
          this.closed = true;
          this._fail(error);
          return false;
        }
        const { id, ok, ...result } = response;
        if (!Number.isSafeInteger(id) || typeof ok !== 'boolean') throw new Error('Invalid vault response');
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (ok) pending.resolve(result);
        else {
          const error = new Error(`Vault request failed: ${result.error || 'unknown_error'}`);
          error.code = result.error || 'unknown_error';
          error.requestId = id;error.vaultOperation=pending.op;
          pending.reject(error);
        }
      });
    } catch (error) {
      this._break(new Error(error.code === 'E_JSON_LINE_LIMIT'
        ? 'Vault response exceeded 64 MiB' : 'Invalid response from vault process'));
    }
  }

  _break(error) {
    if (this.closed) return;
    this.closed = true;
    this.responses.reset();
    this._fail(error);
    this.child?.kill('SIGKILL');
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
    let message;
    try { message = JSON.stringify(wirePayload); }
    catch (error) { return Promise.reject(error); }
    if (Buffer.byteLength(message) > MAX_NATIVE_LINE_BYTES) return Promise.reject(new Error('Vault request exceeded 64 MiB'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Vault request timed out: ${op}`), { code: 'E_VAULT_TIMEOUT', requestId: id,vaultOperation:op }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer,op });
      const writeFailed = error => {
        if (!error || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      };
      try { this.child.stdin.write(message + '\n', writeFailed); }
      catch (error) { writeFailed(error); }
    });
  }

  close({ strict = false } = {}) {
    if (this._closePromise) return this._closePromise;
    this.closed = true;
    this._closePromise = (async () => {
      if (!this.child) return;
      this._fail(new Error('VaultDB closed'));
      const child = this.child;
      await new Promise((resolve, reject) => {
        const finished = code => {
          if (strict && code !== 0) reject(new Error('资料库退出异常'));
          else resolve();
        };
        if (child.exitCode !== null || child.signalCode !== null) return finished(child.exitCode);
        const timer = setTimeout(() => { child.kill(); strict ? reject(new Error('资料库未能安全关闭')) : resolve(); }, 5000);
        child.once('close', code => { clearTimeout(timer); finished(code); });
        child.stdin.end();
      });
    })();
    return this._closePromise;
  }
}

module.exports = { VaultDB, VAULT_PAGE_SIZE,vaultErrorDiagnostic };
