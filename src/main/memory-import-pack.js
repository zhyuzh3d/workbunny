'use strict';
// Untrusted transport only. No imported module, command or install hook runs here.
const fs=require('node:fs/promises'),path=require('node:path');
const {constants}=require('node:fs');
const {readResourceZip,resourcePath,metadata,MAX_ARCHIVE}=require('./resource-zip');
const {normalize,hash}=require('./experience-pack');
const SCHEMA='bunny.memory-pack/v1',MAX_BYTES=16*1024*1024;
const check=(ok,message)=>{if(!ok)throw Error(message);};
async function readMemoryPack(selected,{expectedHash}={}){
 const stat=await fs.lstat(selected);check(!stat.isSymbolicLink(),'不能导入符号链接');let manifest,files;
 if(stat.isFile()){
  check(stat.size<=MAX_ARCHIVE&&/\.zip$/iu.test(selected),'请选择 ZIP 或文件夹');const h=await fs.open(selected,constants.O_RDONLY|constants.O_NOFOLLOW);let data;
  try{data=await h.readFile();}finally{await h.close();}check(!expectedHash||hash(data)===expectedHash,'导入文件已变化');
  ({manifest,files}=readResourceZip(data,{allowRootFolder:true,manifestOptional:true,maxFileBytes:MAX_BYTES}));
 }else{
  check(stat.isDirectory(),'请选择 ZIP 或文件夹');const root=await fs.realpath(selected);files=new Map();const names=new Set();let total=0,count=0;
  async function walk(dir,prefix=''){
   for(const name of (await fs.readdir(dir)).sort()){
    const relative=prefix+name;if(metadata(relative))continue;resourcePath(relative);const file=path.join(dir,name),s=await fs.lstat(file);
    check(!s.isSymbolicLink()&&++count<=512,'文件夹含符号链接或条目超过512个');const folded=relative.normalize('NFC').toLowerCase();check(!names.has(folded),'重复资源路径');names.add(folded);
    if(s.isDirectory()){await walk(file,relative+'/');continue;}
    check(s.isFile()&&s.size<=MAX_BYTES,'文件不是普通文件或超过16MiB');total+=s.size;check(total<=128*1024*1024,'导入资料超过128MiB');
    const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const actual=await h.stat();check(actual.isFile()&&actual.size===s.size&&(await fs.realpath(file)).startsWith(root+path.sep),'导入文件在读取时变化');const b=await h.readFile();check(b.length===s.size,'导入文件在读取时变化');files.set(relative,b);}finally{await h.close();}
   }
  }
  await walk(root);if(files.has('manifest.json')){check(files.get('manifest.json').length<=1024*1024,'清单过大');try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files.get('manifest.json')));}catch{throw Error('清单不是有效UTF-8 JSON');}files.delete('manifest.json');}
 }
 for(const name of [...files.keys()])if(metadata(name))files.delete(name);
 check(files.size>0,'导入资料为空');let legacy,tools=[];
 if(manifest?.schema==='bunny.experience-pack/v1'){legacy=normalize(manifest,files).pack;tools=legacy.tools;}
 else if(manifest){
  check(manifest.schema===SCHEMA,'不支持的资料包版本');
  for(const key of ['id','version','title','author','description'])if(manifest[key]!==undefined)check(typeof manifest[key]==='string'&&manifest[key].length<=1000,'清单字段无效：'+key);
  check(manifest.scope===undefined||['work','life','private'].includes(manifest.scope),'资料范围无效');
  check(manifest.tools===undefined||Array.isArray(manifest.tools)&&manifest.tools.length<=64,'工具声明无效');
  check(manifest.resources===undefined||Array.isArray(manifest.resources)&&manifest.resources.length<=500,'资源清单无效');
  const seen=new Set();for(const r of manifest.resources||[]){const p=resourcePath(r.path);check(!seen.has(p),'重复资源声明');seen.add(p);const b=files.get(p);check(b&&r.bytes===b.length&&r.sha256===hash(b),'资源校验失败：'+p);}
  if(manifest.tools?.length){const checked=normalize({schema:'bunny.experience-pack/v1',id:manifest.id||'memory-import',version:manifest.version||'1',title:manifest.title||'导入资料',experiences:[],tools:manifest.tools,resources:[...files].map(([p,b])=>({path:p,bytes:b.length,sha256:hash(b)}))},files);tools=checked.pack.tools;}
 }
 const inventory=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([p,b])=>({path:p,bytes:b.length,sha256:hash(b)}));
 const digest=hash(JSON.stringify({manifest:manifest||null,inventory}));
 return {schema:manifest?.schema||'plain-folder',id:manifest?.id||'content:'+digest,version:manifest?.version||'1',title:manifest?.title||path.basename(selected).replace(/\.zip$/iu,''),scope:manifest?.scope,hash:digest,files,inventory,tools,legacy:!!legacy};
}
module.exports={readMemoryPack,SCHEMA};
