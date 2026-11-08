'use strict';
const fs=require('node:fs');
const filename=process.argv[2];
if(!filename)throw Error('请明确传入获准读取的文本文件');
const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{
 const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw Error('仅支持不超过1MiB的普通文本文件');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(fd));if(text.includes('\0'))throw Error('不是普通文本');
 const lines=text.length?text.replace(/\r\n/g,'\n').split('\n').length-(text.endsWith('\n')?1:0):0;
 process.stdout.write(JSON.stringify({lines})+'\n');
}finally{fs.closeSync(fd);}
