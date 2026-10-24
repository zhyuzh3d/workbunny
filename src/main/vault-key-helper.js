'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vc = require('./vault-crypto');

const FLAG = '--workbunny-vault-key';
const GENERIC_ERROR = '无法解锁本机记忆钥匙';

function vaultPathFromArgv(argv) {
  if (!Array.isArray(argv)) throw new Error(GENERIC_ERROR);
  const positions = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === FLAG) positions.push(i);
  if (positions.length !== 1) throw new Error(GENERIC_ERROR);
  const index = positions[0], value = argv[index + 1];
  if (index + 2 !== argv.length || typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root || path.basename(value) !== 'vault') {
    throw new Error(GENERIC_ERROR);
  }
  return value;
}

function authorizedNativeParent(resourcesPath = process.resourcesPath) {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath) || /[\u0000-\u001f\u007f]/.test(resourcesPath)) return false;
  const verifier = path.join(resourcesPath, 'bin', 'vault');
  try {
    const output = execFileSync(verifier, ['--verify-key-parent'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (typeof output !== 'string' || !output.endsWith('\n')) return false;
    const lines = output.slice(0, -1).split('\n');
    if (lines.length !== 1) return false;
    const response = JSON.parse(lines[0]);
    return !!response && typeof response === 'object' && !Array.isArray(response) &&
      Object.keys(response).length === 1 && response.authorized === true;
  } catch { return false; }
}

function start({ argv = process.argv, app, safeStorage, stdout = process.stdout } = {}) {
  if (!app || !safeStorage) {
    try {
      const electron = require('electron');
      app = app || electron.app; safeStorage = safeStorage || electron.safeStorage;
    }
    catch { return Promise.resolve(false); }
  }
  let completed = false;
  const exitOnce = code => { if (completed) return; completed = true; app.exit(code); };
  const writeResult = (value, code) => {
    const line = `${JSON.stringify(value)}\n`;
    try {
      stdout.write(line, error => exitOnce(error ? 1 : code));
    } catch {
      exitOnce(1);
    }
  };
  stdout.once?.('error', () => exitOnce(1));

  try { app.setName('workbunny'); }
  catch { writeResult({ ok: false, error: GENERIC_ERROR }, 1); return Promise.resolve(false); }
  return Promise.resolve().then(() => app.whenReady()).then(async () => {
    let key;
    try {
      const dir = vaultPathFromArgv(argv);
      // Native code verifies the real kernel process chain; argv and process names are not authority.
      if (!authorizedNativeParent()) throw new Error(GENERIC_ERROR);
      key = vc.openKey(dir, safeStorage);
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(GENERIC_ERROR);
      // The keychain prompt may have outlived the authorized parent; attest again before release.
      if (!authorizedNativeParent()) throw new Error(GENERIC_ERROR);
      writeResult({ ok: true, key: key.toString('base64') }, 0);
      key.fill(0);
      return true;
    } catch {
      key?.fill?.(0);
      writeResult({ ok: false, error: GENERIC_ERROR }, 1);
      return false;
    }
  }).catch(() => {
    writeResult({ ok: false, error: GENERIC_ERROR }, 1);
    return false;
  });
}

module.exports = { start };
