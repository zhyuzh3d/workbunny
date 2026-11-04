'use strict';

const fs=require('node:fs/promises'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const {constants}=require('node:fs');
const {containsSecret}=require('./conversation-input');

// These detectors supplement explicit protected values; they are not a claim
// that an arbitrary unknown password can be recognized from unlabelled text.
const ASSIGN=/(?:密码|口令|恢复码|密钥|令牌|password|passwd|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\s*(?:[:：=]|是|为)\s*["'“‘]?([^\s"'“”‘’，。；;]{1,4096})/giu;
const KEY=/\b(?:sk-|xai-|nvapi-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}/gu;
function sensitiveValues(text){
 const value=String(text||'');const out=new Set();
 for(const match of value.matchAll(ASSIGN)){if(/^\*+$/u.test(match[1]))continue;out.add(match[1]);const trimmed=match[1].replace(/[.!！,，。；;]+$/u,'');if(trimmed)out.add(trimmed);}
 for(const match of value.matchAll(KEY))out.add(match[0]);
 const pem=value.match(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
 if(pem)out.add(pem[0]);
 return [...out];
}
function normalized(value){return String(value||'').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/gu,'');}
function hasProtectedContent(content,values=[]){
 const text=normalized(content),detected=text.replace(ASSIGN,(whole,value)=>/^\*+$/u.test(value)?'':whole);if(containsSecret(detected)||sensitiveValues(detected).length)return true;
 for(const raw of values){
  if(typeof raw!=='string'||!raw)continue;const secret=normalized(raw);if(!secret)continue;
  const variants=new Set([secret]);
  const encoded=encodeURIComponent(secret);if(encoded!==secret)variants.add(encoded);
  const escaped=JSON.stringify(secret).slice(1,-1);if(escaped!==secret)variants.add(escaped);
  if(Buffer.byteLength(secret)>=6)variants.add(Buffer.from(secret).toString('base64'));
  for(const variant of variants)if(text.includes(variant))return true;
 }
 return false;
}
function redactSensitiveContent(content,values=[]){
 let result=String(content||'');const all=[...new Set([...values,...sensitiveValues(result)])].filter(x=>typeof x==='string'&&x).sort((a,b)=>b.length-a.length);
 result=result.replace(ASSIGN,'[敏感信息见附件]').replace(KEY,'[敏感信息见附件]');
 for(const secret of all){
  const variants=new Set([secret,encodeURIComponent(secret),JSON.stringify(secret).slice(1,-1)]);
  if(Buffer.byteLength(secret)>=6)variants.add(Buffer.from(secret).toString('base64'));
  for(const value of variants)if(value)result=result.split(value).join('[敏感信息见附件]');
 }
 // If a detector still sees a secret, do not guess which bytes to leave in the
 // message. The complete original remains available in the attached file.
 return hasProtectedContent(result,all)?'任务内容包含敏感信息，完整内容请查看本次随附的文本文件。':result;
}
async function createSensitiveAttachment(content,{directory=os.tmpdir(),ownerMark=false}={}){
 const root=await fs.realpath(directory),folder=await fs.mkdtemp(path.join(root,'workbunny-private-'));await fs.chmod(folder,0o700);
 const filename=(ownerMark?'［Bunny］ ':'')+'context-'+crypto.randomBytes(5).toString('hex')+'.txt',file=path.join(folder,filename);let handle;
 try{
  const bytes=Buffer.from(content,'utf8');handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
  await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
  return {path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
 }catch(error){await handle?.close().catch(()=>{});await fs.rm(folder,{recursive:true,force:true});throw error;}
}
async function removeSensitiveAttachment(attachment,{directory=os.tmpdir()}={}){
 const root=await fs.realpath(directory),file=attachment?.path,folder=typeof file==='string'?path.dirname(file):'';
 if(path.dirname(folder)!==root||!/^workbunny-private-[A-Za-z0-9]+$/u.test(path.basename(folder))||!/^(?:［Bunny］ )?context-[a-f0-9]{10}\.txt$/u.test(path.basename(file||'')))throw Error('敏感附件清理范围无效');
 const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('敏感附件目录已变化');
 await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.rmdir(folder).catch(error=>{if(error.code!=='ENOENT')throw error;});
}

async function inspectAttachment(file,values=[]){
 if(!file||typeof file.path!=='string'||!path.isAbsolute(file.path)||!/^[a-f0-9]{64}$/u.test(file.sha256||''))throw Error('附件缺少已核对的路径与指纹');
 const handle=await fs.open(file.path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await handle.stat();if(!before.isFile()||before.size>20*1024*1024)throw Error('附件不是可核对的普通文件');
  const bytes=await handle.readFile(),after=await handle.stat();
  if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('附件在核对后发生变化');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))text=undefined;}catch{}
  if(text===undefined)return {kind:'unknown',sensitive:false};
  return {kind:'text',sensitive:hasProtectedContent(text,values)};
 }finally{await handle.close();}
}

function createSensitivePolicy({getValues=async()=>[],authorizeChannel=()=>false}={}){
 const checkChannel=(snapshot,recipient)=>{if(!snapshot)return false;return authorizeChannel(snapshot,recipient);};
 return {checkChannel,async isSensitive(text){return hasProtectedContent(text,await getValues());},async prepareWorkBuddy(text){
  text=require('./owner-security').redact(text);
  const values=await getValues();if(!Array.isArray(values))throw Error('敏感资料保护不可用，未发送');
  if(!hasProtectedContent(text,values))return {text};
  const all=[...new Set([...values,...sensitiveValues(text)])],attachment=await createSensitiveAttachment(text);
  return {text:redactSensitiveContent(text,all),attachment,redact:value=>redactSensitiveContent(value,all)};
 },async check({target,recipient,ownership,text='',attachment,fileHelperVerified=false,taskAuthorized=false,stage='dispatch',channelAuthorization}){
  if(!['wechat','workbuddy'].includes(target))throw Error('未知的敏感内容出口');
  const channelOwner=target==='wechat'&&checkChannel(channelAuthorization,recipient);
  const values=await getValues();if(!Array.isArray(values))throw Error('敏感资料保护不可用，未发送');
  if(!channelOwner&&hasProtectedContent(text,values))throw Error('包含密码或密钥的内容不能作为第三方对话正文发送');
  if(!attachment)return {ok:true};
  const inspection=await inspectAttachment(attachment,values);
  if(require('./owner-security').contains(await fs.readFile(attachment.path,'utf8')))throw Error('主人身份密钥禁止作为附件输出');
  if(inspection.kind==='unknown')throw Error('附件内容无法核验是否包含密码或密钥，未发送；请使用可检查的内容或其他受控方式');
  if(!inspection.sensitive)return {ok:true};
  if(channelOwner)return {ok:true,sensitiveAttachment:true};
  if(path.extname(attachment.path).toLowerCase()!=='.txt'||!taskAuthorized)throw Error('敏感信息仅可按任务授权使用文本附件');
  if(target==='workbuddy')return {ok:true,sensitiveAttachment:true};
  if(ownership==='owner'&&recipient==='文件传输助手'&&fileHelperVerified===true)return {ok:true,sensitiveAttachment:true};
  if(stage==='prepare'&&ownership==='owner'&&recipient==='文件传输助手')return {ok:true,sensitiveAttachment:true,requiresFileHelperVerification:true};
  throw Error('密码或密钥只能发送给主人账号经核实的文件传输助手');
 }};
}
module.exports={sensitiveValues,hasProtectedContent,redactSensitiveContent,createSensitiveAttachment,removeSensitiveAttachment,inspectAttachment,createSensitivePolicy};
