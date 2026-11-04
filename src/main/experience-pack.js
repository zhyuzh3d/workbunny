'use strict';

const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {readResourceZip,resourcePath,metadata,MAX_ARCHIVE}=require('./resource-zip');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function string(v,label,max=240){check(typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f]/u.test(v),label+'无效');return v.trim();}
function id(v){return string(v,'资源ID',160);}
function tags(v=[]){check(Array.isArray(v)&&v.length<=20,'经验标签无效');return [...new Set(v.map(t=>string(t,'标签',80).normalize('NFKC').toLowerCase()))];}
function json(v,label,max=24000){check(v===undefined||plain(v),label+'必须是对象');const value=v||{};check(JSON.stringify(value).length<=max,label+'过大');return value;}
function schema(v,label){const root=json(v,label);let nodes=0;const visit=(s,depth=0)=>{check(depth<=16&&++nodes<=400&&plain(s),label+'结构无效');if(s.type!==undefined){const types=Array.isArray(s.type)?s.type:[s.type];check(types.length>0&&types.every(t=>['object','array','string','number','integer','boolean','null'].includes(t)),label+'类型无效');}
 if(s.required!==undefined)check(Array.isArray(s.required)&&s.required.every(k=>typeof k==='string'),label+'required无效');if(s.enum!==undefined)check(Array.isArray(s.enum)&&s.enum.length>0,label+'enum无效');
 for(const key of ['properties','$defs','definitions'])if(s[key]!==undefined){check(plain(s[key]),label+'属性无效');for(const child of Object.values(s[key]))visit(child,depth+1);}
 for(const key of ['items','additionalProperties','not','if','then','else'])if(s[key]!==undefined&&typeof s[key]!=='boolean'){if(key==='items'&&Array.isArray(s[key]))for(const child of s[key])visit(child,depth+1);else visit(s[key],depth+1);}
 for(const key of ['allOf','anyOf','oneOf','prefixItems'])if(s[key]!==undefined){check(Array.isArray(s[key]),label+'组合无效');for(const child of s[key])visit(child,depth+1);}
 };visit(root);return root;}
