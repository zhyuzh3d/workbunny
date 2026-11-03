'use strict';
const crypto=require('node:crypto');
const normalize=text=>{const value=String(text||'').normalize('NFKC').toLowerCase();const compact=value.replace(/[\p{P}\p{White_Space}\p{Cf}]/gu,'');return compact||value.replace(/\s/gu,'');};
// Non-text cards have no stable OCR body: file labels/sizes and voice/image
// descriptions vary between observations. Their occurrence/order identifies
// them; visible filenames remain separate evidence for file operations.
const key=message=>{const kind=message.kind||'text',body=kind==='text'?String(message.text||''):'';return crypto.createHash('sha256').update(JSON.stringify([message.direction,kind,normalize(body),body.normalize('NFKC').match(/[+-]?\d+(?:[.,]\d+)*/gu)||[]])).digest('hex');};
function alignment(previous,current){
  if(!previous.length)return {end:0};
  for(let size=Math.min(previous.length,current.length);size>0;size--){
    const tail=previous.slice(-size),ends=[];
    for(let i=0;i+size<=current.length;i++)if(tail.every((k,n)=>k===current[i+n].key))ends.push(i+size);
    if(ends.length>1){if(size===previous.length&&current.length>previous.length&&ends[0]===size)return {end:ends[0],size};return {uncertain:true};}if(ends.length===1)return {end:ends[0],size};
  }return {uncertain:true};
}
class ConversationCursor{
  constructor(state={}){if(state.ready&&state.schema!=='bunny.conversation/v3')throw Object.assign(new Error('会话观察格式已更新，旧基线需要重新交办'),{code:'E_TASK_AUTH'});this.state={schema:'bunny.conversation/v3',ready:false,sequence:0,baseline:[],recent:[],...structuredClone(state)};}
  observe(messages,{ownerChannel=false,sentMessages=[]}={}){
    const current=messages.map(m=>({...m,key:key(m)}));
    const delta=this.state.ready?alignment(this.state.baseline,current):{baseline:true};
    if(delta.uncertain)return {uncertain:true,messages:[]};
    this.state.baseline=current.map(m=>m.key).slice(-16);this.state.ready=true;
    if(delta.baseline){this.state.recent=current.map(m=>({...m,origin:'visible-history'})).slice(-40);this.boundRecent();return {baseline:true,messages:[]};}
    const fresh=current.slice(delta.end),incoming=[];
    for(const message of fresh){
      this.state.sequence++;
      this.state.consumedSentIds??=[];const own=message.direction==='outgoing'&&sentMessages.find(s=>!this.state.consumedSentIds.includes(s.id)&&(normalize(s.text)===normalize(message.text)||s.kind==='file'&&message.kind==='file'&&message.fileName&&normalize(s.text).endsWith(normalize(message.fileName))));
      if(own){this.state.consumedSentIds.push(own.id);this.state.consumedSentIds=this.state.consumedSentIds.slice(-100);}
      const observed={...message,sequence:this.state.sequence,origin:own?'bunny':'screen'};
      this.state.recent.push(observed);
      if(!own&&(message.direction==='incoming'||ownerChannel&&message.direction==='outgoing'))incoming.push(observed);
    }
    this.boundRecent();
    return {messages:incoming};
  }
  noteSent(text,receipt={}){
    if(receipt.operationId){this.state.consumedSentIds??=[];this.state.consumedSentIds.push(receipt.operationId);this.state.consumedSentIds=this.state.consumedSentIds.slice(-100);}
    const message={direction:'outgoing',kind:'text',text,time:'',origin:'bunny',receipt,sequence:++this.state.sequence};
    message.key=key(message);this.state.baseline.push(message.key);this.state.baseline=this.state.baseline.slice(-16);
    this.state.recent.push(message);this.boundRecent();
  }
  boundRecent(){this.state.recent=this.state.recent.slice(-60);while(this.state.recent.length>1&&Buffer.byteLength(JSON.stringify(this.state.recent))>24000)this.state.recent.shift();}
  snapshot(){return structuredClone(this.state);}
}
function locateObserved(state,messages,sequence){
  const baseline=state?.baseline||[],recent=(state?.recent||[]).slice(-baseline.length);
  const matched=alignment(baseline,messages.map(m=>({key:key(m)})));
  if(!baseline.length||matched.uncertain||recent.length!==baseline.length||recent.some((m,i)=>m.key!==baseline[i]))return null;
  const index=recent.findIndex(m=>m.sequence===sequence),distance=baseline.length-index;
  if(index<0||distance>matched.size)return null;
  return messages[matched.end-distance]||null;
}
module.exports={ConversationCursor,alignment,normalize,messageKey:key,locateObserved};
