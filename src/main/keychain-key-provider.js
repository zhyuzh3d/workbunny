'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicPrivate } = require('./vault-crypto');

const FAILURE = '本机记忆钥匙不可用';
const MAX_OUTPUT = 8 * 1024;
const validAccount = value => typeof value === 'string' && /^vault-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function validateDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir ||
      path.basename(dir) !== 'vault' || dir === path.parse(dir).root || dir.length > 4096 || /[\u0000-\u001f\u007f]/.test(dir)) throw new Error(FAILURE);
}

function accountFor(dir) {
  const file = path.join(dir, 'key-provider.json');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(FAILURE);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(file, flags);
    let raw;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > 4096) throw new Error(FAILURE);
      raw = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || value.version !== 1 || !validAccount(value.account) || Object.keys(value).some(k => !['version', 'account'].includes(k))) throw new Error(FAILURE);
    return { file, account: value.account };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(FAILURE);
  }
  const account = `vault-${crypto.randomUUID()}`;
  atomicPrivate(file, JSON.stringify({ version: 1, account }));
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(FAILURE);
  return { file, account };
}

function parseLine(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_OUTPUT || bytes.at(-1) !== 0x0a) throw new Error(FAILURE);
  const text = bytes.toString('utf8');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 1) throw new Error(FAILURE);
  let result;
  try { result = JSON.parse(lines[0]); } catch { throw new Error(FAILURE); }
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(FAILURE);
  return result;
}

function keyFromResult(result) {
  if (result.ok !== true || typeof result.key !== 'string' || Object.keys(result).some(k => !['ok', 'key'].includes(k))) throw new Error(FAILURE);
  const key = Buffer.from(result.key, 'base64');
  if (key.length !== 32 || key.toString('base64') !== result.key) { key.fill(0); throw new Error(FAILURE); }
  return key;
}

function helperCall(binary, request, { spawn, signal, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(new Error(FAILURE));
  return new Promise((resolve, reject) => {
    let child, settled = false, outputBytes = 0, stdoutBytes = 0, stderrBytes = 0, timer, inputBuffer;
    const stdout = [];
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      inputBuffer?.fill(0); inputBuffer = undefined;
      stdout.forEach(chunk => chunk.fill(0)); stdout.length = 0;
    };
    const kill = () => { try { child?.kill('SIGKILL'); } catch {} };
    const fail = () => {
      if (settled) return;
      settled = true; cleanup(); kill(); reject(new Error(FAILURE));
    };
    const abort = () => fail();
    try { child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { fail(); return; }
    if (!child?.stdin?.end || !child.stdout?.on || !child.stderr?.on || !child.on) { fail(); return; }
    const count = chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT) fail();
    };
    child.stdout.on('data', chunk => {
      if (settled) return;
      count(chunk);
      if (!settled) { const copy = Buffer.from(chunk); stdout.push(copy); stdoutBytes += copy.length; }
    });
    child.stderr.on('data', chunk => { if (!settled) { count(chunk); stderrBytes += Buffer.byteLength(chunk); } });
    child.stdout.on('error', fail); child.stderr.on('error', fail); child.stdin.on?.('error', fail); child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      const bytes = Buffer.concat(stdout, stdoutBytes);
      try {
        if (code !== 0 || stderrBytes) throw new Error(FAILURE);
        const result = parseLine(bytes);
        settled = true; cleanup(); resolve(result);
      } catch { fail(); }
      finally { bytes.fill(0); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(fail, timeoutMs);
    inputBuffer = Buffer.from(JSON.stringify(request) + '\n', 'utf8');
    if (typeof request.key === 'string') request.key = '';
    try { child.stdin.end(inputBuffer, () => { inputBuffer?.fill(0); inputBuffer = undefined; }); }
    catch { inputBuffer?.fill(0); inputBuffer = undefined; fail(); }
  });
}

async function openKey({ dir, binary, legacyOpen, signal, spawn = childProcess.spawn, timeoutMs = 120000 } = {}) {
  let master;
  try {
    validateDir(dir);
    if (typeof binary !== 'string' || !path.isAbsolute(binary) || /[\u0000-\u001f\u007f]/.test(binary) ||
        typeof spawn !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
        (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean'))) throw new Error(FAILURE);
    if (signal?.aborted) throw new Error(FAILURE);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(FAILURE);
    const { account } = accountFor(dir);
    const read = await helperCall(binary, { op: 'read', account }, { spawn, signal, timeoutMs });
    if (read.ok === true) {
      const key = keyFromResult(read);
      read.key = '';
      if (signal?.aborted) { key.fill(0); throw new Error(FAILURE); }
      return key;
    }
    if (!(read.ok === false && read.error === 'not_found' && Object.keys(read).length === 2)) throw new Error(FAILURE);
    if (typeof legacyOpen !== 'function' || signal?.aborted) throw new Error(FAILURE);
    try { master = await legacyOpen(); } catch { throw new Error(FAILURE); }
    if (!Buffer.isBuffer(master) || master.length !== 32 || signal?.aborted) throw new Error(FAILURE);
    const imported = await helperCall(binary, { op: 'import', account, key: master.toString('base64') }, { spawn, signal, timeoutMs });
    if (!(imported.ok === true && ((imported.imported === true && Object.keys(imported).length === 2) ||
        (imported.already_present === true && Object.keys(imported).length === 2)))) throw new Error(FAILURE);
    const verify = await helperCall(binary, { op: 'read', account }, { spawn, signal, timeoutMs });
    const verified = keyFromResult(verify);
    verify.key = '';
    const equal = crypto.timingSafeEqual(master, verified);
    verified.fill(0);
    if (!equal || signal?.aborted) throw new Error(FAILURE);
    const result = master; master = undefined;
    return result;
  } catch { throw new Error(FAILURE); }
  finally { if (Buffer.isBuffer(master)) master.fill(0); }
}

module.exports = { openKey };
