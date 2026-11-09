'use strict';
// Information provenance describes acquisition and conversion. It never grants
// authority or proves that an intended action actually happened.
const token=v=>typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,79}$/u.test(v)?v:null;
const sensors=new Map();
function registerSensor(id,descriptor){
 if(!token(id)||sensors.has(id))throw Error('感知器标识无效或重复');
 const normalized=record({...descriptor,sensor:id});if(!normalized)throw Error('感知器定义无效');
 Object.freeze(normalized.transforms);if(normalized.sourceChannels)Object.freeze(normalized.sourceChannels);sensors.set(id,Object.freeze(normalized));return id;
}
function record(value){
 if(!value||!token(value.channel)||!token(value.sensor))return null;
 if(value.schema!==undefined&&value.schema!=='bunny.perception/v1'||!Array.isArray(value.transforms)||value.transforms.length>8||value.transforms.some(t=>!token(t)))return null;
 const transforms=[...value.transforms];
 return {schema:'bunny.perception/v1',channel:value.channel,sensor:value.sensor,
  originalFormat:token(value.originalFormat)||'unknown',format:token(value.format)||'text',transforms,
  level:transforms.some(s=>['inference','summarization'].includes(s))?'inferred':transforms.length?'converted':'direct',
  ...(typeof value.evidenceId==='string'&&/^[\p{L}\p{N}_.:/-]{1,256}$/u.test(value.evidenceId)?{evidenceId:value.evidenceId}:{}),
  ...(token(value.evidenceFormat)?{evidenceFormat:value.evidenceFormat}:{}),
  ...(typeof value.observationId==='string'&&/^[\p{L}\p{N}_.:/-]{1,256}$/u.test(value.observationId)?{observationId:value.observationId}:{}),
  ...(Array.isArray(value.sourceChannels)?{sourceChannels:[...new Set(value.sourceChannels.filter(token))].slice(0,8)}:{})};
}
function fromSensor(id,evidenceId){const sensor=sensors.get(id);if(!sensor)throw Error('感知器尚未登记');return record({...sensor,evidenceId});}
registerSensor('owner.text',{channel:'keyboard',originalFormat:'text',format:'text',transforms:[]});
registerSensor('local.asr',{channel:'microphone',originalFormat:'audio',format:'text',transforms:['asr']});
registerSensor('desktop.observer',{channel:'screen',originalFormat:'image',format:'text',transforms:['ocr','vision'],evidenceFormat:'image'});
registerSensor('desktop.ocr',{channel:'screen',originalFormat:'image',format:'text',transforms:['ocr'],evidenceFormat:'image'});
registerSensor('display.vision',{channel:'screen',originalFormat:'image',format:'text',transforms:['vision'],evidenceFormat:'image'});
registerSensor('wechat.asr',{channel:'wechat.voice',originalFormat:'audio',format:'text',transforms:['asr','ocr','vision'],evidenceFormat:'image',sourceChannels:['wechat.voice','screen']});
const keyboard=()=>fromSensor('owner.text');
const speech=id=>record({...sensors.get('local.asr'),observationId:id});
const screen=id=>fromSensor('desktop.observer',id);
const voiceTranscript=id=>fromSensor('wechat.asr',id);
function fromDetails(details={}){return record(details.perception)||(details.inputSource==='voice'?speech(details.turnId):details.inputSource==='text'?keyboard():null);}
function derived(kind,origin,sources){
 const known=sources.map(s=>record(s.value?.perception)).filter(Boolean);if(!known.length)return null;
 return record({channel:'memory',sensor:token(origin)||'memory.derivation',originalFormat:'structured',format:'text',transforms:[kind==='summary'?'summarization':'inference'],sourceChannels:known.flatMap(p=>p.sourceChannels||[p.channel])});
}
class EvidenceStore extends Map{
 constructor({maxItems=4,maxBytes=24*1024*1024,ttlMs=300000,clock=Date.now}={}){super();Object.assign(this,{maxItems,maxBytes,ttlMs,clock});this.timestamps=new Map();this.bytes=0;}
 cost(value){return (value?.buffer?.length||0)+Buffer.byteLength(value?.preview||'');}
 delete(id){const old=super.get(id);if(super.delete(id)){this.bytes-=this.cost(old);this.timestamps.delete(id);return true;}return false;}
 prune(){for(const [id,time]of this.timestamps)if(this.clock()-time>=this.ttlMs)this.delete(id);}
 get(id){this.prune();return super.get(id);}
 set(id,value){this.prune();this.delete(id);const cost=this.cost(value);if(cost>this.maxBytes)return this;
  while(this.size&&(this.size>=this.maxItems||this.bytes+cost>this.maxBytes))this.delete(this.keys().next().value);
  super.set(id,value);this.timestamps.set(id,this.clock());this.bytes+=cost;return this;
 }
 clear(){super.clear();this.timestamps?.clear();this.bytes=0;}
}
const RULE='perception描述信息的采集渠道、感知器和转换链。converted为OCR/ASR等转换结果，inferred为摘要或推断，都不是直接输入的原文；evidenceId仅是证据引用，不能据此假定原图或音频仍可读取。感知来源不等于可靠度、身份、权限或动作成功。结合情景积极判断，必要时换来源补证，不因经过转换就一律暂停或要求主人重复。';
module.exports={record,fromSensor,registerSensor,catalog:()=>[...sensors.values()].map(v=>({...v,transforms:[...v.transforms],...(v.sourceChannels?{sourceChannels:[...v.sourceChannels]}:{})})),keyboard,speech,screen,voiceTranscript,fromDetails,derived,EvidenceStore,RULE};
