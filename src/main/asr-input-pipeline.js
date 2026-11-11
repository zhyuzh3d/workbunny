'use strict';

// Recognition filtering shared by the normal listener and an isolated local
// diagnostic session. All business effects are supplied by the caller.
function createAsrInputPipeline({speakerFilter,state, recentEcho,turns,nameHit=()=>undefined,
 trace,onFilter,onPartial=()=>{},onAcceptedPartial=()=>{},onUtteranceConfirmed=()=>{},
 setLastLiveText=()=>{},setSuppressEnrollmentFinal=()=>{},onFeatures=()=>{},
 now=Date.now}={}){
 if(!speakerFilter||typeof state!=='function'||typeof turns!=='function'||typeof recentEcho!=='function')throw TypeError('ASR input pipeline dependencies are required');
 const observe=(callback,...args)=>{
  try{const result=callback?.(...args);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}
 };
 const filtered=(stage,text,accepted=false)=>{
  observe(trace,{stage,chars:text.length});observe(onFilter,stage,text);
  return {accepted,stage};
 };
 const reset=()=>{};
 let lastInterruptedFinal=null;
 const observation=(text,meta)=>{
  let playbackTextMatch=null;try{playbackTextMatch=recentEcho(text,meta)===true;}catch{}
  let configuredNameMatch = null;
  try {
   const matched = nameHit(text);
   if (typeof matched === 'boolean') configuredNameMatch = matched;
  } catch {}
  return {...meta,voiceObservation:{observedAt:now(),duringSpeech:state().speaking===true,playbackTextMatch,configuredNameMatch}};
 };
 const interrupt=(text,meta)=>{
  if(text.trim() && meta?.voiceObservation?.playbackTextMatch !== true) onAcceptedPartial(text,meta);
 };
 const interruptFinal=(text,meta)=>{
  const key=Number.isSafeInteger(meta?.recognizer)&&Number.isSafeInteger(meta?.sourceGen)
   ? `${meta.recognizer}:${meta.sourceGen}:${text}` : null;
  if(key && key===lastInterruptedFinal)return;
  interrupt(text,meta);lastInterruptedFinal=key;
 };
 const acceptPartial=(text,meta)=>{
  onPartial(text);
  const current=state();
  if(!current.alwaysOn)return filtered('partial-drop-mode',text);
  // A known playback match is still passed on as perception for the model,
  // but it must not make Bunny interrupt herself. Other recognized words
  // interrupt synchronously, before the turn and its live caption are updated.
  interrupt(text,meta);
  setLastLiveText(text);
  const result=filtered('partial-accepted',text,true);turns().partial(text,meta);return result;
 };
 return {
  reset,
  retract(meta){
   if(!meta||!Number.isSafeInteger(meta.recognizer)||!Number.isSafeInteger(meta.sourceGen))return false;
   const removed=turns().retract?.(meta)===true;
   if(removed){setLastLiveText('');onPartial('');filtered('partial-retracted','');}
   return removed;
  },
  activity(meta){
   return turns().activity(meta);
  },
  audioFinal(meta){
   const current=state();
   if(speakerFilter.enrollment||current.suppressEnrollmentFinal||!current.alwaysOn||current.asrMode!=='continuous')return false;
   // No text enters here. The existing turn must already contain an accepted
   // native final; recognized words retain the explicit speaker permission.
   return turns().audioFinal(meta);
  },
  partial(text,meta){
   if(speakerFilter.enrollment){speakerFilter.heard(text);return filtered('partial-drop-enrollment',text);}
   if(state().suppressEnrollmentFinal)return filtered('partial-drop-enrollment',text);
   if(state().asrMode==='continuous' && meta?.speechSupported !== true)return filtered('partial-drop-nonspeech',text);
   if(!speakerFilter.acceptsText()){reset();return filtered('partial-drop-speaker',text);}
   return acceptPartial(text,observation(text,meta));
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
   if(state().asrMode==='continuous' && meta?.speechSupported !== true)return filtered('utterance-drop-nonspeech',text);
   if(!speakerFilter.acceptsText())return filtered('utterance-drop-speaker',text);
   setLastLiveText('');
   if(!state().alwaysOn)return filtered('utterance-drop-mode',text);
   onUtteranceConfirmed(text);
   const observed=observation(text,meta);interruptFinal(text,observed);
   const result=filtered('utterance-accepted',text,true);turns().final(text,observed);return result;
  },
  final(text,meta){
   reset();
   if(speakerFilter.enrollment||state().suppressEnrollmentFinal){setSuppressEnrollmentFinal(!!speakerFilter.enrollment);return filtered('final-drop-enrollment',text);}
   if(!state().alwaysOn)return filtered('final-drop-mode',text);
   if(!speakerFilter.acceptsText())return filtered('final-drop-speaker',text);
   if(state().asrMode!=='single')return filtered('final-drop-mode',text);
   const observed=observation(text,meta);interruptFinal(text,observed);
   const result=filtered('final-accepted',text,true);turns().final(text,observed);return result;
  },
 };
}
module.exports={createAsrInputPipeline};
