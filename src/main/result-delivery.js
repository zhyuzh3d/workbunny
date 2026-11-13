'use strict';
const {fields,text}=require('./agent-contract');
const {deliveryText}=require('./task-result');
const {resultLinks}=require('./result-links');
const collectedDelivery=task=>task.delivery?.channel==='wechat'&&!!task.delivery.recipient&&!!task.state?.result;
function registerResultTools(tools,{deliver}){
 tools.register({name:'result.deliver',description:'交付宿主已回收至Task.state.result的成果，仅在成果已设立且原Task.delivery为微信时可用。工作已完成、只差最终交付时输出done:true和summary，由宿主先保存成果再自动交付，不另建交付Action。收件人由原Task.delivery.recipient绑定，独立于Task.subjects；args仅为{message:已回收成果原文}，不接受application或recipient参数，不重做工作，不重复播报。',effect:'write',capabilities:['conversation.send'],available:collectedDelivery,continuationPolicy:(task,input)=>require('./effect-review').boundedPolicy(task,input),
 inputSchema:{type:'object',properties:{message:{type:'string',minLength:1,maxLength:3000,description:'已回收的实际成果正文；收件人沿用原Task.delivery，不在args中指定。'}},required:['message'],additionalProperties:false},
 validate:v=>{fields(v,['message'],'成果交付');return {message:text(v.message,'成果消息',3000)};},execute:(a,c)=>deliver(a.message,c.task,c.signal,undefined,c.operationId)});
 tools.register({name:'result.attach',description:'发送宿主已回收至Task.state.result.artifacts的真实文件，仅在成果已设立且原Task.delivery为微信时可用。工作完成后输出done:true及真实文件清单，由宿主自动交付；收件人由原Task.delivery.recipient绑定，args仅为{index:文件序号}，不接受application或recipient参数。核对文件指纹以及新增文件卡片。',effect:'write',capabilities:['conversation.send'],available:collectedDelivery,continuationPolicy:(task,input)=>require('./effect-review').boundedPolicy(task,input),
 inputSchema:{type:'object',properties:{index:{type:'integer',minimum:0,maximum:3,description:'当前成果artifacts中的真实文件序号。'}},required:['index'],additionalProperties:false},
 validate:v=>{fields(v,['index'],'成果附件');if(!Number.isInteger(v.index)||v.index<0||v.index>3)throw Error('附件序号无效');return v;},execute:(a,c)=>deliver(null,c.task,c.signal,a.index,c.operationId)});
}
async function deliverResult({task,call,checkpoint,report}){
 if(!task.state.result)throw Error('还没有可交付的实际成果');
 const result=task.state.result,target=(task.delivery?.channel||'speech')+':'+(task.delivery?.recipient||'');
 if(task.state.delivery&&task.state.delivery.target!==target){task.state.deliveryHistory=[...(task.state.deliveryHistory||[]),task.state.delivery].slice(-8);delete task.state.delivery;}
 task.note=task.delivery?.channel==='wechat'?'成果已回收，正在交付微信':'成果已回收，准备简短汇报';
 task.state.delivery??={...(task.delivery||{channel:'speech'}),status:'pending',target};await checkpoint();
 if(task.state.delivery.status==='delivered')return;
 if(task.delivery?.channel==='wechat'){
  const sent=await call({tool:'result.deliver',key:'deliver-result:'+result.revision+':'+target,args:{message:deliveryText(result)}});
  task.state.delivery={...task.delivery,target,status:'sending_files',receipt:sent.receipt,files:task.state.delivery.files||[]};await checkpoint();
  for(let index=0;index<(task.delivery?.includeFiles===false?0:(result.artifacts||[]).length);index++){
   const file=await call({tool:'result.attach',key:'deliver-file:'+result.revision+':'+target+':'+index,args:{index}});task.state.delivery.files[index]=file.receipt;await checkpoint();
  }
  task.state.delivery.status='delivered';
 }else{
  await report(deliveryText(result,{maxLength:12000}),'result:'+result.revision,{links:resultLinks(result),speechText:result.summary});if(task.state.delivery.status!=='delivered')task.state.delivery.status='queued';
 }
 await checkpoint();
}
const forwardResultSkill={id:'result.forward',title:'转发已有成果',version:1,subjectApplications:['bunny'],description:'转发已回收的真实成果，不重新安排制作。parameters={sourceTaskId:实际已结束任务ID}，subjects=[{application:"bunny"}]，delivery指定微信对象或语音。',tools:['result.deliver','result.attach'],capabilities:['conversation.send','screen.input'],capabilitiesFor:s=>s.delivery?.channel==='wechat'?['conversation.send','screen.input']:[],
 validate:s=>{fields(s.parameters,['sourceTaskId'],'成果来源');text(s.parameters.sourceTaskId,'原任务ID',100);if(s.subjects.length!==1||s.subjects[0].application!=='bunny')throw Error('转发任务对象应为Bunny');},
 async run(context){await deliverResult(context);return {status:'completed',note:context.task.state.delivery.status==='delivered'?'已转发原成果':context.task.state.result.summary,state:context.task.state};}};
module.exports={registerResultTools,deliverResult,forwardResultSkill};
