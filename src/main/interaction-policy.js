'use strict';
// Software experience declares the permitted channels. The generic boundary
// checks a concrete operation's target; a cross-software Task is not assigned
// one channel or a mandatory priority order.
const fs=require('node:fs'),path=require('node:path');
const CHANNELS=Object.freeze(['service','terminal','structured-ui','visual']);
let profiles;
function policies(){
 if(!profiles){profiles=[];const root=path.join(__dirname,'../software-skills');
  for(const id of fs.readdirSync(root)){const file=path.join(root,id,'manifest.json');if(!fs.existsSync(file))continue;const p=JSON.parse(fs.readFileSync(file,'utf8'));
   if(p.interaction){if(!Array.isArray(p.interaction.allowedChannels)||p.interaction.allowedChannels.some(c=>!CHANNELS.includes(c))||p.interaction.requiredInputBackend&&!['virtual-hid'].includes(p.interaction.requiredInputBackend))throw Error('软件操作通道约束无效');profiles.push(p);}}
 }return profiles;
}
function profile(application,bundle){const names=[application,bundle].filter(v=>typeof v==='string').map(v=>v.trim().toLowerCase());return policies().find(p=>[p.id,p.application,...(p.aliases||[])].some(n=>names.includes(String(n).trim().toLowerCase())));}
function inputRequirement(application,bundle){return profile(application,bundle)?.interaction.requiredInputBackend;}
function validateTaskChannels(value){if(!Array.isArray(value)||!value.length||value.length>CHANNELS.length||value.some(channel=>!CHANNELS.includes(channel))||new Set(value).size!==value.length)throw Object.assign(Error('任务交互方法须为非空且不重复的service/terminal/structured-ui/visual列表'),{code:'E_INTERACTION_CHANNEL',dispatched:false});return [...value];}
function taskAllowsChannel(task,channel){if(!channel||task?.interactionChannels===undefined)return true;return validateTaskChannels(task.interactionChannels).includes(channel);}
function assertTaskChannel(task,channel){if(!taskAllowsChannel(task,channel))throw Object.assign(Error('主人限定的任务交互方法不允许此通道：'+channel+'；允许：'+task.interactionChannels.join('、')),{code:'E_INTERACTION_CHANNEL',dispatched:false});}
function context(task){return (task.subjects||[]).map(({application})=>({application,allowedChannels:(profile(application)?.interaction.allowedChannels||CHANNELS).filter(channel=>taskAllowsChannel(task,channel)),...(inputRequirement(application)?{requiredInputBackend:inputRequirement(application)}:{}),experienceReferences:(task.state.operatingKnowledge||[]).filter(k=>!task.state.excludedExperienceIds?.includes(k.sourceId)&&k.tags?.includes('software:'+application)).map(k=>({sourceId:k.sourceId,status:k.status,revision:k.revision,feedback:k.feedback||[]}))}));}
function assertChannel(application,channel,bundle){const p=profile(application,bundle);if(p&&!p.interaction.allowedChannels.includes(channel))throw Object.assign(Error('该软件未授权此操作通道：'+channel+'；可用：'+p.interaction.allowedChannels.join('、')),{code:'E_INTERACTION_CHANNEL',dispatched:false});}
function directSoftwareTargets(command,args=[]){
 const candidates=[],name=path.basename(command),app=value=>{const literal=String(value),bundle=/(?:^|\/)([^/]+)\.app(?:\/|$)/iu.exec(literal);candidates.push(bundle?bundle[1]:literal.replace(/\.app$/iu,''));};
 app(command);for(const arg of args)if(/\.app(?:\/|$)/iu.test(arg))app(arg);
 if(name==='open')for(let i=0;i<args.length;i++){if(args[i]==='--args')break;if(['-a','-b'].includes(args[i]))app(args[++i]||'');else if(/^-[ab].+/u.test(args[i]))app(args[i].slice(2));else{const scheme=/^([a-z][a-z0-9+.-]*):/iu.exec(args[i]);if(scheme)for(const p of policies())if(p.interaction.urlSchemes?.includes(scheme[1].toLowerCase()))candidates.push(p.application);}}
 if(name==='osascript')for(let i=0;i<args.length;i++)if(args[i]==='-e')for(const match of String(args[++i]||'').matchAll(/\bapplication\s+(?:id\s+)?"([^"\n]+)"/giu))app(match[1]);
 if(['sdef','defaults','pgrep','pkill','killall'].includes(name))for(const arg of args)app(arg);
 return [...new Set(candidates.map(value=>profile(value)?.application).filter(Boolean))];
}
function assertTerminalTargets(command,args){const targets=directSoftwareTargets(command,args);for(const target of targets)assertChannel(target,'terminal');return targets;}
function channelForTool(name,application,bundle){if(name==='software.inspect'&&application){const p=profile(application,bundle);if(p?.interaction.allowedChannels.length===1&&p.interaction.allowedChannels[0]==='visual')return null;}if(name==='software.service')return 'service';if(['software.command','terminal.execute','system.configure','system.restore'].includes(name))return 'terminal';if(['software.inspect','software.interface','software.control','software.recover'].includes(name))return 'structured-ui';if(name.startsWith('files.')||name.startsWith('work.'))return 'service';if(name.startsWith('screen.')||name.startsWith('conversation.')||['result.deliver','result.attach'].includes(name))return 'visual';return null;}
module.exports={CHANNELS,validateTaskChannels,taskAllowsChannel,assertTaskChannel,profile,assertChannel,channelForTool,context,inputRequirement,directSoftwareTargets,assertTerminalTargets};