function normalize(manifest,files){
 check(plain(manifest)&&manifest.schema==='bunny.experience-pack/v1','不支持的经验资源包格式');
 const pack={schema:manifest.schema,id:id(manifest.id),version:string(manifest.version,'资源包版本',80),title:string(manifest.title,'资源包名称',160),experiences:[],tools:[]};
 check(Array.isArray(manifest.experiences)&&manifest.experiences.length<=200,'经验条目无效');
 check(Array.isArray(manifest.tools||[])&&(manifest.tools||[]).length<=64,'工具条目无效');
 check(Array.isArray(manifest.resources)&&manifest.resources.length<=500,'资源清单无效');
 const declared=new Map(),folded=new Set();
 for(const item of manifest.resources){check(plain(item),'资源条目无效');const name=resourcePath(item.path),fold=name.normalize('NFC').toLowerCase();check(!declared.has(name)&&!folded.has(fold),'重复的资源路径');folded.add(fold);
  const data=files.get(name);check(data&&data.length<=16*1024*1024,'资源缺失或过大：'+name);check(/^[a-f0-9]{64}$/u.test(item.sha256)&&hash(data)===item.sha256,'资源校验失败：'+name);check(Number.isSafeInteger(item.bytes)&&data.length===item.bytes,'资源大小不符：'+name);declared.set(name,{path:name,sha256:item.sha256,bytes:data.length});}
 check([...files.keys()].every(n=>metadata(n)||declared.has(n)),'资源包含有未声明的文件');
 const unique=new Set();
 for(const item of manifest.tools||[]){check(plain(item),'工具格式无效');const toolId=id(item.id);check(!unique.has(toolId),'重复工具ID');unique.add(toolId);const entry=resourcePath(item.entry);check(declared.has(entry),'工具入口没有列入资源清单');
  const names=item.resources||[entry];check(Array.isArray(names)&&names.length<=100,'工具资源列表无效');const resources=[...new Set([entry,...names.map(resourcePath)])].sort();check(resources.every(n=>declared.has(n)),'工具资源未声明');
  const effect=item.effect;check(['read','write'].includes(effect),'工具必须声明读写效果');check(Array.isArray(item.capabilities)&&item.capabilities.length<=20,'工具必须声明能力');
  const tool={id:toolId,title:string(item.title||toolId,'工具名称',160),entry,runtime:string(item.runtime,'工具运行方式',80),interfaceVersion:string(item.interfaceVersion||'1','工具接口版本',80),inputSchema:schema(item.inputSchema,'输入Schema'),outputSchema:schema(item.outputSchema,'输出Schema'),effect,capabilities:item.capabilities.map(c=>string(c,'能力',100)),dependencies:json(item.dependencies,'依赖'),resources:resources.map(n=>declared.get(n))};
  tool.hash=hash(JSON.stringify(tool));pack.tools.push(tool);}
 unique.clear();
 for(const item of manifest.experiences){check(plain(item),'经验格式无效');const experienceId=id(item.id);check(!unique.has(experienceId),'重复经验ID');unique.add(experienceId);const name=resourcePath(item.path);check(declared.has(name)&&/\.(?:md|txt)$/iu.test(name),'经验正文须是已声明的MD或TXT');
  let body;try{body=new TextDecoder('utf-8',{fatal:true}).decode(files.get(name)).trim();}catch{throw Error('经验正文必须为UTF-8');}check(body.length>0&&body.length<=24000,'经验正文为空或过大');const refs=item.toolRefs||[];check(Array.isArray(refs)&&refs.length<=20&&refs.every(r=>typeof r==='string'&&(r.startsWith('builtin:')&&r.length<=180||pack.tools.some(t=>t.id===r))),'经验引用了未声明的工具');
  pack.experiences.push({id:experienceId,title:string(item.title||experienceId,'经验名称',160),instructions:body,summary:typeof item.summary==='string'?item.summary.slice(0,600):body.slice(0,240),tags:tags(item.tags),appliesTo:json(item.appliesTo,'适用条件',4000),toolRefs:refs,publishedAt:typeof item.publishedAt==='string'?item.publishedAt.slice(0,80):null});}
 check(pack.experiences.length||pack.tools.length,'资源包没有经验或工具');
 pack.hash=hash(JSON.stringify({manifest,resources:[...declared.values()].sort((a,b)=>a.path.localeCompare(b.path))}));return {pack,files};
}
async function readExperiencePack(selected,{expectedHash}={}){
 const stat=await fs.lstat(selected);check(!stat.isSymbolicLink(),'不能导入符号链接');let data;
 if(stat.isFile()){check(stat.size<=MAX_ARCHIVE&&/\.zip$/iu.test(selected),'请选择ZIP或文件夹');const handle=await fs.open(selected,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);let bytes;try{bytes=await handle.readFile();}finally{await handle.close();}check(!expectedHash||hash(bytes)===expectedHash,'经验包已变化，请先重新核对文件');data=readResourceZip(bytes,{allowRootFolder:true,maxFileBytes:16*1024*1024});}
 else {check(stat.isDirectory(),'请选择ZIP或文件夹');const root=await fs.realpath(selected),files=new Map(),folded=new Set();let total=0,count=0;
  async function walk(dir,prefix=''){for(const name of await fs.readdir(dir)){const relative=prefix+name;if(metadata(relative))continue;resourcePath(relative);const filename=path.join(dir,name),s=await fs.lstat(filename);check(!s.isSymbolicLink(),'资源包不能含符号链接');check(++count<=512,'资源包文件太多');const fold=relative.normalize('NFC').toLowerCase();check(!folded.has(fold),'重复的资源路径');folded.add(fold);
   if(s.isDirectory()){await walk(filename,relative+'/');continue;}check(s.isFile()&&s.size<=16*1024*1024,'资源必须是大小合理的普通文件');total+=s.size;check(total<=128*1024*1024,'资源包过大');
   const handle=await fs.open(filename,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);try{const actual=await handle.stat();check(actual.isFile()&&actual.size===s.size,'资源在读取时变化');check((await fs.realpath(filename)).startsWith(root+path.sep),'资源超出包目录');const b=await handle.readFile();check(b.length===s.size,'资源在读取时变化');files.set(relative,b);}finally{await handle.close();}}}
  await walk(root);check(files.has('manifest.json'),'缺少manifest.json');const raw=files.get('manifest.json');check(raw.length<=1024*1024,'清单过大');files.delete('manifest.json');let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw Error('清单不是有效的UTF-8 JSON');}data={manifest,files};}
 return normalize(data.manifest,data.files);
}
module.exports={readExperiencePack,normalize,tags,hash};
