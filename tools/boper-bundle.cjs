'use strict';
const fs=require('node:fs'),path=require('node:path');
const {sourceDigest,hash,verify}=require('./boper-build-manifest.cjs');
const {inspect,framework}=require('./boper-fuses.cjs');
const root=path.resolve(__dirname,'..');
const required=['Contents/Resources/bin/boper-runtime','Contents/Resources/bin/boper-control.node','Contents/Library/LaunchServices/boper-hid-helper','Contents/Library/LaunchDaemons/cn.haminn.workbunny.boper-hid.plist','Contents/Resources/boper/cn.haminn.workbunny.boper-hid.root.plist','Contents/Resources/boper/install-helper.sh','Contents/Resources/boper/manifest.json','Contents/Resources/boper/Karabiner-DriverKit-VirtualHIDDevice-8.8.0.pkg'];
function manifest(app){return path.join(app,'Contents/Resources/boper/bundle.json');}
function writeBundle(app){verify(path.join(root,'build/native'));const value={schema:'bunny.boper-bundle/v1',architecture:'arm64',sourcesDigest:sourceDigest(),files:Object.fromEntries(required.map(name=>[name,hash(path.join(app,name))]))};fs.writeFileSync(manifest(app),JSON.stringify(value,null,2)+'\n');return value;}
function verifyBundle(app){const value=JSON.parse(fs.readFileSync(manifest(app)));if(value.sourcesDigest!==sourceDigest()||value.architecture!=='arm64')throw Error('BOPER 安装包与当前原生源码不一致');for(const name of required){const file=path.join(app,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||hash(file)!==value.files[name])throw Error('BOPER 安装包组件缺失或改变：'+name);}const upstream=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/boper/manifest.json')));if(upstream.sha256!==hash(path.join(app,'Contents/Resources/boper',upstream.package)))throw Error('BOPER 官方驱动包校验失败');inspect(framework(app));return {architecture:'arm64',components:required.length};}
module.exports={writeBundle,verifyBundle};
if(require.main===module){try{const app=path.resolve(process.argv[2]);console.log(JSON.stringify(process.argv.includes('--write')?writeBundle(app):verifyBundle(app)));}catch(e){console.error(e.message);process.exitCode=1;}}
