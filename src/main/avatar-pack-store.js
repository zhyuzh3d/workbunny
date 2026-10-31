'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectAvatarPack } = require('./avatar-pack-reader');
const { MAX_ARCHIVE } = require('./avatar-pack-zip');

const KEY = /^(?:pack_[a-f0-9]{32}|builtin_soft_bunny)$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assert(condition, message) { if (!condition) throw Error(message); }
function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid avatar pack directory');
}
function readRegular(file, max) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max, 'invalid avatar pack file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = fs.fstatSync(fd);
    assert(current.isFile() && current.size <= max && current.dev === stat.dev && current.ino === stat.ino, 'avatar pack changed while reading');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function validEntry(item) {
  return item && KEY.test(item.key || '') && HASH.test(item.digest || '') &&
    typeof item.id === 'string' && typeof item.version === 'string' && typeof item.name === 'string';
}

// Two-phase installation: prepare validates and stages; the caller commits only
// after the renderer has actually loaded the candidate. Index replacement is
// atomic and never deletes the currently installed object on failure.
class AvatarPackStore {
  constructor(userData, { inspect = inspectAvatarPack } = {}) {
    this.root = path.join(userData, 'avatar-packs');
    this.objects = path.join(this.root, 'objects');
    this.staging = path.join(this.root, 'staging');
    this.indexPath = path.join(this.root, 'index.json');
    this.inspect = inspect;
    this.pending = new Map();
    ensureDirectory(this.root); ensureDirectory(this.objects); ensureDirectory(this.staging);
  }

  index() {
    if (!fs.existsSync(this.indexPath)) return { version: 1, items: [] };
    let data;
    try { data = JSON.parse(readRegular(this.indexPath, 1024 * 1024).toString('utf8')); }
    catch { throw Error('invalid avatar pack index'); }
    assert(data?.version === 1 && Array.isArray(data.items) && data.items.length <= 256, 'invalid avatar pack index');
    const keys = new Set();
    for (const item of data.items) {
      assert(validEntry(item) && !keys.has(item.key) && (!item.previous || validEntry(item.previous) && item.previous.key === item.key), 'invalid avatar pack index entry');
      keys.add(item.key);
    }
    return data;
  }

  writeIndex(items) {
    assert(items.length <= 256, 'too many installed avatar packs');
    const temporary = path.join(this.root, '.index-' + crypto.randomUUID() + '.tmp');
    try { writeExclusive(temporary, JSON.stringify({ version: 1, items })); fs.renameSync(temporary, this.indexPath); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }

  async prepare(bytes, { targetKey, allowBuiltinOverride = false } = {}) {
    assert(Buffer.isBuffer(bytes) && bytes.length <= MAX_ARCHIVE, 'invalid avatar pack');
    const snapshot = Buffer.from(bytes);
    const inspected = await this.inspect(snapshot);
    const index = this.index(), previous = targetKey ? index.items.find(item => item.key === targetKey) : null;
    assert(!targetKey || KEY.test(targetKey) && (previous || (targetKey === 'builtin_soft_bunny' && allowBuiltinOverride)), 'avatar pack to replace was not found');
    const key = targetKey || 'pack_' + crypto.randomUUID().replaceAll('-', '');
    const token = crypto.randomUUID().replaceAll('-', ''), temporary = path.join(this.staging, token + '.tmp');
    writeExclusive(temporary, snapshot);
    const entry = { key, id: inspected.metadata.id, version: inspected.metadata.version,
      name: inspected.manifest.character.name, digest: digest(snapshot) };
    this.pending.set(token, { key, temporary, entry, previousDigest: previous?.digest || null, inspected });
    return { token, entry: { ...entry }, inspected };
  }

  commit(token) {
    const pending = this.pending.get(token);
    assert(pending, 'avatar pack staging expired');
    const index = this.index(), existing = index.items.find(item => item.key === pending.key);
    assert((existing?.digest || null) === pending.previousDigest, 'avatar pack changed while staging');
    const staged = readRegular(pending.temporary, MAX_ARCHIVE);
    assert(digest(staged) === pending.entry.digest, 'staged avatar pack changed');
    const object = path.join(this.objects, pending.entry.digest + '.wbavatar');
    try { fs.linkSync(pending.temporary, object); }
    catch (error) {
      if (error.code !== 'EEXIST' || digest(readRegular(object, MAX_ARCHIVE)) !== pending.entry.digest) throw error;
    }
    const items = index.items.filter(item => item.key !== pending.key);
    const previous = existing ? { key: existing.key, id: existing.id, version: existing.version, name: existing.name, digest: existing.digest } : null;
    const entry = previous ? { ...pending.entry, previous } : pending.entry;
    items.push(entry);
    this.writeIndex(items);
    this.pending.delete(token);
    try { fs.unlinkSync(pending.temporary); } catch {}
    return { ...entry };
  }

  discard(token) {
    const pending = this.pending.get(token);
    if (!pending) return false;
    this.pending.delete(token);
    try { fs.unlinkSync(pending.temporary); } catch {}
    return true;
  }

  async read(key) {
    assert(KEY.test(key || ''), 'invalid avatar pack key');
    const entry = this.index().items.find(item => item.key === key);
    assert(entry, 'avatar pack not found');
    const bytes = readRegular(path.join(this.objects, entry.digest + '.wbavatar'), MAX_ARCHIVE);
    assert(digest(bytes) === entry.digest, 'avatar pack checksum mismatch');
    const inspected = await this.inspect(bytes);
    assert(inspected.metadata.id === entry.id && inspected.metadata.version === entry.version, 'avatar pack metadata mismatch');
    return { entry: { ...entry }, inspected };
  }

  async rollback(key, { expectedDigest } = {}) {
    assert(KEY.test(key || ''), 'invalid avatar pack key');
    const before = this.index().items.find(item => item.key === key);
    assert(before?.previous, 'no prior avatar pack version');
    assert(!expectedDigest || before.digest === expectedDigest, 'avatar pack changed before rollback');
    const previous = before.previous, bytes = readRegular(path.join(this.objects, previous.digest + '.wbavatar'), MAX_ARCHIVE);
    assert(digest(bytes) === previous.digest, 'prior avatar pack checksum mismatch');
    const inspected = await this.inspect(bytes);
    assert(inspected.metadata.id === previous.id && inspected.metadata.version === previous.version, 'prior avatar pack metadata mismatch');
    const index = this.index(), current = index.items.find(item => item.key === key);
    assert(current?.digest === before.digest && current.previous?.digest === previous.digest, 'avatar pack changed while rolling back');
    const restored = { ...previous, previous: { key: current.key, id: current.id, version: current.version, name: current.name, digest: current.digest } };
    this.writeIndex([...index.items.filter(item => item.key !== key), restored]);
    return { entry: restored, inspected };
  }

  remove(key) {
    assert(KEY.test(key || ''), 'invalid avatar pack key');
    const index = this.index(), removed = index.items.find(item => item.key === key), items = index.items.filter(item => item.key !== key);
    assert(items.length !== index.items.length, 'avatar pack not found');
    this.writeIndex(items);
    const used = new Set(items.flatMap(item => [item.digest, item.previous?.digest].filter(Boolean)));
    for (const hash of [removed.digest, removed.previous?.digest].filter(Boolean)) if (!used.has(hash)) {
      try { const file = path.join(this.objects, hash + '.wbavatar'); const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file); } catch {}
    }
  }
}

module.exports = { AvatarPackStore };
