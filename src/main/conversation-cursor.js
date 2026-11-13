'use strict';
const crypto=require('node:crypto');
const normalize=text=>{const value=String(text||'').normalize('NFKC').toLowerCase();const compact=value.replace(/[\p{P}\p{White_Space}\p{Cf}]/gu,'');return compact||value.replace(/\s/gu,'');};
// Non-text cards have no stable OCR body: file labels/sizes and voice/image
// descriptions vary between observations. Their occurrence/order identifies
// them; visible filenames remain separate evidence for file operations.
const key=message=>{const kind=message.kind||'text',body=kind==='text'?String(message.text||''):'';return crypto.createHash('sha256').update(JSON.stringify([message.direction,kind,normalize(body),body.normalize('NFKC').match(/[+-]?\d+(?:[.,]\d+)*/gu)||[]])).digest('hex');};
const sentMatches=(s,m)=>s.kind!=='file'&&s.messageKey===m.key||normalize(s.text)===normalize(m.text)||s.kind==='file'&&m.kind==='file'&&m.fileName&&normalize(s.text).endsWith(normalize(m.fileName));
function alignment(previous,current){
  if(!previous.length)return {end:0};
  for(let size=Math.min(previous.length,current.length);size>0;size--){
    const tail=previous.slice(-size),ends=[];
    for(let i=0;i+size<=current.length;i++)if(tail.every((k,n)=>k===current[i+n].key))ends.push(i+size);
    if(ends.length>1){
      // A one-item baseline can appear both before and after a replayed old
      // timeline. Only treat it as new consecutive copies when the entire
      // visible run is identical; mixed history is intrinsically ambiguous.
      if(size===previous.length&&current.length>previous.length&&ends[0]===size&&
        (size>1||current.slice(size).every(m=>m.key===previous.at(-1))))return {end:ends[0],size};
      return {uncertain:true};
    }if(ends.length===1)return {end:ends[0],size};
  }return {uncertain:true};
}
function adjudicatedAlignment(context,decision){
  const reject=()=>{throw Object.assign(Error('会话对齐裁决只能引用原观察的有序索引，不得改写正文、角色或认证'),{code:'E_CONVERSATION_ALIGNMENT'});};
  if(!context||!decision||Object.keys(decision).some(k=>!['uncertain','matches','reason'].includes(k))||typeof decision.uncertain!=='boolean'||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1000)reject();
  if(decision.uncertain){if(decision.matches!==undefined&&(!Array.isArray(decision.matches)||decision.matches.length))reject();return {uncertain:true};}
  if(!Array.isArray(decision.matches)||!decision.matches.length||decision.matches.length>16)reject();let before=-1,now=-1;
  for(const pair of decision.matches){
    if(!pair||Object.keys(pair).some(k=>!['previousIndex','currentIndex'].includes(k))||!Number.isInteger(pair.previousIndex)||!Number.isInteger(pair.currentIndex)||pair.previousIndex<=before||pair.currentIndex<=now)reject();
    const a=context.previous[pair.previousIndex],b=context.current[pair.currentIndex];if(!a||!b||a.direction!==b.direction||(a.kind||'text')!==(b.kind||'text'))reject();before=pair.previousIndex;now=pair.currentIndex;
  }
  if(before!==context.previous.length-1)reject();
  return {end:now+1,size:decision.matches.length,adjudicated:true};
}
class ConversationCursor{
  constructor(state={}){if(state.ready&&state.schema!=='bunny.conversation/v3')throw Object.assign(new Error('会话观察格式已更新，旧基线需要重新交办'),{code:'E_TASK_AUTH'});this.state={schema:'bunny.conversation/v3',ready:false,sequence:0,baseline:[],recent:[],...structuredClone(state)};}
  alignmentContext(messages){
    const recent=this.state.recent||[],previous=this.state.baseline.map((k,i)=>this.state.baselineMessages?.[i]?.key===k?this.state.baselineMessages[i]:recent.findLast(m=>m.key===k));
    if(!previous.length||previous.some(m=>!m))return null;
    const view=(m,index)=>({index,direction:m.direction,kind:m.kind||'text',text:m.text||''});return {previous:previous.map(view),current:messages.map(view)};
  }
  observe(messages,{ownerChannel=false,sentMessages=[],alignmentDecision}={}){
    const current=messages.map(m=>({...m,key:key(m)}));
    let delta=this.state.ready?alignment(this.state.baseline,current):{baseline:true};
    if(delta.uncertain&&alignmentDecision&&!ownerChannel)delta=adjudicatedAlignment(this.alignmentContext(messages),alignmentDecision);
    if(delta.uncertain)return {uncertain:true,messages:[]};
    if(!delta.baseline&&delta.size===1){
      const seenOwn=new Set(this.state.recent.filter(m=>m.origin==='bunny'&&m.kind==='text').map(m=>m.key));
      const replayedOwn=current.slice(delta.end).some(m=>m.direction==='outgoing'&&seenOwn.has(m.key)&&
        !sentMessages.some(s=>!this.state.consumedSentIds?.includes(s.id)&&sentMatches(s,m)));
      // A single weak anchor followed by an already-accounted-for Bunny reply
      // can be an old timeline misordered by vision. Keep the old cursor and
      // reobserve; never requeue the whole history as new incoming messages.
      if(replayedOwn)return {uncertain:true,messages:[]};
    }
    this.state.baselineMessages=current.slice(-16).map(({key,direction,kind,text})=>({key,direction,kind,text}));while(this.state.baselineMessages.length>1&&Buffer.byteLength(JSON.stringify(this.state.baselineMessages))>24000)this.state.baselineMessages.shift();
    this.state.baseline=this.state.baselineMessages.map(m=>m.key);this.state.ready=true;
    if(delta.baseline){this.state.recent=current.map(m=>({...m,origin:'visible-history'})).slice(-40);this.boundRecent();return {baseline:true,messages:[]};}
    const fresh=current.slice(delta.end),incoming=[];
    for(const message of fresh){
      this.state.sequence++;
      const pending=this.state.lastDeliveryReceipt?.observedText===null?this.state.lastDeliveryReceipt:null;
      this.state.consumedSentIds??=[];const own=message.direction==='outgoing'&&sentMessages.find(s=>(!this.state.consumedSentIds.includes(s.id)||s.id===pending?.operationId)&&sentMatches(s,message));
      const ownIntent=message.direction==='outgoing'&&!!pending&&pending.intentMessageKey===message.key;
      if(own){this.state.consumedSentIds.push(own.id);this.state.consumedSentIds=this.state.consumedSentIds.slice(-100);}
      const observed={...message,...(own?{text:own.text}:ownIntent&&pending.desiredTextRef?{text:pending.desiredTextRef}:{}),...(delta.adjudicated?{alignment:{source:'task-brain',reason:alignmentDecision.reason}}:{}),sequence:this.state.sequence,origin:own||ownIntent?'bunny':'screen'};
      this.state.recent.push(observed);
      if(!own&&!ownIntent&&(message.direction==='incoming'||ownerChannel&&message.direction==='outgoing'))incoming.push(observed);
    }
    this.boundRecent();
    return {messages:incoming};
  }
  noteSent(text,receipt={}){
    if(receipt.operationId){this.state.consumedSentIds??=[];this.state.consumedSentIds.push(receipt.operationId);this.state.consumedSentIds=this.state.consumedSentIds.slice(-100);}
    if(Object.hasOwn(receipt,'observedText')){
      this.state.lastDeliveryReceipt=structuredClone(receipt);
      if(typeof receipt.observedText!=='string')return;
      text=receipt.observedText;
    }
    const message={direction:'outgoing',kind:'text',text,time:'',origin:'bunny',receipt,sequence:++this.state.sequence};
    message.key=/^[a-f0-9]{64}$/u.test(receipt.messageKey||'')?receipt.messageKey:key(message);this.state.baseline.push(message.key);this.state.baseline=this.state.baseline.slice(-16);
    if(this.state.baselineMessages){this.state.baselineMessages.push({key:message.key,direction:message.direction,kind:message.kind,text:message.text});this.state.baselineMessages=this.state.baselineMessages.slice(-16);}
    this.state.recent.push(message);this.boundRecent();
  }
  boundRecent(){this.state.recent=this.state.recent.slice(-60);while(this.state.recent.length>1&&Buffer.byteLength(JSON.stringify(this.state.recent))>24000)this.state.recent.shift();}
  snapshot(){return structuredClone(this.state);}
}
function locateObserved(state,messages,sequence){
  const recent=state?.recent||[],keys=recent.map(m=>m.key||key(m));
  const matched=alignment(keys,messages.map(m=>({key:key(m)})));
  const index=recent.findIndex(m=>m.sequence===sequence),distance=recent.length-index;
  if(index<0)return null;
  if(keys.length&&!matched.uncertain&&distance<=matched.size)return messages[matched.end-distance]||null;
  // A previously misclassified transcript may be retained immediately after
  // the voice. When a fresh, independently verified observation attaches the
  // identical text to that voice, align without the duplicate text entry.
  if(recent[index]?.kind==='voice'&&recent[index+1]?.kind==='text'){
    const transcript=recent[index+1].text;
    const reduced=keys.filter((_,n)=>n!==index+1),aligned=alignment(reduced,messages.map(m=>({key:key(m)})));
    const remaining=reduced.length-index,candidate=!aligned.uncertain&&remaining<=aligned.size?messages[aligned.end-remaining]:null;
    if(candidate?.kind==='voice'&&candidate.voiceVerified&&candidate.voiceText&&normalize(candidate.voiceText)===normalize(transcript))return candidate;
    // A model may omit unrelated messages between the anchor and the voice.
    // A unique complete text anchor plus the ordered occurrence of voice
    // cards still identifies the same card without guessing by transcript.
    for(let anchor=index-1;anchor>=0;anchor--){
      if((recent[anchor].kind||'text')!=='text'||keys.filter(k=>k===keys[anchor]).length!==1)continue;
      const positions=messages.map((m,n)=>key(m)===keys[anchor]?n:-1).filter(n=>n>=0);
      if(positions.length!==1)continue;
      const occurrence=recent.slice(anchor+1,index+1).filter(m=>m.kind==='voice').length;
      const voices=messages.slice(positions[0]+1).filter(m=>m.kind==='voice');
      const found=voices[occurrence-1];
      if(found?.voiceVerified&&found.voiceText&&normalize(found.voiceText)===normalize(transcript))return found;
    }
  }
  // Media has no stable transcription. Identify the same occurrence between
  // unique surrounding message anchors; OCR/ASR wording is content for Bunny
  // to interpret, not the identity of a voice/file/image card.
  const target=recent[index],kind=target.kind||'text';
  if(kind!=='text'){
    const isTarget=m=>(m.kind||'text')===kind&&m.direction===target.direction;
    for(let before=index-1;before>=0;before--){
      if((recent[before].kind||'text')!=='text'||keys.filter(k=>k===keys[before]).length!==1)continue;
      const positions=messages.map((m,n)=>key(m)===keys[before]?n:-1).filter(n=>n>=0);
      if(positions.length!==1)continue;
      let oldEnd=recent.length,newEnd=messages.length;
      for(let after=index+1;after<recent.length;after++){
        if((recent[after].kind||'text')!=='text'||keys.filter(k=>k===keys[after]).length!==1)continue;
        const following=messages.map((m,n)=>n>positions[0]&&key(m)===keys[after]?n:-1).filter(n=>n>=0);
        if(following.length===1){oldEnd=after;newEnd=following[0];break;}
      }
      const retained=recent.slice(before+1,oldEnd).filter(isTarget),visible=messages.slice(positions[0]+1,newEnd).filter(isTarget);
      const occurrence=recent.slice(before+1,index+1).filter(isTarget).length;
      if(retained.length===visible.length&&occurrence>0)return visible[occurrence-1]||null;
    }
    return null;
  }
  // A single complete text, unique in both the retained history and the fresh
  // view, remains identifiable even when a nearby media card was transcribed
  // differently. Generic voice/file placeholders cannot use this fallback.
  const targetKey=keys[index];
  if((target.kind||'text')!=='text'||keys.filter(k=>k===targetKey).length!==1)return null;
  const matches=messages.filter(m=>key(m)===targetKey);
  return matches.length===1?matches[0]:null;
}
const hasNewInput=event=>(event.messages||[]).some(m=>m.origin!=='bunny'&&
  (m.direction==='incoming'&&m.incomingVerified||event.ownerChannel===true&&m.direction==='outgoing'&&m.observedVerified));
module.exports={ConversationCursor,alignment,adjudicatedAlignment,normalize,messageKey:key,locateObserved,hasNewInput};
