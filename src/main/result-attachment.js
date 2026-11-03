'use strict';
const fs=require('fs/promises'),crypto=require('crypto'),path=require('path');
async function verifyAttachment(file){
 if(!file||typeof file.path!=='string'||!path.isAbsolute(file.path)||!path.basename(file.path).trim()||/[\r\n\0]/u.test(file.path)||!(/^[a-f0-9]{64}$/u).test(file.sha256||''))throw Error('附件没有已核对的路径及指纹');
 const stat=await fs.lstat(file.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024)throw Error('当前附件仅支持20MB内普通文件');
 const actual=await fs.realpath(file.path);if(actual!==file.path)throw Error('附件路径经过链接，先确认真实路径');
 const hash=crypto.createHash('sha256').update(await fs.readFile(actual)).digest('hex');if(hash!==file.sha256)throw Error('附件核对后发生变化，未发送');
 return {path:actual,sha256:hash,size:stat.size};
}
module.exports={verifyAttachment};
