'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const FLAG = '--workbunny-vault-key';
const MAX_OUTPUT = 8 * 1024;
const GENERIC_FAILURE = '本机记忆钥匙辅助进程失败';

function validateOptions({ execPath, appPath, dir, timeoutMs, signal }) {
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath) || /[\u0000-\u001f\u007f]/.test(execPath)) throw new Error(GENERIC_FAILURE);
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath) || /[\u0000-\u001f\u007f]/.test(appPath)) throw new Error(GENERIC_FAILURE);
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir || dir === path.parse(dir).root || path.basename(dir) !== 'vault' || dir.length > 4096 || /[\u0000-\u001f\u007f]/.test(dir)) throw new Error(GENERIC_FAILURE);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error(GENERIC_FAILURE);
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new Error(GENERIC_FAILURE);
}

function parseKeyOutput(bytes, code) {
  if (code !== 0 || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_OUTPUT) throw new Error(GENERIC_FAILURE);
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error(GENERIC_FAILURE);
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 1) throw new Error(GENERIC_FAILURE);
  let parsed;
  try { parsed = JSON.parse(lines[0]); } catch { throw new Error(GENERIC_FAILURE); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== true || typeof parsed.key !== 'string' || Object.keys(parsed).some(k => !['ok', 'key'].includes(k))) throw new Error(GENERIC_FAILURE);
  const key = Buffer.from(parsed.key, 'base64');
  if (key.length !== 32 || key.toString('base64') !== parsed.key) {
    key.fill(0);
    throw new Error(GENERIC_FAILURE);
  }
  return key;
}

function openKey({ execPath, appPath, dir, timeoutMs = 120000, spawn = childProcess.spawn, signal } = {}) {
  try { validateOptions({ execPath, appPath, dir, timeoutMs, signal }); }
  catch { return Promise.reject(new Error(GENERIC_FAILURE)); }
  if (typeof spawn !== 'function') return Promise.reject(new Error(GENERIC_FAILURE));
  if (signal?.aborted) return Promise.reject(new Error(GENERIC_FAILURE));

  return new Promise((resolve, reject) => {
    let child, settled = false, outputBytes = 0, stdoutBytes = 0;
    const stdoutChunks = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const chunk of stdoutChunks) chunk.fill(0);
      stdoutChunks.length = 0;
    };
    const kill = () => { try { child?.kill('SIGKILL'); } catch {} };
    const fail = () => {
      if (settled) return;
      settled = true; cleanup(); kill(); reject(new Error(GENERIC_FAILURE));
    };
    const onAbort = () => fail();

    try {
      child = spawn(execPath, [appPath, FLAG, dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { fail(); return; }
    if (!child || !child.stdout?.on || !child.stderr?.on || !child.on) { fail(); return; }

    const countOutput = chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT) fail();
    };
    child.stdout.on('data', chunk => {
      if (settled) return;
      countOutput(chunk);
      if (!settled) { const data = Buffer.from(chunk); stdoutChunks.push(data); stdoutBytes += data.length; }
    });
    child.stderr.on('data', chunk => { if (!settled) countOutput(chunk); }); // Drain but never retain or expose stderr.
    child.stdout.on('error', () => fail());
    child.stderr.on('error', () => fail());
    child.on('error', () => fail());
    child.on('close', code => {
      if (settled) return;
      const output = Buffer.concat(stdoutChunks, stdoutBytes);
      try {
        const key = parseKeyOutput(output, code);
        settled = true; cleanup(); resolve(key);
      } catch { fail(); }
      finally { output.fill(0); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(fail, timeoutMs);
  });
}

module.exports = { openKey };
