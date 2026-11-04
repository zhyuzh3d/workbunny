'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fields,text}=require('./agent-contract');
const wechatStorage=file=>/\/Library\/(?:Containers|Group Containers|Application Support)\/[^\n]*(?:wechat|xinWeChat|微信)/iu.test(file);
function registerFileTools(tools,{directory,checkpoint=async()=>{},sensitivePolicy=require('./sensitive-policy').createSensitivePolicy()}){
 tools.register({name:'files.list',description:'列出主人指定目录中的真实文件名和类型；保存附件后可用来核对完整文件名，包括界面省略的部分。不扫描微信内部存储，不把文件名当成已读正文。',effect:'read',capabilities:['files.read'],scope:()=>({application:'system'}),
 validate:v=>{fields(v,['application','path'],'目录查看');if(v.application!=='system'||typeof v.path!=='string'||!path.isAbsolute(v.path)||/[\r\n\0]/u.test(v.path))throw Error('需要目录绝对路径');if(wechatStorage(path.resolve(v.path)))throw Error('不查看微信内部文件库');return {...v,path:path.resolve(v.path)};},
 execute:async a=>{const actual=await fs.realpath(a.path);if(wechatStorage(actual))throw Object.assign(Error('不查看微信内部文件库'),{dispatched:false});const entries=await fs.readdir(actual,{withFileTypes:true});return {directory:actual,items:entries.slice(0,200).map(e=>({name:e.name,path:path.join(actual,e.name),kind:e.isSymbolicLink()?'link':e.isFile()?'file':e.isDirectory()?'directory':'other'})),truncated:entries.length>200};}
 });
 tools.register({name:'files.destination',description:'为接收一个指定文件创建独立的空目录，返回 directory 和 expectedPath；之后用软件界面另存为到这个目录，最后 files.inspect 核对实际内容。不会读取软件内部文件库。',effect:'write',capabilities:['files.write'],scope:()=>({application:'system'}),
 validate:v=>{fields(v,['application','fileName'],'接收位置');if(v.application!=='system')throw Error('文件位置属于系统');const fileName=text(v.fileName,'文件名',240);if(path.basename(fileName)!==fileName||['.','..'].includes(fileName)||/[\\/\r\n\0]/u.test(fileName))throw Error('需要可见的完整文件名');return {...v,fileName};},
 execute:async(a,{task,operationId})=>{
  await fs.mkdir(directory,{recursive:true,mode:0o700});const parent=path.join(await fs.realpath(directory),task.id,'received',operationId),actual=path.resolve(parent);await fs.mkdir(actual,{recursive:true,mode:0o700});if(await fs.realpath(actual)!==actual)throw Object.assign(Error('接收目录经过链接，先核对真实目录'),{dispatched:false});
  const destination={directory:actual,fileName:a.fileName,expectedPath:path.join(actual,a.fileName)};task.state.fileDestinations??=[];if(!task.state.fileDestinations.some(d=>d.directory===actual))task.state.fileDestinations.push(destination);await checkpoint(task);
  return {ok:true,verified:true,receipt:{...destination,createdAt:Date.now()}};
 }});
 tools.register({name:'files.inspect',description:'读取已保存的实际普通文件，核对大小和 SHA-256，返回 UTF-8 文本预览及真实文件清单；二进制不冒充已读正文。禁止读取微信内部存储。',effect:'read',capabilities:['files.read'],scope:()=>({application:'system'}),
 validate:v=>{fields(v,['application','path'],'文件核对');if(v.application!=='system'||!path.isAbsolute(v.path||'')||/[\r\n\0]/u.test(v.path))throw Error('需要文件的绝对路径');const file=path.resolve(v.path);if(wechatStorage(file))throw Error('微信内部文件库不属于视觉文件接收');return {...v,path:file};},
 execute:async(a,{task}={})=>{
  const before=await fs.lstat(a.path);if(!before.isFile()||before.isSymbolicLink()||before.size>20*1024*1024)throw Object.assign(Error('文件需要是20MB以内的普通文件'),{dispatched:false});const actualPath=await fs.realpath(a.path);if(wechatStorage(actualPath))throw Object.assign(Error('微信内部文件库不属于视觉文件接收'),{dispatched:false});
  const bytes=await fs.readFile(actualPath),after=await fs.stat(actualPath);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Object.assign(Error('文件仍在变化，等待保存结束后核对'),{dispatched:false});
  const artifact={path:actualPath,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};let preview=null;
  try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!decoded.includes('\0'))preview=decoded.slice(0,12000);}catch{}
  if(task?.state&&preview!==null&&await sensitivePolicy.isSensitive(preview))task.state.sensitiveContext=true;
  return {ok:true,artifactManifest:{files:[artifact]},text:preview,textTruncated:preview!==null&&bytes.length>Buffer.byteLength(preview),contentRead:preview!==null};
 }});
}
module.exports={registerFileTools};
