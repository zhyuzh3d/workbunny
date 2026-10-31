'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { BRAND_FILES } = require('./brand-assets.cjs');
const root = path.resolve(__dirname, '..'), out = process.argv[2], local = process.argv[3] === '--local';
const manifest = require('../resources-manifest.json');
if (!out || !path.isAbsolute(out)) throw new Error('缺少安装包资源输出路径');
// Unknown rights may be included only when individually recorded as selected by the owner.
// Known restricted assets can never enter the distribution, including local builds.
const blocked = manifest.assets.filter(a => a.redistribution !== 'allowed' && !(a.redistribution === 'unverified' && a.selectedForRelease === true && a.reviewedAsset === true));
if (blocked.length) throw new Error(`${blocked.length} 项资源未获准进入构建白名单。`);
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
for (const relative of ['package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md',...BRAND_FILES,'src/renderer/assets/icons/workbuddy-logo.png']) copy(relative);
for (const asset of manifest.assets) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset.path))).digest('hex') !== asset.sha256) throw new Error('资源与许可清单不一致：' + asset.path);
  copy(asset.path);
}
fs.writeFileSync(path.join(out, 'resources-manifest.json'), JSON.stringify({ ...manifest, sourceCommit: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), distribution: manifest.assets.some(a => a.redistribution === 'unverified') ? 'includes-unverified-rights' : (local ? 'local-validation' : 'verified-assets-free-distribution'), sourceDirty: !!require('child_process').execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim(), files }, null, 2) + '\n');
console.log(`已复制 ${files.length} 项白名单资源；${manifest.assets.some(a => a.redistribution === 'unverified') ? '包含权利待核实动作，详见 README' : '资源许可清单已核对'}。`);
