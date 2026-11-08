'use strict';
// Optional diagnostic metadata only. Never forward native strings, transcript
// content, raw audio, device identities or arbitrary object keys to logs.
const stages=new Set(['tap-vpio','analyzer-input','replay','result','session-start','finish-start','finish-return','results-end','utterance','recycle',
 'raw-partial','raw-utterance','raw-final','partial-accepted','partial-drop-enrollment','partial-drop-speaker','partial-drop-echo','partial-drop-barge','partial-drop-mode',
 'utterance-accepted','utterance-drop-enrollment','utterance-drop-speaker','utterance-drop-mode','utterance-drop-echo','final-accepted','final-drop-enrollment','final-drop-speaker','final-drop-mode','final-drop-echo',
 'turn-partial','turn-final','turn-request','turn-gate-closed','turn-gate-ready','turn-completed','turn-invalidated','turn-remember','turn-reset','turn-unconfirmed','turn-reset-speaker','history-written','history-unconfirmed','request-drop-noise','request-drop-echo','request-drop-wake','request-accepted',
 'voice-admitted','voice-model-start','voice-model-end','voice-model-abort','voice-effects-waiting','voice-effects-allowed','voice-task-admitted']);
const fields=new Set(['at','gen','currentGen','seq','recognizer','pendingFrames','pendingSeconds','frames','rate','channels','measuredChannels','rms','peak','inputFrames','outputFrames','muted','aec','accepted','converted','conversionError','buffers','current','utteranceCount',
 'directBuffers','directFrames','queuedBuffers','queuedFrames','replayedBuffers','replayedFrames','start','end','finalizedThrough','isFinal','textChars','combinedChars','removedSegments','touchesFinalized','confirmed','ok',
 'chars','turn','segments','partialChars','finalized','requested','remembered','skipped',
 'commitReady','waitingAudio','gateClosedMs','reasonCode','elapsedMs','taskAdmitted','activityAgeMs','activitySeq','sourceGen','quietSeconds']);
function sanitizeSpeechTrace(value){
 if(!value||!stages.has(value.stage))return null;
 const result={stage:value.stage};
 for(const [key,item]of Object.entries(value))if(fields.has(key)){
  if(typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))result[key]=item;
  else if(Array.isArray(item)&&item.length<=64&&item.every(n=>typeof n==='number'&&Number.isFinite(n)))result[key]=item.slice();
 }
 return result;
}
module.exports={sanitizeSpeechTrace};
