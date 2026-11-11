'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAsrInputPipeline}=require('../src/main/asr-input-pipeline');
function fixture(options={}){
 let clock=1000;const timers=new Set();
 const advance=ms=>{clock+=ms;for(const timer of [...timers])if(timer.at<=clock){timers.delete(timer);timer.fn();}};
 const events=[],privateText=[],ordinary=[],business=[],state={alwaysOn:true,speaking:false,wakeOnly:false,asrMode:'continuous',suppressEnrollmentFinal:false,...options.state};
 const speaker={enrollment:null,enabled:false,acceptsText(){events.push('speaker');return options.speakerAccepted!==false;},heard(){events.push('heard');},offer(){events.push('offer');options.onOffer?.(speaker);return {accepted:options.featureAccepted!==false};},...options.speaker};
 const turns={activity(meta){events.push('activity');return meta;},audioFinal(meta){events.push('audio-final');return meta;},snapshot(){events.push('snapshot');return {finalized:!!options.finalized};},reset(){events.push('reset');},partial(text){events.push('turn-partial');business.push(['partial',text]);},final(text){events.push('turn-final');business.push(['final',text]);}};
 const rawInput=createAsrInputPipeline({speakerFilter:speaker,state:()=>state,turns:()=>turns,
  recentEcho:(text,meta)=>{events.push('echo');options.onEcho?.(text,meta);return typeof options.echo==='function'?options.echo(text,meta):!!options.echo;},bargeInReady:()=>{events.push('barge');return options.bargeReady!==false;},nameHit:()=>{events.push('name');return options.nameHit!==false;},
  trace:meta=>{events.push(meta.stage);ordinary.push(meta);if(options.traceThrow)throw Error('observer failed');return options.traceReject?Promise.reject(Error('observer failed')):undefined;},
  onFilter:(stage,text)=>{privateText.push({stage,text});if(options.filterThrow)throw Error('private observer failed');return options.filterReject?Promise.reject(Error('private observer failed')):undefined;},
  onPartial:text=>{events.push('display');ordinary.push({kind:'partial-length',chars:text.length});options.onPartial?.(state);},
  onAcceptedPartial:()=>{events.push('accepted-partial');if(options.interrupt){events.push('stop-speaking');state.speaking=false;}},
  setLastLiveText:text=>{events.push('live:'+text.length);state.lastLiveText=text;},setSuppressEnrollmentFinal:value=>{events.push('suppress:'+value);state.suppressEnrollmentFinal=value;},
  onUtteranceConfirmed:text=>{events.push('confirmed');ordinary.push({kind:'utterance-length',chars:text.length});},onFeatures:()=>events.push('features'),
  now:()=>clock,setTimer:(fn,ms)=>{const timer={fn,at:clock+ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
 const input={...rawInput,partial:(text,meta)=>rawInput.partial(text,{speechSupported:true,...meta}),utterance:(text,meta)=>rawInput.utterance(text,{speechSupported:true,...meta})};
 return {input,speaker,state,events,privateText,ordinary,business,advance};
}

test('activity and empty final coverage keep their exact transport identity without text effects',()=>{
 const f=fixture(),meta={state:'quiet',quietSeconds:1,at:1000,seq:1,recognizer:1,sourceGen:2};assert.equal(f.input.activity(meta),meta);assert.equal(f.input.audioFinal(meta),meta);assert.equal(f.business.length,0);
 for(const options of [{speaker:{enrollment:{}}},{state:{suppressEnrollmentFinal:true}},{state:{alwaysOn:false}},{state:{asrMode:'single'}}])assert.equal(fixture(options).input.audioFinal(meta),false);
});
test('configured name similarity reaches the voice observation without deciding admission', () => {
 for (const matched of [true, false]) {
  const received = [];
  const input = createAsrInputPipeline({
   speakerFilter: { acceptsText: () => true },
   state: () => ({ alwaysOn: true, asrMode: 'continuous', wakeOnly: false }),
   turns: () => ({ final: (text, meta) => received.push({ text, meta }) }),
   recentEcho: () => false,
   nameHit: () => matched,
  });
  assert.equal(input.utterance('a single word', { speechSupported: true }).accepted, true);
  assert.equal(received[0].meta.voiceObservation.configuredNameMatch, matched);
 }
});
test('short, echo-like and evolving system candidates never interrupt playback in the input pipeline',()=>{
 for(const word of ['you','To','好','晚安'])for(const method of ['partial','utterance','final']){
  const f=fixture({echo:true,bargeReady:false,nameHit:false,state:{speaking:true,wakeOnly:true,asrMode:method==='final'?'single':'continuous'}});
  assert.equal(f.input[method](word).accepted,true);f.advance(1000);assert.equal(f.state.speaking,true);assert.equal(f.business.length,1);assert(!f.events.includes('stop-speaking'));assert(!f.events.includes('barge'));
 }
});
test('playback similarity and exact capture time are observation evidence, not an input veto',()=>{
 const seen=[],meta={speechSupported:true,recognizer:1,sourceGen:3,audioStartAtMs:100,audioEndAtMs:700},f=fixture({echo:true,onEcho:(_text,value)=>seen.push(value),state:{speaking:true,asrMode:'single'}});
 f.input.partial('晚安',meta);f.input.utterance('晚安',meta);f.input.final('晚安',meta);assert.deepEqual(seen,[meta,meta,meta]);assert.equal(f.business.length,3);
});
test('recognized words interrupt synchronously before publishing each new input; known playback does not',()=>{
 for(const method of ['partial','utterance','final']){
  const f=fixture({interrupt:true,state:{speaking:true,asrMode:method==='final'?'single':'continuous'}});
  assert.equal(f.input[method]('请停一下').accepted,true);
  assert.equal(f.state.speaking,false);
  assert(f.events.indexOf('stop-speaking')<f.events.indexOf(method==='partial'?'turn-partial':'turn-final'));
  const echo=fixture({interrupt:true,echo:true,state:{speaking:true,asrMode:method==='final'?'single':'continuous'}});
  echo.input[method]('播放内容');assert.equal(echo.state.speaking,true);assert(!echo.events.includes('stop-speaking'));
 }
});
test('duplicate native final from the same source cannot interrupt a successor response',()=>{
 const f=fixture({interrupt:true,state:{speaking:true}}),meta={recognizer:1,sourceGen:3};
 f.input.utterance('测试一句',meta);assert.equal(f.events.filter(x=>x==='stop-speaking').length,1);
 f.state.speaking=true;f.input.utterance('测试一句',meta);assert.equal(f.state.speaking,true);
 f.input.utterance('测试一句',{...meta,sourceGen:4});assert.equal(f.state.speaking,false);
});
test('ambient transcripts without independent speech evidence never reach cancellation or turn admission',()=>{
 for(const text of ['to','you','嗯','环境中的其他误识别']){
  const f=fixture({interrupt:true,state:{speaking:true}});
  assert.equal(f.input.partial(text,{speechSupported:false}).accepted,false);
  assert.equal(f.input.utterance(text,{speechSupported:false}).accepted,false);
  assert.equal(f.state.speaking,true);assert.equal(f.business.length,0);assert(!f.events.includes('accepted-partial'));
  assert.equal(f.input.partial(text,{speechSupported:true}).accepted,true,'the same words spoken by a person remain valid');
  assert.equal(f.state.speaking,false);assert.equal(f.business.length,1);
 }
});
test('speaker and enrollment permissions still reject candidates before dialogue',()=>{
 for(const method of ['partial','utterance','final']){
  const other=fixture({speakerAccepted:false,state:{asrMode:'single'}});assert.equal(other.input[method]('private').accepted,false);assert.equal(other.business.length,0);
  const enrolled=fixture({speaker:{enrollment:{}},state:{asrMode:'single'}});assert.equal(enrolled.input[method]('private').accepted,false);assert.equal(enrolled.business.length,0);
 }
});
test('enrollment final suppression clears only after enrollment ends in either final path',()=>{
 for(const method of ['utterance','final']){const f=fixture({state:{suppressEnrollmentFinal:true,asrMode:'single'}});assert.equal(f.input[method]('private').accepted,false);assert.equal(f.state.suppressEnrollmentFinal,false);assert.equal(f.input[method]('next').accepted,true);}
});
test('listening mode is rechecked after the display callback and single/continuous finals keep their channel',()=>{
 const off=fixture({onPartial:state=>{state.alwaysOn=false;}});assert.equal(off.input.partial('private').accepted,false);assert.equal(off.business.length,0);
 assert.equal(fixture({state:{asrMode:'continuous'}}).input.final('private').accepted,false);
 assert.equal(fixture({state:{alwaysOn:false}}).input.utterance('private').accepted,false);
});
test('voice features retain the explicit owner-only permission without judging word content',()=>{
 const f=fixture({speaker:{enabled:true},featureAccepted:false});f.input.voiceFeatures({});assert(f.events.includes('reset'));
 const sealed=fixture({speaker:{enabled:true},featureAccepted:false,finalized:true});sealed.input.voiceFeatures({});assert(!sealed.events.includes('reset'));
});
test('ordinary diagnostics contain only counts while private injected observers may receive candidate text',async()=>{
 const text='private-canary-never-ordinary-log',f=fixture({traceReject:true,filterReject:true,state:{asrMode:'single'}});f.input.partial(text);f.input.utterance(text);f.input.final(text);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.business.length,3);assert(!JSON.stringify(f.ordinary).includes(text));assert(f.privateText.every(row=>row.text===text));
});
