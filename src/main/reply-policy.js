'use strict';

const RULE = '\n本轮为麦克风候选感知。先判断是否需要回应，在同一次既有回复协议中给出最终答复、动作或skip；忽略时对外内容为空，不输出判断过程、决定不回复的说明或过渡句。';

function voiceExperience(perception){return perception?.sensor==='local.asr'&&perception?.channel==='microphone'?require('./voice-input-experience'):null;}
function voiceContext({now=Date.now(),turn,lastOwnerAt=0,lastDialogueAt=0,playback=[],speaking=false,ongoing=[],pendingAudio=[],vocabulary}={}){
 const stamp=value=>Number.isFinite(value)&&value>=0&&value<=now?value:null;
 const end=stamp(turn?.audioEndAtMs),start=stamp(turn?.audioStartAtMs),owner=stamp(lastOwnerAt)||null,dialogue=stamp(lastDialogueAt)||null;
 const previous=owner===null?dialogue:dialogue===null?owner:Math.max(owner,dialogue);
 let vocabularyReference;
 if(vocabulary){
  const {revision,name,aliases,hotwords}=require('./hearing-hotwords').snapshot({buddy:vocabulary.name?{name:vocabulary.name}:{},asr:{wakeAliases:vocabulary.aliases,hotwords:vocabulary.hotwords}});
  vocabularyReference={revision,name,aliases,hotwords};
 }
 return {schema:'bunny.voice-observation/v1',source:'local.asr',observedAt:now,nativeFinal:true,
  ...(vocabularyReference?{vocabulary:vocabularyReference}:{}),
  ...(start!==null&&end!==null&&start<=end?{audioStartAt:start,audioEndAt:end}:{}),
  lastAcceptedOwnerAt:owner,sinceAcceptedOwnerMs:owner===null?null:Math.max(0,(end??now)-owner),
  lastDialogueAt:dialogue,dialogueGapMs:previous===null?null:((start!==null&&(end===null||start<=end)?start:end)??now)-previous,
  duringSpeech:turn?.observation?.duringSpeech??speaking,
  outputAtRequest:speaking?(playback.some(row=>stamp(row.startedAt)!==null&&row.startedAt!==null&&row.endedAt==null)?'playing':'preparing'):'idle',
  playbackTextMatch:turn?.observation?.playbackTextMatch??null,
  configuredNameMatch:typeof turn?.observation?.configuredNameMatch==='boolean'?turn.observation.configuredNameMatch:null,
  recentPlayback:playback.filter(row=>stamp(row.startedAt)!==null&&row.startedAt!==null).slice(-4).map(row=>({text:String(row.text||'').slice(0,1200),startedAt:row.startedAt,endedAt:stamp(row.endedAt)})),
  ongoingResponses:ongoing.slice(-2).map(row=>({inputSource:row.inputSource,phase:row.phase,semanticAccepted:row.semanticAccepted===true,
    inputText:String(row.inputText||'').slice(0,1200),inputAt:stamp(row.inputAt),startedAt:stamp(row.startedAt),
    ...(Number.isSafeInteger(row.turn)?{turn:row.turn}:{}),replyPresented:row.replyPresented===true})),
  pendingAudio:pendingAudio.slice(0,6).map(row=>({text:String(row.text||'').slice(0,1200),phase:row.phase,queuedAt:stamp(row.queuedAt),
    ...(typeof row.messageId==='string'?{messageId:row.messageId}:{}),audioDelivered:false}))};
}

function makeReplyGate(onText) {
  let prefix = '', state = 'pending';
  function push(text) {
    if (state === 'skip') return;
    if (state === 'reply') { onText(text); return; }
    prefix += text;
    const compact = prefix.replace(/\s/g, '').toLowerCase();
    if (!compact) return;
    if (compact.startsWith('<skip>') || compact.startsWith('<skip/>')) { state = 'skip'; prefix = ''; return; }
    if (['<skip>', '<skip/>'].some((token) => token.startsWith(compact))) return;
    state = 'reply'; onText(prefix); prefix = '';
  }
  return { push, flush() { if (state === 'pending' && prefix.trim()) { state = 'reply'; onText(prefix); prefix = ''; } },
    get skipped() { return state === 'skip'; } };
}
module.exports = { RULE, makeReplyGate,voiceExperience,voiceContext };
