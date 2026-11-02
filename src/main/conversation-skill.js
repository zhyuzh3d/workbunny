'use strict';
const crypto=require('node:crypto');
const {ConversationCursor}=require('./conversation-cursor');
const subjectKey=s=>crypto.createHash('sha256').update(s.application+'\0'+s.recipient).digest('hex').slice(0,24);
const BEHAVIORS=new Set(['notify','reply','inquiry','owner']);
function validateConversationParameters(spec){
  const p=spec.parameters;
  if(Object.keys(p).some(k=>!['behavior','openingMessage','minReplySeconds','questions','language'].includes(k)))throw new Error('会话参数仅接受behavior/openingMessage/minReplySeconds/questions/language；主动问清问题用behavior=inquiry并在完成后汇报，不使用reportToOwner');
  if(!BEHAVIORS.has(p.behavior))throw new Error('behavior必须为notify/reply/inquiry/owner；主动交谈用inquiry，等来信再回复用reply');
  if(p.language!==undefined&&(typeof p.language!=='string'||!p.language.trim()||p.language.length>80))throw new Error('交流语言不合法');
  if(p.openingMessage!==undefined&&(typeof p.openingMessage!=='string'||p.openingMessage.length>600))throw new Error('开场消息不合法');
  if(p.minReplySeconds!==undefined&&(!Number.isInteger(p.minReplySeconds)||p.minReplySeconds<10||p.minReplySeconds>300))throw new Error('回复间隔不合法');
  if(p.questions!==undefined&&(!Array.isArray(p.questions)||p.questions.length>12||p.questions.some(q=>typeof q!=='string'||!q.trim()||q.length>300)))throw new Error('询问目标不合法');
  return spec;
}
function conversationSkill({brain,canOperate,ownerBindings=()=>false}){
  return {
    id:'conversation.manage',title:'会话代管',version:1,description:'持续照看指定会话、按上下文回复、主动询问并跟进主人目标，或接收已绑定主人通道的交办。',
    parameters:{behavior:'notify只通知 / reply等来信再回复 / inquiry主动开口问清目标 / owner已绑定主人',questions:'可选问题列表',language:'可选交流语言',openingMessage:'可选指定开场原文',minReplySeconds:'10到300秒，可省略'},
    tools:['conversation.observe','conversation.open','conversation.send','memory.related','owner.dispatch'],
    capabilities:['screen.read','screen.input','conversation.read','conversation.send','memory.read','owner.command'],
    capabilitiesFor:spec=>['screen.read','screen.input','conversation.read','memory.read',
      ...(['reply','inquiry','owner'].includes(spec.parameters.behavior)?['conversation.send']:[]),
      ...(spec.parameters.behavior==='owner'?['owner.command']:[])],
    async validate(spec,actor){
      validateConversationParameters(spec);
      if(!BEHAVIORS.has(spec.parameters.behavior)||spec.subjects.some(s=>!s.recipient))throw new Error('请明确联系人和照看方式');
      if(spec.parameters.behavior==='owner'&&spec.subjects.some(s=>!ownerBindings(s,actor)))throw new Error('该会话尚未绑定为主人入口');

    },
    async run(ctx){
      const {task,event:initialEvent,call,enqueue,checkpoint,report,signal,now}=ctx,behavior=task.parameters.behavior;let event=initialEvent;
      task.state.conversations??={};
      const stateFor=subject=>task.state.conversations[subjectKey(subject)]??=( {subject,cursor:{},introduced:false,progress:{},summary:''} );
      const wait=(note,consumeEvent=true,active=false)=>({status:'waiting',note,consumeEvent,nextCheckAt:now+(active?task.schedule.activeIntervalSeconds:task.schedule.intervalSeconds)*1000,state:task.state});
      const send=async(subject,state,message,key)=>{
        const result=await call({tool:'conversation.send',key,args:{...subject,message}});
        const cursor=new ConversationCursor(state.cursor);cursor.noteSent(message,result.receipt);state.cursor=cursor.snapshot();state.introduced=true;state.lastSentAt=now;
        await checkpoint();return result;
      };
      if(event?.type==='conversation.messages'&&!ctx.observeOnly){
        const sendStarted=Object.values(task.operations).some(op=>op.effect==='write'&&['intent','confirmed'].includes(op.status)&&
          ['reply:','owner-ack:'].some(prefix=>op.key===prefix+event.key));
        if(!sendStarted){
          // Continue cheap observation while a prepared reply waits for the GUI.
          // Merge only before any send starts; the first event keeps its stable key.
          const observation=await this.run({...ctx,event:undefined,observeOnly:true});
          if(observation.status==='needs_attention')return observation;
          const first=task.inbox.find(e=>e.key===event.key),batch=task.inbox.filter(e=>e.type==='conversation.messages'&&e.subjectKey===event.subjectKey);
          const messages=batch.flatMap(e=>e.messages||[]);
          if(first&&behavior!=='owner'&&batch.length>1&&Buffer.byteLength(JSON.stringify(messages))<60000){
            first.messages=messages;delete first.decision;const keys=new Set(batch.slice(1).map(e=>e.key));task.inbox=task.inbox.filter(e=>!keys.has(e.key));await checkpoint();
          }
          event=structuredClone(first||event);
        }
      }
      if(event){
        const subject=task.subjects.find(s=>subjectKey(s)===event.subjectKey);
        if(!subject)throw new Error('收到不属于本任务的会话事件');
        const state=stateFor(subject);
        if(event.type==='task.report'){
          if(!await canOperate())return wait('主人回报已排队，等待电脑空闲',false);
          await send(subject,state,event.text,'report:'+event.key);return wait('已向主人回报任务结果');
        }
        const incoming=event.messages||[];
        if(behavior==='notify'){
          await report(`${subject.recipient} 发来消息：${incoming.map(m=>m.text).join('\n')}`,event.key);
          return task.completion==='first_match'?{status:'completed',note:'已通知主人',state:task.state}:wait('已通知主人');
        }
        if(incoming.some(m=>m.kind!=='text'||!(m.incomingVerified||behavior==='owner'&&m.observedVerified))){
          await report(`${subject.recipient} 有一条需要核对的消息；类型或视觉证据不足，尚未自动回复。`,event.key);
          return wait('保留会话记录，等待下一次观察');
        }
        if(behavior==='owner'){
          if(!ownerBindings(subject,task.authority))throw new Error('主人入口绑定已失效');
          if(!await canOperate())return wait('主人交办已排队，等待执行',false);
          const accepted=await call({tool:'owner.dispatch',key:'owner:'+event.key,args:{...subject,text:incoming.map(m=>m.text).join('\n'),eventKey:event.key}});
          if(accepted.reply)await send(subject,state,accepted.reply,'owner-ack:'+event.key);
          return wait('已处理主人交办');
        }
        const memory=event.decision?{items:[]}:await call({tool:'memory.related',key:'memory:'+event.key+':'+task.counters.wakes,args:{...subject,query:incoming.map(m=>m.text).join(' ').slice(0,800)}});
        const decision=event.decision||await brain.decide({task,subject,conversation:state,incoming,memories:memory.items||[],signal});
        // Persist the decision before waiting or sending, so a busy desktop does
        // not lose a message and retries do not create a different reply.
        event.decision=decision;const queued=task.inbox.find(e=>e.key===event.key);if(queued)queued.decision=decision;await checkpoint();
        if(decision.decision==='ignore'){state.summary=decision.summary||state.summary;state.ignored=(state.ignored||0)+incoming.length;return wait('已按规则忽略广告或无需处理的消息');}
        if(decision.decision==='notify'){
          await report(`${subject.recipient} 的消息需要你处理：${decision.summary}`,event.key);return wait('已向主人汇报需要处理的事项');
        }
        if(!await canOperate())return wait('回复已准备并排队，等待电脑空闲',false);
        const gap=task.parameters.minReplySeconds??10;
        if(state.lastSentAt&&now-state.lastSentAt<gap*1000)return wait('保留待回复消息，稍后发送',false,true);
        await send(subject,state,decision.reply,'reply:'+event.key);
        state.summary=decision.summary;state.progress={...state.progress,...decision.progress};state.unknown=decision.unknown;
        state.completed=decision.completed;
        if(task.completion==='first_match'||task.completion==='goal'&&task.subjects.every(s=>stateFor(s).completed)){
          await report(`${subject.recipient}：${decision.summary}${decision.unknown.length?'；尚未确认：'+decision.unknown.join('、'):''}`,'completed:'+event.key);
          return {status:'completed',note:'本次会话目标已完成',state:task.state};
        }
        return wait('已按上下文回复，继续关注',true,true);
      }
      let observed=false;
      for(const subject of task.subjects){
        const state=stateFor(subject),ownerChannel=behavior==='owner';
        let view=await call({tool:'conversation.observe',key:`observe:${task.counters.wakes}:${subjectKey(subject)}`,args:{...subject,sampleId:task.id,...(state.uncertainCount?{force:true,relocate:true}:{})}});
        if(view.unavailable){return {status:'needs_attention',note:'会话应用异常，已停止相关操作；'+(view.reason||''),state:task.state};}
        const preview=view.headerMatched&&state.cursor.ready?new ConversationCursor(state.cursor).observe(view.messages||[],{ownerChannel}):null;
        const needsLatest=!ctx.observeOnly&&view.latestPending&&state.cursor.ready&&!preview?.messages?.length;
        if(!view.headerMatched||needsLatest){
          const reconcile=now-(state.lastReconcileAt||0)>=300000;
          if(!ctx.observeOnly&&(needsLatest||view.unread||!state.cursor.ready||reconcile)&&await canOperate()){
            await call({tool:'conversation.open',key:`open:${task.counters.wakes}:${subjectKey(subject)}`,args:subject});state.lastReconcileAt=now;
            view=await call({tool:'conversation.observe',key:`opened:${task.counters.wakes}:${subjectKey(subject)}`,args:{...subject,sampleId:task.id,force:true}});
          }
        }
        const followupPending=behavior==='inquiry'&&state.introduced&&(task.state.goalRevision||0)>(state.goalRevision||0);
        const openingPending=behavior==='inquiry'&&(!state.introduced||followupPending);
        if(!view.headerMatched||view.unstable||!view.changed&&state.cursor.ready&&!openingPending)continue;
        observed=true;state.draft=!!view.draft;
        const cursor=new ConversationCursor(state.cursor),delta=cursor.observe(view.messages||[],{ownerChannel});state.cursor=cursor.snapshot();
        if(delta.uncertain){state.uncertainCount=(state.uncertainCount||0)+1;await checkpoint();if(state.uncertainCount>=2){await report(`${subject.recipient} 的消息顺序仍无法确认，已从全屏重新定位并保留原观察基线，没有丢弃或回复待确认消息。`,'ambiguous:'+state.cursor.sequence);return {status:'needs_attention',note:'全屏重新定位后仍无法确认消息先后，保留原基线等待核对',state:task.state};}return wait('消息顺序待确认；下一轮从全屏重新定位，保留原基线');}
        state.uncertainCount=0;
        if(delta.messages.length){
          // Cursor advancement and its new event are persisted in one snapshot.
          await enqueue({key:`conversation:${subjectKey(subject)}:${state.cursor.sequence}`,subjectKey:subjectKey(subject),type:'conversation.messages',messages:delta.messages});
        }else await checkpoint();
        if(openingPending&&state.cursor.ready&&!ctx.observeOnly){
          if(!await canOperate()||view.draft)return wait('等待空闲及空输入框后开始交谈');
          const opening=!followupPending&&task.parameters.openingMessage?{reply:task.parameters.openingMessage}:await brain.decide({task,subject,conversation:state,phase:followupPending?'followup':'opening',signal});
          if(opening.reply)await send(subject,state,opening.reply,(followupPending?'followup:'+task.state.goalRevision+':':'opening:')+subjectKey(subject));
          state.goalRevision=task.state.goalRevision||0;
        }
      }
      return wait(!task.subjects.every(s=>stateFor(s).cursor?.ready)?'正在定位会话并建立观察基线，尚未就绪':observed?'已核对会话，继续等待变化':'画面未变，保持低频观察',true,task.inbox.length>0||behavior==='inquiry');
    }
  };
}
module.exports={conversationSkill,subjectKey,validateConversationParameters};
