'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAsrInputPipeline}=require('../src/main/asr-input-pipeline');
function fixture(options={}){
 const events=[],privateText=[],ordinary=[],business=[],state={alwaysOn:true,speaking:false,wakeOnly:false,asrMode:'continuous',suppressEnrollmentFinal:false,...options.state};
 const speaker={enrollment:null,enabled:false,acceptsText(){events.push('speaker');return options.speakerAccepted!==false;},heard(){events.push('heard');},offer(){events.push('offer');options.onOffer?.(speaker);return {accepted:options.featureAccepted!==false};},...options.speaker};
 const turns={activity(meta){events.push('activity');return meta;},snapshot(){events.push('snapshot');return {finalized:!!options.finalized};},reset(){events.push('reset');},partial(text){events.push('turn-partial');business.push(['partial',text]);},final(text){events.push('turn-final');business.push(['final',text]);}};
 const input=createAsrInputPipeline({speakerFilter:speaker,state:()=>state,turns:()=>turns,
  recentEcho:()=>{events.push('echo');return !!options.echo;},bargeInReady:()=>{events.push('barge');return options.bargeReady!==false;},nameHit:()=>{events.push('name');return options.nameHit!==false;},
  trace:meta=>{events.push(meta.stage);ordinary.push(meta);if(options.traceThrow)throw Error('observer failed');return options.traceReject?Promise.reject(Error('observer failed')):undefined;},
  onFilter:(stage,text)=>{privateText.push({stage,text});if(options.filterThrow)throw Error('private observer failed');return options.filterReject?Promise.reject(Error('private observer failed')):undefined;},
  onPartial:text=>{events.push('display');ordinary.push({kind:'partial-length',chars:text.length});options.onPartial?.(state);},
  onAcceptedPartial:text=>{events.push('accepted-partial');if(text&&state.speaking){events.push('stop-speaking');state.speaking=false;}},
  setLastLiveText:text=>{events.push('live:'+text.length);state.lastLiveText=text;},setSuppressEnrollmentFinal:value=>{events.push('suppress:'+value);state.suppressEnrollmentFinal=value;},
  onUtteranceConfirmed:text=>{events.push('confirmed');ordinary.push({kind:'utterance-length',chars:text.length});},onFeatures:()=>events.push('features')});
 return {input,speaker,state,events,privateText,ordinary,business};
}
test('activity is shared unchanged with the turn coordinator and never dispatches text or business callbacks',()=>{
 const f=fixture(),meta={state:'quiet',quietSeconds:1,at:1000,seq:1,recognizer:1,sourceGen:2};assert.equal(f.input.activity(meta),meta);assert.deepEqual(f.events,['activity']);assert.equal(f.business.length,0);assert.equal(f.privateText.length,0);
});
test('accepted partial preserves speaker, echo, barge, display, interruption and turn order',()=>{
 const h=fixture({state:{speaking:true,wakeOnly:true}}),text='private sample';assert.equal(h.input.partial(text).accepted,true);
 assert.deepEqual(h.events,['speaker','echo','barge','name','display','accepted-partial','stop-speaking','live:14','partial-accepted','turn-partial']);
 assert.deepEqual(h.business,[['partial',text]]);assert.equal(h.state.lastLiveText,text);
});
test('partial enrollment and suppression dominate speaker, echo and mode and only enrollment hears text',()=>{
 const enrolled=fixture({state:{alwaysOn:false,suppressEnrollmentFinal:true},speaker:{enrollment:{}},speakerAccepted:false,echo:true});
 assert.equal(enrolled.input.partial('one').stage,'partial-drop-enrollment');assert.deepEqual(enrolled.events,['heard','partial-drop-enrollment']);
 const suppressed=fixture({state:{suppressEnrollmentFinal:true}});suppressed.input.partial('two');assert.deepEqual(suppressed.events,['partial-drop-enrollment']);assert.equal(suppressed.business.length,0);
});
test('partial drop order and barge short-circuit rules match the normal listener',()=>{
 for(const [options,stage,expected]of [
  [{speakerAccepted:false,echo:true},'partial-drop-speaker',['speaker','partial-drop-speaker']],
  [{echo:true,state:{speaking:true}},'partial-drop-echo',['speaker','echo','partial-drop-echo']],
  [{bargeReady:false,state:{speaking:true,wakeOnly:true}},'partial-drop-barge',['speaker','echo','barge','partial-drop-barge']],
  [{nameHit:false,state:{speaking:true,wakeOnly:true}},'partial-drop-barge',['speaker','echo','barge','name','partial-drop-barge']],
  [{state:{alwaysOn:false,speaking:true}},'partial-drop-mode',['speaker','echo','display','partial-drop-mode']]]){
  const h=fixture(options);assert.equal(h.input.partial('private').stage,stage);assert.deepEqual(h.events,expected);assert.equal(h.business.length,0);assert.deepEqual(h.privateText,[{stage,text:'private'}]);
 }
});
test('partial rechecks listening mode after the existing display callback',()=>{
 const h=fixture({onPartial:state=>{state.alwaysOn=false;}});assert.equal(h.input.partial('private').stage,'partial-drop-mode');assert.equal(h.business.length,0);assert.equal(h.state.lastLiveText,undefined);
});
test('utterance clears live text after speaker acceptance, before mode, and logs confirmation before echo',()=>{
 const off=fixture({state:{alwaysOn:false,lastLiveText:'old'}});assert.equal(off.input.utterance('private').stage,'utterance-drop-mode');assert.deepEqual(off.events,['speaker','live:0','utterance-drop-mode']);assert.equal(off.state.lastLiveText,'');
 const other=fixture({speakerAccepted:false,state:{lastLiveText:'old'}});assert.equal(other.input.utterance('private').stage,'utterance-drop-speaker');assert.equal(other.state.lastLiveText,'old');
 const echo=fixture({echo:true});assert.equal(echo.input.utterance('private').stage,'utterance-drop-echo');assert.deepEqual(echo.events,['speaker','live:0','confirmed','echo','utterance-drop-echo']);
 const accepted=fixture();assert.equal(accepted.input.utterance('private').accepted,true);assert.deepEqual(accepted.business,[['final','private']]);
});
test('enrollment final suppression resets exactly once after enrollment ends in both final paths',()=>{
 for(const method of ['utterance','final']){
  const h=fixture({state:{suppressEnrollmentFinal:true,asrMode:'single'}});assert.equal(h.input[method]('private').stage,method+'-drop-enrollment');assert.equal(h.state.suppressEnrollmentFinal,false);assert.equal(h.input[method]('next').accepted,true);
  const active=fixture({speaker:{enrollment:{}},state:{asrMode:'single'}});active.input[method]('private');assert.equal(active.state.suppressEnrollmentFinal,true);assert.equal(active.business.length,0);
 }
});
test('legacy final keeps mode-before-speaker and single-after-speaker order without clearing live text',()=>{
 const off=fixture({state:{alwaysOn:false},speakerAccepted:false});off.input.final('private');assert.deepEqual(off.events,['final-drop-mode']);
 const continuous=fixture({state:{asrMode:'continuous'}});continuous.input.final('private');assert.deepEqual(continuous.events,['speaker','final-drop-mode']);
 const other=fixture({state:{asrMode:'single'},speakerAccepted:false});assert.equal(other.input.final('private').stage,'final-drop-speaker');
 const echo=fixture({state:{asrMode:'single'},echo:true});assert.equal(echo.input.final('private').stage,'final-drop-echo');
 const single=fixture({state:{asrMode:'single',lastLiveText:'old'}});assert.equal(single.input.final('private').accepted,true);assert.equal(single.state.lastLiveText,'old');assert.deepEqual(single.business,[['final','private']]);
});
test('voice features reset only unfinalized rejected-owner turns outside enrollment and always publish features',()=>{
 const denied=fixture({speaker:{enabled:true},featureAccepted:false});denied.input.voiceFeatures({});assert.deepEqual(denied.events,['offer','snapshot','turn-reset-speaker','reset','features']);
 for(const options of [{speaker:{enabled:true},featureAccepted:false,finalized:true},{speaker:{enabled:false},featureAccepted:false},{speaker:{enabled:true,enrollment:{}},featureAccepted:false},{speaker:{enabled:true},featureAccepted:false,onOffer:speaker=>{speaker.enrollment={};}}]){
  const h=fixture(options);h.input.voiceFeatures({});assert(!h.events.includes('reset'));assert.equal(h.events.at(-1),'features');
 }
});
test('throwing trace and private observers cannot fail open or add business dispatch',()=>{
 const dropped=fixture({speakerAccepted:false,traceThrow:true,filterThrow:true});assert.equal(dropped.input.partial('private').accepted,false);assert.equal(dropped.business.length,0);
 const accepted=fixture({traceThrow:true,filterThrow:true});assert.equal(accepted.input.utterance('private').accepted,true);assert.equal(accepted.business.length,1);
 const features=fixture({speaker:{enabled:true},featureAccepted:false,traceThrow:true});features.input.voiceFeatures({});assert(features.events.includes('reset'));
});
test('asynchronous observation errors are isolated and raw text appears only in injected private callbacks',async()=>{
 const text='private-canary-never-ordinary-log',h=fixture({traceReject:true,filterReject:true,state:{asrMode:'single'}});
 h.input.partial(text);h.input.utterance(text);h.input.final(text);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.business.length,3);assert.equal(h.privateText.length,3);assert(h.privateText.every(row=>row.text===text));assert(!JSON.stringify(h.ordinary).includes(text));
});
