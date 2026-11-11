'use strict';
// Electron's documented V1 fuse wire; change only authority-relevant fuses.
// https://github.com/electron/fuses/blob/main/src/config.ts
const fs=require('node:fs'),path=require('node:path');
const sentinel=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
function inspect(file,{write=false}={}){
 const data=fs.readFileSync(file),found=[];
 for(let i=data.indexOf(sentinel);i>=0;i=data.indexOf(sentinel,i+sentinel.length)){
  const h=i+sentinel.length;if(data[h]!==1||data[h+1]<4)throw Error('Electron fuse 格式不支持，拒绝分发 BOPER');
  const pos=h+2;for(const fuse of [0,2,3]){if(![48,49].includes(data[pos+fuse]))throw Error('Electron authority fuse 不可用');if(write)data[pos+fuse]=48;else if(data[pos+fuse]!==48)throw Error('安装包仍允许解释器或调试方式借用 BOPER 身份');}found.push(i);
 }
 if(found.length!==1)throw Error('BOPER 只支持一个 arm64 Electron fuse 段');
 if(write)fs.writeFileSync(file,data);return {authorityFusesDisabled:true};
}
function framework(app){return path.join(app,'Contents/Frameworks/Electron Framework.framework/Electron Framework');}
module.exports={inspect,framework};
if(require.main===module){try{console.log(JSON.stringify(inspect(framework(process.argv[2]),{write:process.argv.includes('--write')})));}catch(e){console.error(e.message);process.exitCode=1;}}
