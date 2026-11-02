'use strict';
const crypto=require('node:crypto');
const normalize=text=>{const value=String(text||'').normalize('NFKC').toLowerCase();const compact=value.replace(/[\p{P}\p{White_Space}\p{Cf}]/gu,'');return compact||value.replace(/\s/gu,'');};
const key=message=>crypto.createHash('sha256').update(JSON.stringify([message.direction,message.kind||'text',normalize(message.text),String(message.text||'').normalize('NFKC').match(/[+-]?\d+(?:[.,]\d+)*/gu)||[]])).digest('hex');
function alignment(previous,current){
  if(!previous.length)return {end:0};
  for(let size=Math.min(previous.length,current.length);size>0;size--){
    const tail=previous.slice(-size),ends=[];
    for(let i=0;i+size<=current.length;i++)if(tail.every((k,n)=>k===current[i+n].key))ends.push(i+size);
    if(ends.length>1){if(size===previous.length&&current.length>previous.length&&ends[0]===size)return {end:ends[0]};return {uncertain:true};}if(ends.length===1)return {end:ends[0]};
  }return {uncertain:true};
}
class ConversationCursor{
  constructor(state={}){if(state.ready&&state.schema!=='bunny.conversation/v2')throw Object.assign(new Error('会话观察格式已更新，旧基线需要重新交办'),{code:'E_TASK_AUTH'});this.state={schema:'bunny.conversation/v2',ready:false,sequence:0,baseline:[],recent:[],...structuredClone(state)};}
  observe(messages,{ownerChannel=false}={}){
    const current=messages.map(m=>({...m,key:key(m)}));
    const delta=this.state.ready?alignment(this.state.baseline,current):{baseline:true};
    if(delta.uncertain)return {uncertain:true,messages:[]};
    this.state.baseline=current.map(m=>m.key).slice(-16);this.state.ready=true;
    if(delta.baseline){this.state.recent=current.map(m=>({...m,origin:'visible-history'})).slice(-40);this.boundRecent();return {baseline:true,messages:[]};}
    const fresh=current.slice(delta.end),incoming=[];
    for(const message of fresh){
      this.state.sequence++;
      const observed={...message,sequence:this.state.sequence,origin:'screen'};
      this.state.recent.push(observed);
      if(message.direction==='incoming'||ownerChannel&&message.direction==='outgoing')incoming.push(observed);
    }
    this.boundRecent();
    return {messages:incoming};
  }
  noteSent(text,receipt={}){
    const message={direction:'outgoing',kind:'text',text,time:'',origin:'bunny',receipt,sequence:++this.state.sequence};
    message.key=key(message);this.state.baseline.push(message.key);this.state.baseline=this.state.baseline.slice(-16);
    this.state.recent.push(message);this.boundRecent();
  }
  boundRecent(){this.state.recent=this.state.recent.slice(-60);while(this.state.recent.length>1&&Buffer.byteLength(JSON.stringify(this.state.recent))>24000)this.state.recent.shift();}
  snapshot(){return structuredClone(this.state);}
}
module.exports={ConversationCursor,alignment,normalize};
