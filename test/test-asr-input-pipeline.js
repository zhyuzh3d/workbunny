'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAsrInputPipeline}=require('../src/main/asr-input-pipeline');
function fixture(options={}){
 let clock=1000;const timers=new Set();
 const advance=ms=>{clock+=ms;for(const timer of [...timers])if(timer.at<=clock){timers.delete(timer);timer.fn();}};
 const events=[],privateText=[],ordinary=[],business=[],state={alwaysOn:true,speaking:false,wakeOnly:false,asrMode:'continuous',suppressEnrollmentFinal:false,...options.state};
 const speaker={enrollment:null,enabled:false,acceptsText(){events.push('speaker');return options.speakerAccepted!==false;},heard(){events.push('heard');},offer(){events.push('offer');options.onOffer?.(speaker);return {accepted:options.featureAccepted!==false};},...options.speaker};
 const turns={activity(meta){events.push('activity');return meta;},audioFinal(meta){events.push('audio-final');return meta;},snapshot(){events.push('snapshot');return {finalized:!!options.finalized};},reset(){events.push('reset');},partial(text){events.push('turn-partial');business.push(['partial',text]);},final(text){events.push('turn-final');business.push(['final',text]);}};
 const input=createAsrInputPipeline({speakerFilter:speaker,state:()=>state,turns:()=>turns,
  recentEcho:(text,meta)=>{events.push('echo');options.onEcho?.(text,meta);return typeof options.echo==='function'?options.echo(text,meta):!!options.echo;},bargeInReady:()=>{events.push('barge');return options.bargeReady!==false;},nameHit:()=>{events.push('name');return options.nameHit!==false;},
  trace:meta=>{events.push(meta.stage);ordinary.push(meta);if(options.traceThrow)throw Error('observer failed');return options.traceReject?Promise.reject(Error('observer failed')):undefined;},
  onFilter:(stage,text)=>{privateText.push({stage,text});if(options.filterThrow)throw Error('private observer failed');return options.filterReject?Promise.reject(Error('private observer failed')):undefined;},
  onPartial:text=>{events.push('display');ordinary.push({kind:'partial-length',chars:text.length});options.onPartial?.(state);},
  onAcceptedPartial:()=>{events.push('accepted-partial');},onInterrupt:()=>{events.push('stop-speaking');state.speaking=false;},
  setLastLiveText:text=>{events.push('live:'+text.length);state.lastLiveText=text;},setSuppressEnrollmentFinal:value=>{events.push('suppress:'+value);state.suppressEnrollmentFinal=value;},
  onUtteranceConfirmed:text=>{events.push('confirmed');ordinary.push({kind:'utterance-length',chars:text.length});},onFeatures:()=>events.push('features'),
  now:()=>clock,setTimer:(fn,ms)=>{const timer={fn,at:clock+ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
 return {input,speaker,state,events,privateText,ordinary,business,advance};
}
test('activity is shared unchanged with the turn coordinator and never dispatches text or business callbacks',()=>{
 const f=fixture(),meta={state:'quiet',quietSeconds:1,at:1000,seq:1,recognizer:1,sourceGen:2};assert.equal(f.input.activity(meta),meta);assert.deepEqual(f.events,['activity']);assert.equal(f.business.length,0);assert.equal(f.privateText.length,0);
});
test('empty audio coverage has no text authority and is disabled outside ordinary continuous listening',()=>{
 const meta={sourceGen:3,coveredSeq:12,recognizer:1},f=fixture();assert.equal(f.input.audioFinal(meta),meta);assert.deepEqual(f.events,['audio-final']);assert.equal(f.business.length,0);
 for(const options of [{speaker:{enrollment:{}}},{state:{suppressEnrollmentFinal:true}},{state:{alwaysOn:false}},{state:{asrMode:'single'}}]){
  const denied=fixture(options);assert.equal(denied.input.audioFinal(meta),false);assert.equal(denied.business.length,0);assert(!denied.events.includes('audio-final'));
 }
 const rejected=fixture({speakerAccepted:false});rejected.input.utterance('synthetic other speaker');rejected.input.audioFinal(meta);
 assert.equal(rejected.business.length,0,'coverage cannot turn rejected words into an accepted final');
});
test('playback partial waits for a stable candidate, then rechecks filters before interruption',()=>{
 const h=fixture({state:{speaking:true,wakeOnly:true}}),text='private sample';assert.equal(h.input.partial(text).stage,'partial-pending-barge');
 assert.equal(h.state.speaking,true);assert.equal(h.business.length,0);h.advance(299);assert.equal(h.business.length,0);h.advance(1);
 assert.deepEqual(h.events,['speaker','echo','barge','name','partial-pending-barge','speaker','echo','barge','name','display','stop-speaking','accepted-partial','live:14','partial-accepted','turn-partial']);
 assert.deepEqual(h.business,[['partial',text]]);assert.equal(h.state.lastLiveText,text);
});
test('volatile substitutions and new playback generations cannot interrupt with a stale candidate',()=>{
 const h=fixture({state:{speaking:true,speechGeneration:1}});h.input.partial('first candidate');h.advance(200);h.input.partial('different words');h.advance(100);
 assert.equal(h.state.speaking,true);assert.equal(h.business.length,0);h.state.speechGeneration=2;h.advance(200);assert.equal(h.business.length,0);
 h.input.partial('real owner');h.input.reset();h.advance(400);assert.equal(h.business.length,0);
});
test('source-matched withdrawal cancels a pending interruption while an older withdrawal cannot erase its successor',()=>{
 const h=fixture({state:{speaking:true}}),meta={recognizer:1,sourceGen:3};h.input.partial('provisional words',meta);
 h.input.retract({...meta,sourceGen:1});h.advance(300);assert.equal(h.business.length,1);
 const withdrawn=fixture({state:{speaking:true}});withdrawn.input.partial('provisional words',meta);withdrawn.input.retract(meta);withdrawn.advance(400);
 assert.equal(withdrawn.business.length,0);assert.equal(withdrawn.state.speaking,true);
});
test('stopping or discarding ASR immediately cancels a candidate and quick listening reopen cannot revive retiring input',()=>{
 const {Asr}=require('../src/main/asr');
 for(const action of ['stop','discard']){
  const h=fixture({state:{speaking:true}}),asr=new Asr('/offline');asr.proc={stdin:{write(){}},kill(){}};asr.always=true;
  asr.on('partial',h.input.partial);asr.on('inputReset',h.input.reset);asr.onMessage({t:'partial',v:'pending owner words',gen:1});
  h.state.alwaysOn=false;
  if(action==='stop'){const prior=setTimeout;global.setTimeout=()=>0;try{asr.stop();}finally{global.setTimeout=prior;}}
  else asr.kill({discard:true});
  h.state.alwaysOn=true;asr.onMessage({t:'partial',v:'late retiring words',gen:1});h.advance(400);
  assert.equal(h.business.length,0);assert.equal(h.state.speaking,true);
 }
});
test('a consistent growing prefix interrupts promptly without waiting for the owner to finish',()=>{
 const h=fixture({state:{speaking:true}});h.input.partial('please stop');h.advance(200);h.input.partial('please stop and listen');h.advance(100);
 assert.equal(h.state.speaking,false);assert.deepEqual(h.business,[['partial','please stop and listen']]);
});
test('final and utterance share echo, barge and wake checks and a confirmed owner can interrupt immediately',()=>{
 for(const method of ['utterance','final']){
  const base={speaking:true,asrMode:method==='final'?'single':'continuous'};
  for(const options of [{bargeReady:false},{state:{wakeOnly:true},nameHit:false},{echo:true}]){
   const h=fixture({...options,state:{...base,...options.state}});assert.equal(h.input[method]('owner').accepted,false);assert.equal(h.state.speaking,true);assert.equal(h.business.length,0);
  }
  const h=fixture({state:base});assert.equal(h.input[method]('confirmed owner').accepted,true);assert.equal(h.state.speaking,false);assert.deepEqual(h.business,[['final','confirmed owner']]);
 }
});
test('recognition capture metadata reaches echo checks including delayed finals',()=>{
 const seen=[],meta={recognizer:1,sourceGen:3,audioStartAtMs:100,audioEndAtMs:700},h=fixture({onEcho:(_text,value)=>seen.push(value),state:{asrMode:'single'}});
 h.input.partial('owner',meta);h.input.utterance('owner',meta);h.input.final('owner',meta);assert.deepEqual(seen,[meta,meta,meta]);
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
