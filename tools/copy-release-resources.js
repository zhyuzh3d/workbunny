'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..'), out = process.argv[2], local = process.argv[3] === '--local';
const manifest = require('../resources-manifest.json');
if (!out || !path.isAbsolute(out)) throw new Error('缺少安装包资源输出路径');
// Personal/unknown inventory is documentary only; never copy those bytes into a release.
const blocked = manifest.assets.filter(a => a.redistribution !== 'allowed');
if (blocked.length && !local) throw new Error(`${blocked.length} 项动作资源尚无再分发许可；公开构建已停止。--local 仅供原持有人本地验证。`);
if (process.argv[4] === '--check-only') process.exit(0);
const files = [];
function copy(relative) {
  const source = path.join(root, relative), destination = path.join(out, relative), stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('非普通资源文件：' + relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
  files.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') });
}
function code(dir) { for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
  const relative = dir + '/' + entry.name;
  if (entry.isDirectory()) { if (relative !== 'src/renderer/assets') code(relative); }
  else if (/\.(js|mjs|html|css|sh)$/.test(entry.name)) copy(relative);
} }
code('src');
for (const file of fs.readdirSync(path.join(root, 'licenses'))) copy('licenses/' + file);
for (const relative of ['package.json','LICENSE','THIRD_PARTY_NOTICES.md','res/icon.icns','res/icon.png','res/trayTemplate.png','res/trayTemplate@2x.png','src/renderer/assets/icons/workbuddy-logo.png']) copy(relative);
for (const asset of manifest.assets) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset.path))).digest('hex') !== asset.sha256) throw new Error('资源与许可清单不一致：' + asset.path);
  copy(asset.path);
}
fs.writeFileSync(path.join(out, 'resources-manifest.json'), JSON.stringify({ ...manifest, sourceCommit: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), distribution: local ? 'local-validation' : 'verified-assets-free-distribution', files }, null, 2) + '\n');
console.log(`已复制 ${files.length} 项白名单资源；${local ? '本地验证（公开资源同一白名单）' : '公开构建，个人/未核实资源均未打包'}。`);
