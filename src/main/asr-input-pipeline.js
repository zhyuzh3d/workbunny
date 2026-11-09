'use strict';

// Recognition filtering shared by the normal listener and an isolated local
// diagnostic session. All business effects are supplied by the caller.
function createAsrInputPipeline({speakerFilter,state, recentEcho,bargeInReady,nameHit,turns,
 trace,onFilter,onPartial=()=>{},onAcceptedPartial=()=>{},onInterrupt=()=>{},onUtteranceConfirmed=()=>{},
 setLastLiveText=()=>{},setSuppressEnrollmentFinal=()=>{},onFeatures=()=>{},
 now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,bargeHoldMs=300}={}){
 if(!speakerFilter||typeof state!=='function'||typeof turns!=='function'||[recentEcho,bargeInReady,nameHit].some(fn=>typeof fn!=='function'))throw TypeError('ASR input pipeline dependencies are required');
 const observe=(callback,...args)=>{
  try{const result=callback?.(...args);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}
 };
 const filtered=(stage,text,accepted=false)=>{
  observe(trace,{stage,chars:text.length});observe(onFilter,stage,text);
  return {accepted,stage};
 };
 let candidate=null,candidateTimer=null,latestSource=null;
 const key=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const reset=()=>{clearTimer(candidateTimer);candidateTimer=null;candidate=null;};
 const canInterrupt=(text,current)=>bargeInReady(text)&&(!current.wakeOnly||nameHit(text));
 const acceptPartial=(text,meta)=>{
  onPartial(text);
  const current=state();
  if(!current.alwaysOn)return filtered('partial-drop-mode',text);
  if(current.speaking)onInterrupt(text,meta);
  onAcceptedPartial(text,meta);setLastLiveText(text);
  const result=filtered('partial-accepted',text,true);turns().partial(text,meta);return result;
 };
 const pendingPartial=(text,meta,current)=>{
  const normalized=key(text),source=[meta?.recognizer,meta?.sourceGen].join(':');
  let prefix='';if(candidate)for(let i=0;i<Math.min(candidate.anchor.length,normalized.length)&&candidate.anchor[i]===normalized[i];i++)prefix+=normalized[i];
  if(!candidate||candidate.generation!==current.speechGeneration||candidate.source!==source||
     (prefix.length<3&&prefix!==normalized)){
   reset();candidate={text,meta,anchor:normalized,source,generation:current.speechGeneration,since:now()};
  }else{candidate.text=text;candidate.meta=meta;candidate.anchor=prefix;}
  if(!candidateTimer){const pending=candidate;candidateTimer=setTimer(()=>{
   candidateTimer=null;if(candidate!==pending)return;
   const value=candidate;candidate=null;const next=state();
   if(!next.alwaysOn||next.speechGeneration!==value.generation||speakerFilter.enrollment||next.suppressEnrollmentFinal||!speakerFilter.acceptsText())return;
   if(recentEcho(value.text,value.meta)){filtered('partial-drop-echo',value.text);return;}
   if(next.speaking&&!canInterrupt(value.text,next)){filtered('partial-drop-barge',value.text);return;}
   acceptPartial(value.text,value.meta);
  },Math.max(0,bargeHoldMs-(now()-pending.since)));candidateTimer?.unref?.();}
  return filtered('partial-pending-barge',text);
 };
 return {
  reset,
  retract(meta){
   if(!meta||!Number.isSafeInteger(meta.recognizer)||!Number.isSafeInteger(meta.sourceGen))return false;
   const source=[meta.recognizer,meta.sourceGen].join(':');
   if(candidate?.source===source)reset();
   const removed=turns().retract?.(meta)===true;
   if(removed){setLastLiveText('');onPartial('');filtered('partial-retracted','');}
   return removed;
  },
  activity(meta){
   const source=[meta?.recognizer,meta?.sourceGen].join(':');
   if(latestSource!==null&&latestSource!==source)reset();latestSource=source;
   return turns().activity(meta);
  },
  audioFinal(meta){
   const current=state();
   if(speakerFilter.enrollment||current.suppressEnrollmentFinal||!current.alwaysOn||current.asrMode!=='continuous')return false;
   // No text enters here. The existing turn must already contain an accepted
   // native final; all recognized words still use the speaker/echo filters.
   return turns().audioFinal(meta);
  },
  partial(text,meta){
   if(speakerFilter.enrollment){speakerFilter.heard(text);return filtered('partial-drop-enrollment',text);}
   if(state().suppressEnrollmentFinal)return filtered('partial-drop-enrollment',text);
   if(!speakerFilter.acceptsText()){reset();return filtered('partial-drop-speaker',text);}
   if(recentEcho(text,meta)){reset();return filtered('partial-drop-echo',text);}
   const current=state();
   if(current.alwaysOn&&current.speaking){
    if(!canInterrupt(text,current)){reset();return filtered('partial-drop-barge',text);}
    return pendingPartial(text,meta,current);
   }
   reset();return acceptPartial(text,meta);
  },
  voiceFeatures(feature){
   const enrolled=!!speakerFilter.enrollment,verdict=speakerFilter.offer(feature);
   if(!enrolled&&!speakerFilter.enrollment){
    if(speakerFilter.enabled&&!verdict.accepted&&!turns().snapshot()?.finalized){reset();observe(trace,{stage:'turn-reset-speaker'});turns().reset();}
   }
   onFeatures(feature,verdict);return verdict;
  },
  utterance(text,meta){
   reset();
   if(speakerFilter.enrollment||state().suppressEnrollmentFinal){setSuppressEnrollmentFinal(!!speakerFilter.enrollment);return filtered('utterance-drop-enrollment',text);}
   if(!speakerFilter.acceptsText())return filtered('utterance-drop-speaker',text);
   setLastLiveText('');
   if(!state().alwaysOn)return filtered('utterance-drop-mode',text);
   onUtteranceConfirmed(text);
   if(recentEcho(text,meta))return filtered('utterance-drop-echo',text);
   const current=state();
   if(current.speaking&&!canInterrupt(text,current))return filtered('utterance-drop-barge',text);
   if(current.speaking)onInterrupt(text,meta);
   const result=filtered('utterance-accepted',text,true);turns().final(text,meta);return result;
  },
  final(text,meta){
   reset();
   if(speakerFilter.enrollment||state().suppressEnrollmentFinal){setSuppressEnrollmentFinal(!!speakerFilter.enrollment);return filtered('final-drop-enrollment',text);}
   if(!state().alwaysOn)return filtered('final-drop-mode',text);
   if(!speakerFilter.acceptsText())return filtered('final-drop-speaker',text);
   if(state().asrMode!=='single')return filtered('final-drop-mode',text);
   if(recentEcho(text,meta))return filtered('final-drop-echo',text);
   const current=state();
   if(current.speaking&&!canInterrupt(text,current))return filtered('final-drop-barge',text);
   if(current.speaking)onInterrupt(text,meta);
   const result=filtered('final-accepted',text,true);turns().final(text,meta);return result;
  },
 };
}
module.exports={createAsrInputPipeline};
