'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { atomicPrivate } = require('./vault-crypto');
const sha = file => {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, size)); return h.digest('hex'); } finally { fs.closeSync(fd); }
};
function read(file) { try { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid()) throw new Error('untrusted'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid'); return value; } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('数据库位置记录损坏，请恢复位置设置'); } }
function inspect(binary, file) { return JSON.parse(execFileSync(binary, ['--inspect-copy', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 })); }
class DataLocation {
  constructor(home, binary) { this.home = home; this.binary = binary; this.pointer = path.join(home, 'storage-location.json'); this.journal = path.join(home, 'storage-migration.json'); }
  resolve() {
    const p = read(this.pointer), j = read(this.journal);
    if (j) this.validateJournal(j);
    if (!this.recoveryChecked && !p && j) {
      if (j.phase === 'activated' || (['verified','prepared'].includes(j.phase) && fs.existsSync(j.target))) throw new Error('数据库位置记录缺失，请重新选择原迁移目录');
      if (j.permissions) this.restorePermissions(j.source, j.permissions);
      if (j.source && fs.existsSync(path.join(j.source, '.migration-snapshot.json'))) fs.unlinkSync(path.join(j.source, '.migration-snapshot.json'));
      if (fs.existsSync(j.temp)) { if (fs.lstatSync(j.temp).isSymbolicLink()) throw new Error('迁移暂存目录不可信'); fs.rmSync(j.temp, { recursive: true }); }
    }
    const dir = p ? p.dir : path.join(this.home, 'vault');
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.basename(dir) !== 'vault' || p && p.format !== 'workbunny-location/v1') throw new Error('数据库位置无效');
    if (p && (!fs.existsSync(path.join(dir, 'companion.db')) || fs.lstatSync(dir).isSymbolicLink())) throw new Error('数据库目录不可用，请连接原磁盘或重新选择已有数据库');
    if (fs.existsSync(path.join(dir, '.migration-snapshot.json'))) throw new Error('此目录是迁移前的快照，请使用当前数据库或按备份恢复');
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('数据库目录不允许使用符号链接');
    this.recoveryChecked = true; this.dir = dir; return dir;
  }
  status() { if (this.busy) return { ok: true, dir: this.dir, busy: true }; try { return { ok: true, dir: this.resolve(), busy: !!this.busy }; } catch (e) { return { ok: false, error: e.message, busy: !!this.busy }; } }
  validateJournal(j) {
    if (j.format !== 'workbunny-move/v1' || !/^[a-f0-9-]{36}$/.test(j.id) || !['checked','quiesced','copied','verified','prepared','activated','failed'].includes(j.phase) ||
      ![j.source, j.target, j.temp].every(x => typeof x === 'string' && path.isAbsolute(x)) || path.basename(j.source) !== 'vault' || path.basename(j.target) !== 'vault' ||
      path.dirname(j.temp) !== path.dirname(j.target) || path.basename(j.temp) !== '.workbunny-move-' + j.id ||
      Object.entries(j.permissions || {}).some(([name, mode]) => (name !== '.' && (name !== path.basename(name) || name === '..')) || !Number.isInteger(mode) || mode < 0 || mode > 0o777)) throw new Error('迁移记录损坏，请通过备份恢复位置');
  }
  restorePermissions(dir, modes) { for (const [name, mode] of Object.entries(modes)) { const p = name === '.' ? dir : path.join(dir, name); if (fs.existsSync(p)) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('资料库不允许链接文件'); fs.chmodSync(p, mode); } } }
  async migrate(parent, { quiesce, verify } = {}) {
    if (this.busy) throw new Error('数据库正在迁移');
    const source = this.resolve();
    const realSource = fs.realpathSync(source), realParent = fs.realpathSync(parent), target = path.join(realParent, 'vault');
    if (fs.existsSync(target) || realParent === realSource || realParent.startsWith(realSource + path.sep) || realSource.startsWith(target + path.sep)) throw new Error('目标 vault 必须不存在，且不能与原目录相同或互相包含');
    fs.accessSync(realParent, fs.constants.W_OK);
    let files = fs.readdirSync(source).filter(n => !/-(wal|shm)$/.test(n) && !['.migration-snapshot.json', '.vault-lock'].includes(n));
    const permissions = { '.': fs.statSync(source).mode & 0o777 }, sizes = files.map(name => {
      const st = fs.lstatSync(path.join(source, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error('资料库中存在链接或非普通文件，已停止迁移');
      permissions[name] = st.mode & 0o777; return st.size;
    });
    let total = sizes.reduce((a, b) => a + b, 0), space = fs.statfsSync(realParent);
    if (Number(space.bavail) * Number(space.bsize) < total + Math.max(total * .1, 16 * 1024 ** 2)) throw new Error('目标磁盘空间不足');
    const id = crypto.randomUUID(), temp = path.join(realParent, '.workbunny-move-' + id);
    let renamed = false;
    let j = { format: 'workbunny-move/v1', id, source, target, temp, permissions, phase: 'checked' }, activated = false;
    this.busy = true;
    const stage = phase => { j.phase = phase; atomicPrivate(this.journal, JSON.stringify(j)); this.onStage?.(phase, j); };
    try {
      stage('checked'); await quiesce(); stage('quiesced');
      files = fs.readdirSync(source).filter(n => !/-(wal|shm)$/.test(n) && !['.migration-snapshot.json', '.vault-lock'].includes(n));
      total = files.reduce((n, name) => { const st = fs.lstatSync(path.join(source, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error('资料库中存在非普通文件'); permissions[name] = st.mode & 0o777; return n + st.size; }, 0);
      const remaining = fs.statfsSync(realParent); if (Number(remaining.bavail) * Number(remaining.bsize) < total + Math.max(total * .1, 16 * 1024 ** 2)) throw new Error('目标磁盘空间不足');
      const before = inspect(this.binary, path.join(source, 'companion.db'));
      fs.mkdirSync(temp, { mode: 0o700 });
      j.hashes = {};
      for (const name of files) {
        const src = path.join(source, name), dst = path.join(temp, name);
        const st = fs.lstatSync(src); if (!st.isFile() || st.isSymbolicLink()) throw new Error('资料库文件在迁移时发生变化');
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); fs.chmodSync(dst, 0o600);
        const fd = fs.openSync(dst, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        j.hashes[name] = sha(src); if (sha(dst) !== j.hashes[name]) throw new Error('资料库复制校验失败');
      }
      stage('copied');
      const after = inspect(this.binary, path.join(temp, 'companion.db'));
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('资料库完整性校验失败');
      await verify?.(temp, before); stage('verified');
      // A snapshot marker prevents this version from ever reopening the old copy.
      atomicPrivate(path.join(source, '.migration-snapshot.json'), JSON.stringify({ id, target }));
      for (const name of files) fs.chmodSync(path.join(source, name), 0o400);
      const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, target); renamed = true;
      const parentFD = fs.openSync(realParent, 'r'); try { fs.fsyncSync(parentFD); } finally { fs.closeSync(parentFD); }
      stage('prepared');
      atomicPrivate(this.pointer, JSON.stringify({ format: 'workbunny-location/v1', dir: target, transactionId: id }));
      activated = true; this.dir = target; stage('activated');
      return { ok: true, dir: target, snapshot: source, records: after.count, bytes: total };
    } catch (e) {
      if (!activated) {
        this.restorePermissions(source, permissions);
        try { fs.unlinkSync(path.join(source, '.migration-snapshot.json')); } catch {}
        if (renamed && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
        stage('failed');
      }
      throw new Error(activated ? '迁移位置已生效，请重启应用继续；原快照已保留' : e.message);
    } finally { this.busy = false; }
  }
}
module.exports = { DataLocation, inspect };
