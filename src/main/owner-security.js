'use strict';
const crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
let active;
const values=()=>active?[...active.protectedValues]:[];
function variants(value){return [...new Set([value,encodeURIComponent(value),JSON.stringify(value).slice(1,-1),Buffer.from(value).toString('base64')])].filter(Boolean);}
function redact(text){let out=String(text??'');for(const value of values())for(const part of variants(value))out=out.split(part).join('********');return out;}
function contains(text){return redact(text)!==String(text??'');}
function sanitize(value){if(typeof value==='string')return redact(value);if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null))return Object.fromEntries(Object.entries(value).map(([k,v])=>[redact(k),sanitize(v)]));return value;}
function withPrinciples(invoke,options){
 const messages=(options.messages||[]).map(m=>({...m})),system=messages.find(m=>m.role==='system'&&typeof m.content==='string');
 if(system&&!messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes('# Bunny')))system.content=require('./bunny-principles')+'\n'+system.content;
 return invoke({...options,messages});
}
class OwnerSecurity{
 constructor({file,encrypt,decrypt,onChange=()=>{},clock=Date.now}={}){Object.assign(this,{file,encrypt,decrypt,onChange,clock});this.key='';this.enabled=false;this.version=0;this.protectedValues=new Set();this.tail=Promise.resolve();}
 async init(){
  try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));this.key=raw.cipher?this.decrypt(Buffer.from(raw.cipher,'base64')):'';this.enabled=raw.enabled===true;this.version=Number.isSafeInteger(raw.version)?raw.version:0;if(this.key)this.protectedValues.add(this.key);}
  catch(error){this.enabled=false;if(error.code!=='ENOENT'){this.key='';this.error='身份密钥存储无法解锁，外部主人认证已停用；可在本机重新设置。';}}
  active=this;return this;
 }
 status(){return {enabled:this.enabled,configured:!!this.key,version:this.version,...(this.error?{error:this.error}:{})};}
 matches(text){return this.enabled&&!!this.key&&typeof text==='string'&&text.length<=128*1024&&text.includes(this.key);}
 candidate(text){
  if(!this.enabled||!this.key||typeof text!=='string'||text.length>128*1024)return null;
  if(this.matches(text))return {score:1,text:this.key};
  // Semi-global edit distance finds a key-like span inside the actual new
  // message, without changing case, normalizing characters or granting access.
  const key=[...this.key],input=[...text];let costs=new Uint16Array(key.length+1),starts=new Uint32Array(key.length+1),next=new Uint16Array(key.length+1),from=new Uint32Array(key.length+1);
  for(let i=0;i<=key.length;i++)costs[i]=i;
  let best=key.length,span=null;
  for(let j=0;j<input.length;j++){
   next[0]=0;from[0]=j+1;
   for(let i=1;i<=key.length;i++){
    const sub=costs[i-1]+(key[i-1]===input[j]?0:1),del=next[i-1]+1,ins=costs[i]+1;
    if(sub<=del&&sub<=ins){next[i]=sub;from[i]=starts[i-1];}
    else if(del<=ins){next[i]=del;from[i]=from[i-1];}
    else{next[i]=ins;from[i]=starts[i];}
   }
   if(next[key.length]<best){best=next[key.length];span={start:from[key.length],end:j+1};}
   [costs,next]=[next,costs];[starts,from]=[from,starts];
  }
  const score=1-best/key.length;
  return span&&best*5<key.length*2?{score,text:input.slice(span.start,span.end).join('')}:null;
 }
 change(key){
  if(typeof key!=='string'||key&&([...key].length<8||key.length>256||key.trim()!==key||/^\*+$/u.test(key)||/[\u0000-\u001f\u007f]/u.test(key)))return Promise.reject(Error('身份密钥须为8至256个字符，不使用纯星号、首尾空白或控制字符；留空可清除'));
  return this.updateState(()=>{if(key&&!this.enabled)throw Error('请由主人先在本地设置中打开身份识别');return {key,enabled:this.enabled};});
 }
 // Only the trusted local settings IPC exposes this method, never agent tools.
 setEnabled(enabled){
  if(typeof enabled!=='boolean')return Promise.reject(Error('身份识别开关须为布尔值'));
  return this.updateState(()=>({key:this.key,enabled}));
 }
 updateState(next){
  const job=this.tail.then(async()=>{
   const {key,enabled}=next();if(key===this.key&&enabled===this.enabled)return this.status();
   // Revoke synchronously before persistence or any asynchronous UI work.
   this.version++;this.key='';this.enabled=false;await this.onChange(this.status());
   if(key)this.protectedValues.add(key);
   const body=JSON.stringify({version:this.version,enabled,cipher:key?this.encrypt(key).toString('base64'):''});
   const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
   try{await fs.writeFile(temporary,body,{mode:0o600,flag:'wx'});await fs.rename(temporary,this.file);this.key=key;this.enabled=enabled;this.error='';}catch(error){await fs.unlink(temporary).catch(()=>{});throw Error('身份设置保存失败，外部主人权限已撤销');}
   return this.status();
  });this.tail=job.catch(()=>{});return job;
 }
}
module.exports={OwnerSecurity,redact,sanitize,contains,withPrinciples,activate:service=>{active=service;}};
