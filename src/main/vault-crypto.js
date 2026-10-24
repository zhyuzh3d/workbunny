'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function atomicPrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file); fs.chmodSync(file, 0o600);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
}

function seal(key, value, aad) {
  const nonce = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, c.getAuthTag(), data]).toString('base64');
}
function unseal(key, value, aad) {
  const b = Buffer.from(value, 'base64');
  if (b.length < 30 || b[0] !== 1) throw new Error('资料格式不受支持');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(b.subarray(13, 29));
  return JSON.parse(Buffer.concat([d.update(b.subarray(29)), d.final()]).toString('utf8'));
}
function openKey(dir, safeStorage) {
  if (!safeStorage?.isEncryptionAvailable()) throw new Error('本机加密钥匙不可用，记忆已锁定');
  const file = path.join(dir, 'key-envelope');
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('记忆钥匙文件不可信');
    const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(file)), 'base64');
    if (key.length !== 32) throw new Error('无法解锁原有记忆，请恢复备份');
    return key;
  }
  if (fs.existsSync(path.join(dir, 'companion.db'))) throw new Error('记忆钥匙缺失，保留资料库等待恢复');
  const key = crypto.randomBytes(32);
  atomicPrivate(file, safeStorage.encryptString(key.toString('base64')));
  return key;
}
// Latin words + Unicode word segmentation + CJK bigrams. Never store raw terms.
function terms(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  const out = new Set(s.match(/[\p{L}\p{N}_-]+/gu)?.filter(x => !/[\u3400-\u9fff]/u.test(x)) || []);
  for (const m of s.matchAll(/[\u3400-\u9fff]+/gu)) {
    const a = [...m[0]];
    if (a.length === 1) out.add(a[0]);
    for (let i = 0; i < a.length - 1; i++) out.add(a[i] + a[i + 1]);
  }
  for (const x of new Intl.Segmenter('zh', { granularity: 'word' }).segment(s))
    if (x.isWordLike && x.segment.length > 1) out.add(x.segment);
  const aliases = [['生日', 'birthday'], ['喜欢', '偏好', 'like', 'prefer'], ['约定', '答应', 'promise'], ['名字', '称呼', 'name'], ['节日', '过节', 'holiday']];
  for (const group of aliases) if (group.some(x => s.includes(x))) group.forEach(x => out.add(x));
  return [...out].filter(x => x.length <= 80 && !['的', '了', '是', '一个', 'the', 'and', 'this', 'that', '什么', '怎么'].includes(x)).slice(0, 512);
}
function tokenKeys(key, text, limit = 512) {
  const indexKey = crypto.createHmac('sha256', key).update('workbunny-search-v1').digest();
  return terms(text).slice(0, limit).map(t => crypto.createHmac('sha256', indexKey).update(t).digest().subarray(0, 16).toString('base64url'));
}
async function exportEnvelope(value, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 10 || passphrase.length > 1024) throw new Error('备份密码至少 10 个字符');
  const salt = crypto.randomBytes(16);
  const key = await new Promise((r, j) => crypto.scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? j(e) : r(k)));
  try { return JSON.stringify({ format: 'workbunny-vault', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('base64'), body: seal(key, value, 'portable-v1') }); }
  finally { key.fill(0); }
}
async function importEnvelope(text, passphrase) {
  const v = JSON.parse(text);
  if (v.format !== 'workbunny-vault' || v.version !== 1 || v.kdf !== 'scrypt-32768-8-1') throw new Error('不是受支持的 workbunny 备份');
  const salt = Buffer.from(v.salt, 'base64'); if (salt.length !== 16) throw new Error('备份损坏');
  const key = await new Promise((r, j) => crypto.scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? j(e) : r(k)));
  try { return unseal(key, v.body, 'portable-v1'); } finally { key.fill(0); }
}
module.exports = { atomicPrivate, openKey, seal, unseal, terms, tokenKeys, exportEnvelope, importEnvelope };
