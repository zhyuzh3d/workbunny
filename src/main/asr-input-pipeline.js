'use strict';

// Recognition filtering shared by the normal listener and an isolated local
// diagnostic session. All business effects are supplied by the caller.
function createAsrInputPipeline({speakerFilter,state, recentEcho,bargeInReady,nameHit,turns,
 trace,onFilter,onPartial=()=>{},onAcceptedPartial=()=>{},onUtteranceConfirmed=()=>{},
 setLastLiveText=()=>{},setSuppressEnrollmentFinal=()=>{},onFeatures=()=>{}}={}){
 if(!speakerFilter||typeof state!=='function'||typeof turns!=='function'||[recentEcho,bargeInReady,nameHit].some(fn=>typeof fn!=='function'))throw TypeError('ASR input pipeline dependencies are required');
 const observe=(callback,...args)=>{
  try{const result=callback?.(...args);if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}
 };
 const filtered=(stage,text,accepted=false)=>{
  observe(trace,{stage,chars:text.length});observe(onFilter,stage,text);
  return {accepted,stage};
 };
 return {
  activity(meta){ return turns().activity(meta); },
  audioFinal(meta){
   const current=state();
   if(speakerFilter.enrollment||current.suppressEnrollmentFinal||!current.alwaysOn||current.asrMode!=='continuous')return false;
   // No text enters here. The existing turn must already contain an accepted
   // native final; all recognized words still use the speaker/echo filters.
   return turns().audioFinal(meta);
  },
  partial(text){
   if(speakerFilter.enrollment){speakerFilter.heard(text);return filtered('partial-drop-enrollment',text);}
   if(state().suppressEnrollmentFinal)return filtered('partial-drop-enrollment',text);
   if(!speakerFilter.acceptsText())return filtered('partial-drop-speaker',text);
   if(recentEcho(text))return filtered('partial-drop-echo',text);
   const current=state();
   if(current.alwaysOn&&current.speaking&&(!bargeInReady(text)||(current.wakeOnly&&!nameHit(text))))return filtered('partial-drop-barge',text);
   onPartial(text);
   if(!state().alwaysOn)return filtered('partial-drop-mode',text);
   onAcceptedPartial(text);
   setLastLiveText(text);
   const result=filtered('partial-accepted',text,true);turns().partial(text);return result;
  },
  voiceFeatures(feature){
   const enrolled=!!speakerFilter.enrollment,verdict=speakerFilter.offer(feature);
   if(!enrolled&&!speakerFilter.enrollment){
    if(speakerFilter.enabled&&!verdict.accepted&&!turns().snapshot()?.finalized){observe(trace,{stage:'turn-reset-speaker'});turns().reset();}
   }
   onFeatures(feature,verdict);return verdict;
  },
  utterance(text){
   if(speakerFilter.enrollment||state().suppressEnrollmentFinal){setSuppressEnrollmentFinal(!!speakerFilter.enrollment);return filtered('utterance-drop-enrollment',text);}
   if(!speakerFilter.acceptsText())return filtered('utterance-drop-speaker',text);
   setLastLiveText('');
   if(!state().alwaysOn)return filtered('utterance-drop-mode',text);
   onUtteranceConfirmed(text);
   if(!recentEcho(text)){const result=filtered('utterance-accepted',text,true);turns().final(text);return result;}
   return filtered('utterance-drop-echo',text);
  },
  final(text){
   if(speakerFilter.enrollment||state().suppressEnrollmentFinal){setSuppressEnrollmentFinal(!!speakerFilter.enrollment);return filtered('final-drop-enrollment',text);}
   if(!state().alwaysOn)return filtered('final-drop-mode',text);
   if(!speakerFilter.acceptsText())return filtered('final-drop-speaker',text);
   if(state().asrMode!=='single')return filtered('final-drop-mode',text);
   if(!recentEcho(text)){const result=filtered('final-accepted',text,true);turns().final(text);return result;}
   return filtered('final-drop-echo',text);
  },
 };
}
module.exports={createAsrInputPipeline};
