'use strict';
// Bounded local effects belong to the existing Operation even when an outer
// software tool summarizes (or throws away) a native response. No text, target
// contents, clipboard contents or input history is retained here.
const {AsyncLocalStorage}=require('node:async_hooks');
const current=new AsyncLocalStorage();
function sanitize(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const result={};
 for(const key of ['dispatched','dispatchOutcomeUnknown','clipboardChanged','moved','releaseConfirmed','targetVerified'])if(typeof value[key]==='boolean')result[key]=value[key];
 for(const key of ['reportsSubmitted','reportsAttempted','clipboardChangeCount'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
 if(Array.isArray(value.inputKinds)&&value.inputKinds.length<=8&&value.inputKinds.every(k=>['move','click','scroll','type','key','paste','other'].includes(k)))result.inputKinds=[...new Set(value.inputKinds)];
 if(typeof value.inputKindsComplete==='boolean')result.inputKindsComplete=value.inputKindsComplete;
 if(['not-requested','requested','acknowledged','unknown'].includes(value.pointerCommitState))result.pointerCommitState=value.pointerCommitState;
 if(['cg-event','virtual-hid'].includes(value.backend))result.backend=value.backend;
 if(['local-submitted','unknown','not-dispatched','partial'].includes(value.completion))result.completion=value.completion;
 return Object.keys(result).length?result:undefined;
}
function hasEffects(value){const outcome=sanitize(value);return !!outcome&&(outcome.dispatched===true||outcome.dispatchOutcomeUnknown===true||outcome.clipboardChanged===true||outcome.moved===true||outcome.reportsSubmitted>0||['requested','acknowledged','unknown'].includes(outcome.pointerCommitState)||['unknown','partial'].includes(outcome.completion));}
// Known pointer movement before the prepared click/scroll was requested is
// an actual input effect, but not an activation, edit or business submission.
// A tool must separately attest that its business operation was not dispatched.
function pointerPreparationOnly(value){
 const o=sanitize(value);return !!o&&o.inputKindsComplete===true&&o.inputKinds?.length===1&&o.inputKinds[0]==='move'&&
  o.pointerCommitState==='not-requested'&&o.dispatchOutcomeUnknown===false&&o.clipboardChanged===false&&
  o.completion==='local-submitted'&&o.releaseConfirmed===true;
}
function merge(previous,value){
 const next=sanitize(value);if(!next)return previous;const out={...previous,...next};
 for(const key of ['dispatched','dispatchOutcomeUnknown','clipboardChanged','moved'])if(previous?.[key]===true)out[key]=true;
 for(const key of ['reportsSubmitted','reportsAttempted'])if(previous?.[key]!==undefined||next[key]!==undefined)out[key]=(previous?.[key]||0)+(next[key]||0);
 if(previous?.inputKinds||next.inputKinds)out.inputKinds=[...new Set([...(previous?.inputKinds||[]),...(next.inputKinds||[])])];
 if(previous?.inputKindsComplete===false||next.inputKindsComplete===false||hasEffects(previous)&&previous.inputKindsComplete!==true)out.inputKindsComplete=false;
 const phases=['not-requested','requested','acknowledged','unknown'];
 if(previous?.pointerCommitState||next.pointerCommitState)out.pointerCommitState=phases[Math.max(phases.indexOf(previous?.pointerCommitState),phases.indexOf(next.pointerCommitState))];
 if(previous?.completion==='unknown'||next.completion==='unknown')out.completion='unknown';if(previous?.releaseConfirmed===false)out.releaseConfirmed=false;return out;
}
function collect(operation,execute){return current.run({operationId:operation.id,record:value=>{operation.inputOutcome=merge(operation.inputOutcome,value);}},execute);}
function recorder(){return current.getStore()?.record||(()=>{});}
function operationId(){return current.getStore()?.operationId;}
module.exports={sanitize,hasEffects,pointerPreparationOnly,merge,collect,recorder,operationId};
