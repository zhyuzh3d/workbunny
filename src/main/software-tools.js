'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fields,text}=require('./agent-contract');
const {terminalArgs,executeTerminal}=require('./system-tools');
const CHANNELS=['cli','interface','visual'];
const object=properties=>({type:'object',properties,additionalProperties:false}),string={type:'string'};
function application(value){return text(value,'软件标识',160);}
function visualOnly(value,bundle){return value==='wechat'||String(bundle||value).toLowerCase()==='com.tencent.xinwechat';}
function remember(task,entry){
 task.state.softwareMethods??=[];
 const compact=Object.fromEntries(Object.entries(entry).map(([key,value])=>[key,Array.isArray(value)?value.slice(0,16).map(v=>String(v).slice(0,240)):typeof value==='string'?value.slice(0,1000):value]));
 task.state.softwareMethods.push({...compact,at:Date.now()});task.state.softwareMethods=task.state.softwareMethods.slice(-24);
}
function registerSoftwareTools(tools,{native,directory,lease,sensitivePolicy}={}){
 const descriptor=async(a,c,refresh=false)=>{
  const old=c.task.state.software?.[a.application];if(old&&!refresh)return old;
  const bundleId=a.bundleId||require('./screen-watch-skill').APPLICATIONS[a.application]||a.application;
  if(visualOnly(a.application,bundleId))return {application:a.application,bundleId:'com.tencent.xinWeChat',methods:['visual'],boundary:'微信先天经验：仅外部画面与模拟键鼠，不探测命令行、内部接口或界面树。'};
  const info=await native.request('softwareInfo',{bundleId},5000);
  c.task.state.software??={};c.task.state.software[a.application]={...info,application:a.application,bundleId:info.bundleId||bundleId};
  return c.task.state.software[a.application];
 };
 const available=task=>['software.execute','system.operate'].includes(task.skill);
 const interfaceAvailable=task=>available(task)&&task.subjects.some(s=>!['system','wechat'].includes(s.application));
 tools.register({name:'software.recover',description:'软件调用卡住时诊断真实响应；只有两次有时限的请求均失败、且软件由本任务或已停止任务专属启动且未共享时，才尝试正常退出重开并核对响应。保留共享软件和未保存内容；失败时改用其它可用方法或报告具体原因。',effect:'write',capabilities:['screen.input'],scope:a=>({application:a.application}),available:interfaceAvailable,inputSchema:object({application:string}),validate:v=>{fields(v,['application'],'软件恢复');application(v.application);if(visualOnly(v.application))throw Error('微信不得通过接口诊断或重启');return v;},execute:async(a,c)=>{
  const info=await descriptor(a,c);if(visualOnly(a.application,info.bundleId))throw Object.assign(Error('微信不允许重启'),{dispatched:false});if(!c.resources)throw Object.assign(Error('当前任务缺少可追踪的软件归属句柄'),{dispatched:false});return c.resources.recoverApplication(info.bundleId);
 }});
 tools.register({name:'software.inspect',description:'首次操作软件或旧经验失效时，读取实际安装版本、可用命令行入口、脚本字典及界面接口条件。先结合已有经验判断 CLI 能否完成任务，再尝试系统/界面接口，最后视觉键鼠；不强制重复探索已验证方法。微信直接返回视觉专用边界，不作接口探测。',effect:'read',capabilities:[],scope:a=>({application:a.application}),available,
  inputSchema:object({application:string,bundleId:string,cliNames:{type:'array',items:string}}),
  validate:v=>{fields(v,['application','bundleId','cliNames'],'软件能力检查');application(v.application);if(v.bundleId!==undefined)text(v.bundleId,'软件Bundle ID',200);if(v.cliNames!==undefined&&(!Array.isArray(v.cliNames)||v.cliNames.length>8||v.cliNames.some(n=>typeof n!=='string'||!/^[-a-zA-Z0-9_.]{1,80}$/u.test(n))))throw Error('命令行名称无效');return v;},
  execute:async(a,c)=>{
   const info=await descriptor(a,c,true);if(visualOnly(a.application,info.bundleId))return info;
   const names=[...new Set(a.cliNames||[a.application])],candidates=[];
   for(const name of names)for(const dir of (process.env.PATH||'').split(path.delimiter).filter(Boolean)){
    const candidate=path.join(dir,name);try{await fs.access(candidate,require('node:fs').constants.X_OK);if((await fs.stat(candidate)).isFile())candidates.push(candidate);}catch{}
   }
   const result={...info,cliCandidates:[...new Set([...(info.cliCandidates||[]),...candidates])].slice(0,20),methodOrder:CHANNELS};
   c.task.state.software[a.application]=result;remember(c.task,{application:a.application,channel:'discovery',version:info.version,cliCandidates:result.cliCandidates,scriptDictionaries:info.scriptDictionaries,interfaceAvailable:info.accessibilityTrusted});return result;
  }});
 tools.register({name:'software.command',description:'调用授权软件的命令行或系统接口。先读帮助/实际能力，使用任务独立目录，保留退出码与真实输出；进程正常退出不等于业务成功。此通道不操作微信。',effect:'write',capabilities:['terminal.execute'],scope:a=>({application:a.application}),available,
  inputSchema:object({application:string,command:string,args:{type:'array',items:string},cwd:string,impact:{enum:['read','reversible','configuration']},purpose:string,timeoutSeconds:{type:'integer',minimum:1,maximum:300}}),
  validate:v=>{application(v.application);if(visualOnly(v.application))throw Error('微信仅允许视觉键鼠');return {...terminalArgs({...v,application:'system'}),application:v.application};},
  execute:async(a,c)=>{const info=await descriptor(a,c);if(visualOnly(a.application,info.bundleId))throw Object.assign(Error('微信仅允许视觉键鼠'),{dispatched:false});const result=await executeTerminal({...a,application:'system'},{...c,directory});remember(c.task,{application:a.application,channel:'cli',version:info.version,command:a.command,args:a.args,exitCode:result.exitCode,cancelled:result.cancelled});return result;}});
 tools.register({name:'software.interface',description:'读取授权软件的系统界面树、控件语义和可用操作。后台读取，不抢前台；控件不可用时换其它方法。微信禁止此通道。',effect:'read',capabilities:['screen.read'],scope:a=>({application:a.application}),available:interfaceAvailable,
  inputSchema:object({application:string}),validate:v=>{fields(v,['application'],'软件界面');application(v.application);if(visualOnly(v.application))throw Error('微信禁止界面树');return v;},
  execute:async(a,c)=>{const info=await descriptor(a,c);if(visualOnly(a.application,info.bundleId))throw Object.assign(Error('微信禁止界面树'),{dispatched:false});const result=await native.request('softwareInterface',{bundleId:info.bundleId},8000);if(result.available)c.task.state.software[a.application].interfaceTarget=result.target;remember(c.task,{application:a.application,channel:'interface',version:info.version,available:result.available,controls:result.nodes?.length||0});return result;}});
 tools.register({name:'software.control',description:'按刚读到的唯一控件 role 和 label 做后台定向 press/setValue，不移动全局鼠标或键入其它应用。输入须给 expectedValue 以保护主人同期编辑；成功回执只代表输入已执行，Task/Action 仍须核验。微信禁止此通道。',effect:'write',capabilities:['screen.input'],scope:a=>({application:a.application}),available:interfaceAvailable,
  inputSchema:object({application:string,role:string,label:string,action:{enum:['press','setValue']},value:string,expectedValue:string}),
  validate:v=>{fields(v,['application','role','label','action','value','expectedValue'],'软件控件');application(v.application);if(visualOnly(v.application))throw Error('微信禁止界面控件');text(v.role,'控件角色',100);if(typeof v.label!=='string'||v.label.length>300||!['press','setValue'].includes(v.action))throw Error('控件选择无效');if(v.action==='setValue'&&(typeof v.value!=='string'||v.value.length>12000||typeof v.expectedValue!=='string'))throw Error('输入须提供原值与新值');return v;},
  execute:async(a,c)=>{
   const info=await descriptor(a,c);if(visualOnly(a.application,info.bundleId))throw Object.assign(Error('微信禁止界面控件'),{dispatched:false});
   if(require('./screen-action-tools').destructiveLabel(a.label))throw Object.assign(Error('控件超出非破坏性操作范围'),{dispatched:false});
   if(!info.interfaceTarget)throw Object.assign(Error('先读取当前软件界面树'),{dispatched:false});
   if(a.action==='setValue'&&a.application==='workbuddy')await sensitivePolicy?.check({target:'workbuddy',text:a.value});
   const owner='software-interface:'+c.task.id;await lease?.acquire(owner,c.signal);
   try{if(c.signal?.aborted)throw Object.assign(Error('任务已停止'),{dispatched:false});const result=await native.request('softwareControl',{...info.interfaceTarget,...a},8000);remember(c.task,{application:a.application,channel:'interface',version:info.version,role:a.role,label:a.label,action:a.action,performed:result.performed});return {ok:true,verified:result.performed===true,receipt:{inputPerformed:true,method:'interface',application:a.application,action:a.action}};}finally{lease?.release(owner);}
  }});
}
module.exports={registerSoftwareTools,remember,visualOnly,CHANNELS};
