'use strict';
// Refuse stale/partial bundles before installation: source assets and code must match.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function relative(root,name){
  if(typeof name!=='string'||path.isAbsolute(name)||name.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('安装包包含无效资源路径');
  const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('安装包资源不是普通文件：'+name);return file;
}
function verifyBundle(directory,{sourceRoot=ROOT}={}){
  const root=fs.existsSync(path.join(directory,'Contents/Resources/app'))?path.join(directory,'Contents/Resources/app'):directory;
  const expected=JSON.parse(fs.readFileSync(path.join(sourceRoot,'resources-manifest.json'))),actual=JSON.parse(fs.readFileSync(path.join(root,'resources-manifest.json')));
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,sourceVersion=JSON.parse(fs.readFileSync(path.join(sourceRoot,'package.json'))).version;
  if(version!==sourceVersion)throw Error(`安装包版本 ${version} 与当前源码 ${sourceVersion} 不一致，请重新完整构建`);
  const assets=new Map((actual.assets||[]).map(a=>[a.path,a]));
  if(assets.size!==expected.assets.length)throw Error('安装包资源数量与当前审核清单不一致，请重新完整构建');
  for(const asset of expected.assets){const item=assets.get(asset.path);if(!item||item.sha256!==asset.sha256||hash(relative(root,asset.path))!==asset.sha256||hash(relative(sourceRoot,asset.path))!==asset.sha256)throw Error('安装包缺少当前审核资源或内容不一致：'+asset.path);}
  const declared=new Set(expected.assets.map(a=>a.path));
  for(const kind of ['models','motions'])for(const name of fs.readdirSync(path.join(root,'src/renderer/assets',kind)))if(/\.(vrm|vrma)$/i.test(name)&&!declared.has('src/renderer/assets/'+kind+'/'+name))throw Error('安装包混入未列入审核清单的资源：'+name);
  const files=new Map((actual.files||[]).map(f=>[f.path,f]));
  for(const name of ['src/main/config.js','src/main/reviewed-motions.js','src/main/motion-library.js','src/renderer/app.js','src/renderer/panel.js'])if(!files.has(name))throw Error('安装包缺少完整动作运行代码：'+name);
  for(const item of files.values())if(hash(relative(root,item.path))!==item.sha256||hash(relative(sourceRoot,item.path))!==item.sha256)throw Error('安装包代码或资源不是当前源码版本：'+item.path);
  return {version,models:expected.assets.filter(a=>a.path.endsWith('.vrm')).length,motions:expected.assets.filter(a=>a.path.endsWith('.vrma')).length,verifiedFiles:files.size};
}
module.exports={verifyBundle};
if(require.main===module){try{if(!process.argv[2])throw Error('请提供安装包目录');console.log(JSON.stringify(verifyBundle(path.resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}}
