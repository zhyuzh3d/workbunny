'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const files=['boper-runtime','boper-hid-helper','boper-control.node'];
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function sourceDigest(base=root){
 const names=['tools/build-boper.sh','tools/boper-build-manifest.cjs'];
 function visit(dir){for(const entry of fs.readdirSync(path.join(base,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){if(entry.name==='.DS_Store')continue;const name=dir+'/'+entry.name;if(entry.isDirectory())visit(name);else if(entry.isFile())names.push(name);else throw Error('BOPER 构建来源不是普通文件：'+name);}}
 visit('native/boper');const digest=crypto.createHash('sha256');for(const name of names.sort()){digest.update(name+'\0');digest.update(hash(path.join(base,name)));}return digest.digest('hex');
}
function write(directory){const value={schema:'bunny.boper-build/v1',architecture:'arm64',minimumSystemVersion:'13.0',sourcesDigest:sourceDigest(),files:Object.fromEntries(files.map(name=>[name,hash(path.join(directory,name))]))};fs.writeFileSync(path.join(directory,'boper-build.json'),JSON.stringify(value,null,2)+'\n');return value;}
function verify(directory){const value=JSON.parse(fs.readFileSync(path.join(directory,'boper-build.json')));if(value.sourcesDigest!==sourceDigest()||value.architecture!=='arm64')throw Error('BOPER 原生产物不是当前源码，请重新构建');for(const name of files)if(value.files[name]!==hash(path.join(directory,name)))throw Error('BOPER 构建产物被改变：'+name);return value;}
module.exports={sourceDigest,write,verify,hash};
if(require.main===module){try{const value=process.argv.includes('--verify')?verify(path.resolve(process.argv[2])):write(path.resolve(process.argv[2]));console.log(JSON.stringify({architecture:value.architecture,sourcesDigest:value.sourcesDigest}));}catch(error){console.error(error.message);process.exitCode=1;}}
