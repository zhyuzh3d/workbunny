'use strict';
const {fields,text}=require('./agent-contract');
function subject(value,extra=[]){
  fields(value,['application','recipient',...extra],'会话工具');
  if(value.application!=='wechat')throw new Error('当前会话技能尚未支持此应用');
  return {application:value.application,recipient:text(value.recipient,'联系人',100)};
}
function registerConversationTools(tools,{scene,execute,lease,canOperate=async()=>true,memoryRelated=async()=>({items:[]}),dispatchOwner=async()=>{throw new Error('主人通道执行器尚未就绪');}}){
  tools.register({name:'conversation.observe',description:'以外部显示像素观察指定会话，未变化时不识别；返回标题、未读提示、完整可见消息和草稿状态。',
    effect:'read',capabilities:['conversation.read'],scope:a=>a,
    validate:v=>({...subject(v,['sampleId','force','relocate']),force:v.force===true,relocate:v.relocate===true}),execute:async(a,c)=>{await scene.assertTaskIdentity?.(c.task);return scene.observe(a,{force:a.force,relocate:a.relocate,repairProfile:c.task.state?.selfRepair?.profile});}});
  tools.register({name:'conversation.open',description:'仅用视觉和键鼠打开指定会话，核对顶部标题；不输入消息正文。',
    effect:'read',capabilities:['screen.input'],scope:a=>a,validate:v=>subject(v),execute:async(a,c)=>{
      await scene.assertTaskIdentity?.(c.task);await scene.assertHealthy();const r=await execute({...a,operation:'open',signal:c.signal,task:c.task});scene.invalidate();
      if(!r.ok)throw Object.assign(new Error(r.error||'未能打开会话'),{dispatched:false,...(r.code?{code:r.code}:{})});return {ok:true};
    }});
  tools.register({name:'conversation.transcribe',description:'在指定微信会话通过可见菜单将最新对方语音转为文字，等待并核对屏幕上的结果。',
    effect:'read',capabilities:['conversation.read','screen.input'],scope:a=>a,validate:v=>({...subject(v,['requested','sequence']),requested:v.requested===true,sequence:Number.isSafeInteger(v.sequence)&&v.sequence>0?v.sequence:0}),execute:(a,c)=>require('./wechat-voice').transcribeVoice({scene,lease,canOperate,subject:a,task:c.task,signal:c.signal,requested:a.requested,sequence:a.sequence})});
  tools.register({name:'conversation.send',description:'在视觉确认的指定会话发送一条完整原文，发送前记账、发送后核验气泡；未知结果禁止重发。',
    effect:'write',capabilities:['conversation.send'],scope:a=>a,
    lifecycle:(a,{task,call})=>({...(call.key.startsWith('reply:')&&call.eventKey?{policy:'newer-event',scope:task.id+':'+task.scene+':'+require('./conversation-skill').subjectKey(a),eventKey:call.eventKey}:{policy:'independent'}),
      maxAttempts:2,shouldRetry:error=>error.code==='E_GUI_BUSY',recover:({signal})=>new Promise((resolve,reject)=>{
        if(signal.aborted)return reject(Object.assign(Error('动作已停止'),{dispatched:false}));
        const timer=setTimeout(done,500);function done(){clearTimeout(timer);signal.removeEventListener('abort',aborted);resolve();}
        function aborted(){clearTimeout(timer);signal.removeEventListener('abort',aborted);reject(Object.assign(Error('动作已停止'),{dispatched:false}));}
        signal.addEventListener('abort',aborted,{once:true});
      })}),
    validate:v=>({...subject(v,['message']),message:text(v.message,'待发送消息',3500)}),execute:async(a,c)=>{
      await scene.assertTaskIdentity?.(c.task);await scene.assertHealthy();
      const view=await scene.observe(a,{force:c.attempt>1,repairProfile:c.task.state?.selfRepair?.profile});
      if(view.unavailable)return {ok:false,dispatched:false,error:view.reason};
      if(view.headerMatched&&view.draft)return {ok:false,dispatched:false,error:'输入框已有草稿，保留待回复消息等待你处理'};
      const r=await execute({...a,operation:'send',signal:c.signal,action:c.action,task:c.task});scene.invalidate();
      return r.ok?{ok:true,verified:true,receipt:r.receipt||{at:Date.now(),recipient:a.recipient,message:a.message}}:r;
    }});
  tools.register({name:'memory.related',description:'只返回与本联系人有关且允许对其使用的记忆，带原始来源；不扫描微信聊天数据库。',
    effect:'read',capabilities:['memory.read'],scope:a=>a,validate:v=>({...subject(v,['query']),query:text(v.query||'','检索内容',800,true)}),execute:(a,c)=>memoryRelated(a,c.task)});
  tools.register({name:'owner.dispatch',description:'将已绑定主人通道的新交办送入同一任务解释器；普通联系人不可调用。',
    effect:'write',capabilities:['owner.command'],scope:a=>a,validate:v=>({...subject(v,['text','eventKey']),text:text(v.text,'主人交办',6000),eventKey:text(v.eventKey,'消息标识',256)}),execute:dispatchOwner});
  return tools;
}
module.exports={registerConversationTools};
