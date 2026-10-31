'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { pathToFileURL } = require('url');
// This insertion order is also the built-in appearance order.
const STOCK_MODELS = new Set(['Bani.vrm', 'AvatarSample_D.vrm', 'AvatarSample_Shino.vrm', 'AvatarSample_E.vrm', 'AvatarSample_F.vrm', 'AvatarSample_G.vrm']);
let root;
function setRoot(value) { root = value; }
function directory(kind) { return root && path.join(root, kind === 'model' ? 'avatars' : 'motions'); }
function personalFile(kind, name) {
  const dir = directory(kind);
  if (!dir || typeof name !== 'string' || name !== path.basename(name)) return null;
  try { if (fs.lstatSync(dir).isSymbolicLink()) return null; } catch { return null; }
  const file = path.join(dir, name);
  try { const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink() ? file : null; } catch { return null; }
}
function url(file) { return pathToFileURL(file).href; }
function validateModel(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024 ** 2 || st.size < 20) throw new Error('请选择128MiB以内的独立VRM模型文件');
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(8) !== data.length || data.toString('ascii',16,20) !== 'JSON') throw new Error('不是有效的VRM文件');
  const json = JSON.parse(data.subarray(20,20 + data.readUInt32LE(12)).toString());
  if (!json.extensions?.VRM && !json.extensions?.VRMC_vrm) throw new Error('模型缺少VRM扩展');
  if ([...(json.buffers || []), ...(json.images || [])].some(x => x.uri && !x.uri.startsWith('data:'))) throw new Error('请使用不依赖外部文件的独立VRM模型');
  return data;
}
function importModel(file) {
  const dir = directory('model'); if (!dir) throw new Error('个人资源目录未准备好');
  const data = validateModel(file), original = path.basename(file), digest = crypto.createHash('sha256').update(data).digest('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('个人资源目录不能是符号链接');
  let name = original;
  if (STOCK_MODELS.has(name)) name = '个人-' + path.basename(original, path.extname(original)) + '-' + digest.slice(0, 8) + '.vrm';
  const existing = path.join(dir, name);
  if (fs.existsSync(existing)) {
    const current = personalFile('model', name);
    if (!current) throw new Error('同名资源不是普通文件');
    if (crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex') === digest) return name;
    name = path.basename(original, path.extname(original)) + '-' + digest.slice(0,8) + '.vrm';
  }
  const target = path.join(dir, name);
  if (fs.existsSync(target)) { const current = personalFile('model', name); if (current && crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex') === digest) return name; throw new Error('同名个人资源已存在'); }
  const temporary = path.join(dir, '.' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, target); }
    catch (e) { if (e.code !== 'EEXIST' || !personalFile('model', name) || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== digest) throw e; }
    return name;
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }

}
module.exports = { setRoot, directory, personalFile, url, validateModel, importModel, STOCK_MODELS };
