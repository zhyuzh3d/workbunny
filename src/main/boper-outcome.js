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
 if(['cg-event','virtual-hid'].includes(value.backend))result.backend=value.backend;
 if(['local-submitted','unknown','not-dispatched','partial'].includes(value.completion))result.completion=value.completion;
 return Object.keys(result).length?result:undefined;
}
function hasEffects(value){const outcome=sanitize(value);return !!outcome&&(outcome.dispatched===true||outcome.dispatchOutcomeUnknown===true||outcome.clipboardChanged===true||outcome.moved===true||outcome.reportsSubmitted>0||['unknown','partial'].includes(outcome.completion));}
function merge(previous,value){const next=sanitize(value);if(!next)return previous;const out={...previous,...next};for(const key of ['dispatched','dispatchOutcomeUnknown','clipboardChanged','moved'])if(previous?.[key]===true)out[key]=true;for(const key of ['reportsSubmitted','reportsAttempted'])if(previous?.[key]!==undefined||next[key]!==undefined)out[key]=(previous?.[key]||0)+(next[key]||0);if(previous?.completion==='unknown'||next.completion==='unknown')out.completion='unknown';if(previous?.releaseConfirmed===false)out.releaseConfirmed=false;return out;}
function collect(operation,execute){return current.run({operationId:operation.id,record:value=>{operation.inputOutcome=merge(operation.inputOutcome,value);}},execute);}
function recorder(){return current.getStore()?.record||(()=>{});}
function operationId(){return current.getStore()?.operationId;}
module.exports={sanitize,hasEffects,merge,collect,recorder,operationId};
