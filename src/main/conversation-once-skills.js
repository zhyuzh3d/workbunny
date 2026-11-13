'use strict';
const {text}=require('./agent-contract');
const sendOnceDefinition={id:'conversation.send',title:'发送消息',version:1,subjectApplications:['wechat'],description:'只向指定会话发送主人指定的完整原文一次，并核验已发送气泡；完成退回后依据真实回执自主只读核查和重新评估，不重发已确认消息。',
 tools:['conversation.send','conversation.observe'],capabilities:['conversation.send'],optionalCapabilities:['conversation.read','screen.read'],requiredCapabilities:['conversation.send'],
 validate:spec=>{if(spec.subjects.some(s=>!s.recipient))throw new Error('请明确收件人');text(spec.parameters.message,'指定原文',3500);},
 async run({task,call,report}){
  for(const s of task.subjects)await call({tool:'conversation.send',key:'send:'+s.application+':'+s.recipient,args:{...s,message:task.parameters.message}});
  await report('已发送给 '+task.subjects.map(s=>s.recipient).join('、')+'，并核对已发送气泡。','sent-once');
  return {status:'completed',note:'指定消息已发送并核验',state:task.state};
 }};
function createSendOnceSkill(){return {...sendOnceDefinition,repeatConfirmedEffects:false};}
const sendOnceSkill=createSendOnceSkill();
const readOnceSkill={id:'conversation.read',title:'只读查看',version:1,subjectApplications:['wechat'],description:'只读查看指定会话的最新可见消息并向主人汇报，不向联系人发送任何消息。',
 tools:['conversation.observe','conversation.open'],capabilities:['conversation.read','screen.input'],
 async run({task,call,report}){
  const messages=[];
  for(const s of task.subjects){
   let view=await call({tool:'conversation.observe',key:'read-before:'+s.recipient,args:s});
   if(view.unavailable)return {status:'needs_attention',note:view.reason,state:task.state};
   if(!view.headerMatched){await call({tool:'conversation.open',key:'open-read:'+s.recipient,args:s});view=await call({tool:'conversation.observe',key:'read-opened:'+s.recipient,args:{...s,force:true}});}
   if(!view.headerMatched)return {status:'needs_attention',note:'尚未核对指定会话标题',state:task.state};
   messages.push(s.recipient+'：'+view.messages.slice(-6).map(m=>(m.direction==='incoming'?'对方':'本账号')+'：'+m.text).join('\n'));
  }
  await report(messages.join('\n\n')||'没有可确认的可见消息','read-once');return {status:'completed',note:'已只读查看并汇报',state:task.state};
 }};
module.exports={sendOnceSkill,readOnceSkill,createSendOnceSkill};
