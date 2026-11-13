'use strict';
const {fields,text}=require('./agent-contract');
function subject(value,extra=[]){
  fields(value,['application','recipient',...extra],'会话工具');
  if(value.application!=='wechat')throw new Error('当前会话技能尚未支持此应用');
  return {application:value.application,recipient:text(value.recipient,'联系人',100)};
}
function registerConversationTools(tools,{scene,execute,lease,saveAttachment,canOperate=async()=>true,memoryRelated=async()=>({items:[]}),dispatchOwner=async()=>{throw new Error('主人通道执行器尚未就绪');}}){
  tools.register({name:'conversation.observe',description:'以外部显示像素观察指定会话，未变化时不识别；返回标题、未读提示、完整可见消息和草稿状态。',
    effect:'read',capabilities:['conversation.read'],scope:a=>a,
    validate:v=>({...subject(v,['sampleId','force','relocate']),force:v.force===true,relocate:v.relocate===true}),execute:async(a,c)=>{await scene.assertTaskIdentity?.(c.task);const prior=c.task.state?.conversations?.[require('./conversation-skill').subjectKey(a)]?.cursor?.recent;return scene.observe(a,{signal:c.signal,force:a.force,relocate:a.relocate,repairProfile:c.task.state?.selfRepair?.profile,referenceMessages:prior?{recipient:a.recipient,messages:prior.slice(-6).map(m=>({direction:m.direction,kind:m.kind,text:String(m.text||'').slice(0,300),time:m.time||''}))}:undefined});}});
  tools.register({name:'conversation.open',description:'仅用视觉和键鼠打开指定会话，核对顶部标题；不输入消息正文。',
    effect:'read',capabilities:['screen.input'],scope:a=>a,validate:v=>subject(v),execute:async(a,c)=>{
      await scene.assertTaskIdentity?.(c.task,{signal:c.signal});const r=await execute({...a,operation:'open',signal:c.signal,action:c.action,task:c.task,operationId:c.operationId});scene.invalidate();
      if(!r.ok)throw Object.assign(new Error(r.error||'未能打开会话'),{dispatched:false,...(r.visualFeedback?{visualFeedback:r.visualFeedback}:{}),...(r.code?{code:r.code}:{}),...(r.diagnostic?{diagnostic:r.diagnostic}:{})});return {ok:true,trust:'interpretation-not-authorization',...(r.receipt?{receipt:r.receipt}:{}),...(r.executionClaim?{executionClaim:r.executionClaim}:{}),...(r.visualFeedback?{visualFeedback:r.visualFeedback}:{})};
    }});
  tools.register({name:'conversation.transcribe',description:'读取本任务指定的对方语音，复用统一视觉Action执行器，由Bunny自行选择观察、键鼠、等待与恢复方法并返回实际文字。',
    effect:'read',capabilities:['conversation.read','screen.input'],scope:a=>a,validate:v=>({...subject(v,['sequence']),sequence:Number.isSafeInteger(v.sequence)&&v.sequence>0?v.sequence:0}),execute:async(a,c)=>{await scene.assertTaskIdentity?.(c.task);return require('./wechat-voice').transcribeVoice({execute:async args=>{try{return await execute({...args,action:c.action});}finally{scene.invalidate();}},subject:a,task:c.task,operationId:c.operationId,signal:c.signal,sequence:a.sequence});}});
  tools.register({name:'conversation.send',description:'在视觉确认的指定会话发送一条完整原文，发送前记账、发送后核验气泡；未知结果禁止重发。',
    resultContract:{body:'message是本次授权期望；receipt.desiredText或desiredTextRef保留宿主期望或opaque引用。receipt.observedText仅为实际回读正文，null表示未知；legacy sentText仅在实际正文明确时提供，不以期望兜底。deliveryAssessment保留同轮视觉模型的completed/evidence/原receipt判断，供Task与督导整体评估，可控小偏差不等于必须补发。',
      sourceMark:'除账号明确配置为Bunny自己所有外，统一出口添加或规范化代发来源标记'+require('../shared/external-message').MARK+'；该宿主格式不是模型自行改写正文或输入框残留。按实际wechatOwnership与当前规范判断，不擅自移除来源标记或补发。',
      verification:'verified与deliveryAssessment是本轮截图的综合视觉判断，可作为合理完成依据，并非独立接收回执或不可修订的外部事实；desiredText一致本身不增加任何外部证据。结合visualObservation、evidence与后续实际画面判断反例；草稿仍在、遮挡或结果不清应如实保留，不能以期望补全。普通发送不要求手机或对方额外回执。inputOutcome单独保留原生输入事实，不能用原生目标归属字段代替业务收件人的视觉判断。'},
    effect:'write',capabilities:['conversation.send'],scope:a=>a,continuationPolicy:(task,input)=>require('./effect-review').boundedPolicy(task,input),
    lifecycle:(a,{task,call})=>({...(call.eventKey?{policy:'newer-event',scope:task.id+':'+task.scene+':'+require('./conversation-skill').subjectKey(a),eventKey:call.eventKey}:{policy:'independent'}),
      maxAttempts:2,shouldRetry:error=>['E_GUI_BUSY','E_GUI_BEFORE_DISPATCH'].includes(error.code),recover:({signal})=>new Promise((resolve,reject)=>{
        if(signal.aborted)return reject(Object.assign(Error('动作已停止'),{dispatched:false}));
        const timer=setTimeout(done,500);function done(){clearTimeout(timer);signal.removeEventListener('abort',aborted);resolve();}
        function aborted(){clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(Object.assign(Error('动作已停止'),{dispatched:false}));}
        signal.addEventListener('abort',aborted,{once:true});
      })}),
    validate:v=>({...subject(v,['message']),message:text(v.message,'待发送消息',3500)}),execute:async(a,c)=>{
      await scene.assertTaskIdentity?.(c.task,{signal:c.signal});
      // The shared visual Action owns fresh observation and judgment. Do not
      // parse the whole conversation again before it can even start.
      const r=await execute({...a,operation:'send',signal:c.signal,action:c.action,task:c.task,operationId:c.operationId});scene.invalidate();
      return r.ok?{ok:true,verified:true,receipt:r.receipt||{at:Date.now(),recipient:a.recipient,message:a.message},...(r.visualFeedback?{visualFeedback:r.visualFeedback}:{})}:r;
    }});
  tools.register({name:'memory.related',description:'只返回与本联系人有关且允许对其使用的记忆，带原始来源；不扫描微信聊天数据库。',
    effect:'read',capabilities:['memory.read'],scope:a=>a,validate:v=>({...subject(v,['query']),query:text(v.query||'','检索内容',800,true)}),execute:(a,c)=>memoryRelated(a,c.task)});
  tools.register({name:'owner.dispatch',description:'将已绑定主人通道的新交办送入同一任务解释器；普通联系人不可调用。',
    effect:'write',capabilities:['owner.command'],scope:a=>a,validate:v=>({...subject(v,['text','eventKey']),...(v.text===undefined?{}:{text:text(v.text,'主人交办',6000)}),eventKey:text(v.eventKey,'消息标识',256)}),execute:dispatchOwner});
  if(saveAttachment)tools.register({name:'conversation.save',description:'把本轮已核实的微信原生文件附件另存到本任务接收目录，只返回保存回执。',
    effect:'write',capabilities:['conversation.read','screen.input'],available:t=>t.skill==='conversation.manage',scope:a=>a,
    validate:v=>{
      const target=subject(v,['eventKey','sequence']);
      if(!Number.isSafeInteger(v.sequence)||v.sequence<=0)throw Error('文件消息缺少有效序号');
      return {...target,eventKey:text(v.eventKey,'消息标识',256),sequence:v.sequence};
    },execute:saveAttachment});
  return tools;
}
module.exports={registerConversationTools};
