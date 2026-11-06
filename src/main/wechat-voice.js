'use strict';
// The adapter supplies a goal and source hints. The shared visual Action
// executor decides the Operations, waiting, inspection and recovery methods.
async function transcribeVoice({execute,subject,task,operationId,signal,sequence}){
 if(signal?.aborted)throw Object.assign(Error('任务已暂停'),{dispatched:false});
 const state=task.state?.conversations?.[require('./conversation-skill').subjectKey(subject)];
 const recent=state?.cursor?.recent||[],index=recent.findIndex(m=>m.sequence===sequence);
 const original=index>=0?recent[index]:task.inbox?.flatMap(e=>e.messages||[]).find(m=>m.sequence===sequence);
 const readRequest={kind:'voice-transcript',direction:'incoming',sequence,
  ...(original?.time?{timeHint:original.time}:{}),...(original?.voiceCenter?{originalPosition:original.voiceCenter}:{}),
  ...(index>=0?{ordinalFromLatestKnownVoice:recent.slice(index).filter(m=>m.kind==='voice'&&m.direction==='incoming').length}:{})};
 const result=await execute({...subject,operation:'read',goal:`取得微信「${subject.recipient}」中本任务指定对方语音的实际文字内容。由你结合当前画面与操作经验自主完成并核查，仅返回原文，不发送消息。`,criteria:'Bunny确认文字实际来自指定语音，没有用旁边消息、猜测或操作回执代替内容。',readRequest,task,operationId,signal});
 if(result.ok&&result.verified&&typeof result.text==='string'&&result.text.trim())return {verified:true,text:result.text,perception:require('./perception').voiceTranscript()};
 if(result.code==='E_WECHAT_CONVERSATION_INPUT')return {blocked:true,reason:result.error};
 return {pending:true,reason:result.error||'原语音读取Action已保留，继续自主观察和恢复'};
}
module.exports={transcribeVoice};
