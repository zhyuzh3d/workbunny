'use strict';
const {spawn,execFile}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {fields,text}=require('./agent-contract');
const {checkedJSON}=require('./agent-json');
function terminalArgs(v){
 fields(v,['application','command','args','cwd','impact','purpose','timeoutSeconds'],'终端操作');
 if(v.application!=='system'||!['read','reversible','configuration'].includes(v.impact)||!Array.isArray(v.args)||v.args.length>100||v.args.some(a=>typeof a!=='string'||a.length>16000||a.includes('\0')))throw Error('终端操作参数不合法');
 const command=text(v.command,'程序',1000),args=v.args;
 require('./interaction-policy').assertTerminalTargets(command,args);
 const code=[command,...args].join(' ');
 if(/(?:^|[\s/])sudo(?:\s|$)|\b(?:mkfs|diskutil\s+erase|rm\s+-[^\s]*r[^\s]*f)\b|(?:killall|pkill)\s+.*(?:WeChat|微信)|(?:\/Applications\/WeChat\.app|Library\/Containers\/com\.tencent\.xinWeChat)|osascript[\s\S]*(?:WeChat|微信)/iu.test(code))throw Error('该命令超出非破坏性终端或微信视觉操作范围');
 const seconds=v.timeoutSeconds??30;if(!Number.isInteger(seconds)||seconds<1||seconds>300)throw Error('命令时限应为1到300秒');
 return {...v,command,purpose:text(v.purpose,'操作目的',600),timeoutSeconds:seconds,...(v.cwd?{cwd:text(v.cwd,'工作目录',2000)}:{})};
}
async function executeTerminal(args,{task,signal,directory,resources,operationId}){
 require('./interaction-policy').assertTerminalTargets(args.command,args.args);
 const assertLive=()=>{if(signal?.aborted)throw Object.assign(Error('任务已停止，未执行命令'),{dispatched:false});};assertLive();
 const cwd=args.cwd||path.join(directory,task.id);if(!args.cwd)await fs.mkdir(cwd,{recursive:true,mode:0o700});
 const actual=await fs.realpath(cwd),env=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 let cleanup=async()=>({verified:true,reason:'命令尚未启动'});
 const handle=await resources?.register({id:'process:'+(operationId||require('node:crypto').randomUUID()),kind:'process',label:'命令 '+path.basename(args.command),ownership:'owned',phase:'starting'},(cancel)=>cleanup(cancel));assertLive();
 return new Promise((resolve,reject)=>{
  let child,output='',errorOutput='',bytes=0,timer,killTimer,cancelled=false,closed=false,binding=Promise.resolve();
  const alive=()=>{try{process.kill(-child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
  const stop=()=>{if(cancelled||closed||child.exitCode!==null)return;cancelled=true;try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{if(closed||child.exitCode!==null)return;try{process.kill(-child.pid,'SIGKILL');}catch{}},700);};
  try{child=spawn(args.command,args.args,{cwd:actual,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});}catch(error){reject(Object.assign(error,{dispatched:false}));return;}
  cleanup=async cancel=>{if(alive()&&(closed||child.exitCode!==null))return {verified:false,reason:'原命令已退出，组内进程的当前归属不能重新确认，已保留'};stop();const until=Date.now()+3000;while(alive()&&Date.now()<until&&!cancel?.aborted)await new Promise(r=>setTimeout(r,50));return {verified:!alive(),reason:alive()?'已取消命令，进程组结束尚未确认':'本任务命令进程组已结束'};};
  child.once('spawn',()=>{if(resources)binding=resources.identifyProcess(child.pid).then(identity=>handle.update({identity,phase:closed&&!alive()?'ended':'running'})).catch(()=>{stop();});});
  const take=(chunk,isError)=>{bytes+=chunk.length;if(bytes>96*1024){stop();return;}if(isError)errorOutput+=chunk.toString();else output+=chunk.toString();};
  child.stdout.on('data',c=>take(c,false));child.stderr.on('data',c=>take(c,true));
  child.once('error',error=>{closed=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);void handle?.update({phase:'ended',verified:true,reason:'程序未启动'}).catch(()=>{});reject(Object.assign(error,{dispatched:false}));});
  child.once('close',async(exitCode,termSignal)=>{closed=true;clearTimeout(timer);if(!alive())clearTimeout(killTimer);signal?.removeEventListener('abort',stop);
   try{await binding;await handle?.update({phase:alive()?'running':'ended',liveHandleEnded:true,verified:!alive(),reason:alive()?'主命令已退出，组内仍有进程':'命令进程组已结束'});}catch{}
   const redact=s=>require('./conversation-input').containsSecret(s)?'[输出含凭据，留在本机处理]':s.slice(-12000);
   resolve({ok:true,verified:true,exitCode,signal:termSignal,cancelled,stdout:redact(output),stderr:redact(errorOutput),cwd:actual});
  });
  timer=setTimeout(stop,args.timeoutSeconds*1000);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 });
}

const command=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:10000,maxBuffer:128*1024},(error,stdout,stderr)=>error?reject(error):resolve(stdout)));
function preferenceArgs(v){
 fields(v,['application','domain','key','type','value'],'用户偏好');
 if(v.application!=='system'||!['string','bool','int'].includes(v.type)||typeof v.value!=='string'||v.value.length>1000)throw Error('用户偏好格式无效');
 const domain=text(v.domain,'偏好域',160),key=text(v.key,'偏好键',160);
 if(!/^[a-zA-Z0-9_.-]+$/.test(domain)||/TCC|loginwindow|firewall|security|xinWeChat|password|authorization/iu.test(domain+' '+key))throw Error('该设置不属于一般用户偏好');
 if(v.type==='bool'&&!/^(true|false|1|0)$/.test(v.value)||v.type==='int'&&!/^-?\d+$/.test(v.value))throw Error('用户偏好值与类型不符');
 return {...v,domain,key};
}
const preferenceInput=a=>a.type==='bool'?(['true','1'].includes(a.value)?'true':'false'):a.value;
const preferenceValue=a=>a.type==='bool'?(['true','1'].includes(a.value)?'1':'0'):a.type==='int'?String(Number(a.value)):a.value;
async function readPreference(domain,key){
 let value;try{value=(await command('/usr/bin/defaults',['read',domain,key])).replace(/\n$/,'');}catch(error){if(/does not exist/u.test(String(error.stderr||error.message)))return null;throw error;}
 const description=await command('/usr/bin/defaults',['read-type',domain,key]);const type=/boolean/i.test(description)?'bool':/integer/i.test(description)?'int':/string/i.test(description)?'string':null;
 if(!type)throw Object.assign(Error('原偏好为复杂类型，改用保留完整类型的方法'),{dispatched:false});return {type,value};
}
function registerSystemTools(tools,{directory=path.join(os.tmpdir(),'workbunny-tasks'),checkpoint=async()=>{}}={}){
 tools.register({name:'terminal.execute',description:'在主人授权内执行非破坏性命令或可恢复的新脚本。声明目的、影响和工作目录，根据输出核对；开关关闭时引导授权。',effect:'write',capabilities:['terminal.execute'],scope:()=>({application:'system'}),validate:terminalArgs,execute:(a,c)=>executeTerminal(a,{...c,directory})});
 tools.register({name:'system.configure',description:'修改可恢复的用户级偏好，保存原值、类型及快照ID，再读取核对；需要系统配置开关。',effect:'write',capabilities:['system.configure'],scope:()=>({application:'system'}),validate:preferenceArgs,
 execute:async(a,{task,operationId})=>{
  const before=await readPreference(a.domain,a.key),expected={type:a.type,value:preferenceValue(a)};
  task.state.configurationSnapshots??=[];const snapshot={id:operationId,domain:a.domain,key:a.key,before,expected,at:Date.now()};task.state.configurationSnapshots.push(snapshot);await checkpoint(task);
  await command('/usr/bin/defaults',['write',a.domain,a.key,'-'+a.type,preferenceInput(a)]);const observed=await readPreference(a.domain,a.key);
  if(JSON.stringify(observed)!==JSON.stringify(expected))throw Error('偏好实际值与要求不符，原值已保存');
  return {ok:true,verified:true,receipt:{snapshotId:snapshot.id,domain:a.domain,key:a.key,observed}};
 }});
 tools.register({name:'system.restore',description:'恢复本任务保存的用户级偏好；若主人期间另有修改则保留现值。',effect:'write',capabilities:['system.configure'],scope:()=>({application:'system'}),
 validate:v=>{fields(v,['application','snapshotId'],'恢复设置');if(v.application!=='system')throw Error('恢复对象无效');return {...v,snapshotId:text(v.snapshotId,'快照ID',100)};},
 execute:async(a,{task})=>{
  const backup=task.state.configurationSnapshots?.find(s=>s.id===a.snapshotId);if(!backup)throw Object.assign(Error('找不到本任务的设置快照'),{dispatched:false});
  const current=await readPreference(backup.domain,backup.key);
  if(JSON.stringify(current)===JSON.stringify(backup.before))return {ok:true,verified:true,receipt:{restored:true,alreadyRestored:true,snapshotId:a.snapshotId}};
  if(JSON.stringify(current)!==JSON.stringify(backup.expected))throw Object.assign(Error('偏好已被另行修改，保留当前值'),{dispatched:false});
  if(backup.before)await command('/usr/bin/defaults',['write',backup.domain,backup.key,'-'+backup.before.type,preferenceInput(backup.before)]);
  else await command('/usr/bin/defaults',['delete',backup.domain,backup.key]);
  const observed=await readPreference(backup.domain,backup.key);if(JSON.stringify(observed)!==JSON.stringify(backup.before))throw Error('恢复后核对未通过');
  backup.restoredAt=Date.now();await checkpoint(task);return {ok:true,verified:true,receipt:{restored:true,snapshotId:a.snapshotId}};
 }});
}

function systemSkill({request}={}){return require('./adaptive-task').adaptiveSkill({id:'system.operate',title:'系统自处理',description:'主人让Bunny自己检查环境、执行非破坏性终端命令、修改可恢复用户配置。parameters为空，subjects=[{application:"system"}]。根据真实输出主动修正。',tools:['terminal.execute','system.configure','system.restore'],capabilities:['terminal.execute','system.configure'],request,validate:s=>{if(s.subjects.length!==1||s.subjects[0].application!=='system')throw Error('系统操作需要明确系统对象');}});}

module.exports={registerSystemTools,systemSkill,executeTerminal,terminalArgs,readPreference};
