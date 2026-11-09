'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Asr,createActivityClock}=require('../src/main/asr');
test('activity projection retains observation and queued delivery age using a per-process minimum offset',()=>{
 let wall=100000,mono=1000;const clock=createActivityClock({wallNow:()=>wall,monoNow:()=>mono}),message={state:'quiet',quietSeconds:1,at:9.9,emittedAt:10,gen:1,seq:1};
 let value=clock(message,3);assert.equal(value.state,'quiet');assert.equal(value.at,99900);assert.equal(value.sourceGen,1);assert.equal(value.recognizer,3);
 wall+=800;mono+=800;value=clock({...message,seq:2,at:10.1,emittedAt:10.2},3);assert.equal(value.state,'unknown');assert.equal(value.quietSeconds,0);assert.equal(value.at,100100);
});
test('future, malformed, old sequence and old source generation cannot manufacture quiet',()=>{
 const clock=createActivityClock({wallNow:()=>100000,monoNow:()=>1000}),base={state:'quiet',quietSeconds:1,at:10,emittedAt:10,gen:2,seq:1};assert.equal(clock(base,1).state,'quiet');
 for(const patch of [{seq:1},{seq:2,gen:1},{seq:3,at:11},{seq:4,quietSeconds:-1},{seq:5,state:'other'},{seq:6,at:NaN},{seq:7,emittedAt:9}])assert.equal(clock({...base,...patch},1).state,'unknown');
});
test('ASR forwards activity without transcript logging and discarded process events cannot reach replacement',t=>{
 const children=[],logs=[],events=[],asr=new Asr('/offline',x=>logs.push(x),()=>{const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){}});children.push(p);return p;});
 asr.on('activity',value=>events.push(value));asr.on('error',()=>{});t.after(()=>asr.kill({discard:true}));
 const send=(p,seq)=>{const now=Number(process.hrtime.bigint())/1e9;p.stdout.write(JSON.stringify({t:'activity',state:'active',quietSeconds:0,at:now,emittedAt:now,seq,gen:1,extra:'private-canary'})+'\n');};
 asr.start({always:true});send(children[0],9);assert.equal(events.length,1);assert.equal(events[0].recognizer,1);asr.kill({discard:true});asr.start({always:true});send(children[0],10);assert.equal(events.length,1);
 send(children[1],1);assert.equal(events.length,2);assert.equal(events[1].recognizer,2);assert.equal(events[1].state,'active');assert(!JSON.stringify(logs).includes('private-canary'));assert(!JSON.stringify(events).includes('private-canary'));
});
test('ASR forwards only bounded native empty-final coverage metadata from its current process',t=>{
 const children=[],events=[],asr=new Asr('/offline',()=>{},()=>{const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){}});children.push(p);return p;});
 asr.on('audioFinal',value=>events.push(value));asr.on('error',()=>{});t.after(()=>asr.kill({discard:true}));asr.start({always:true});
 const send=(p,patch={})=>p.stdout.write(JSON.stringify({t:'audioFinal',gen:3,coveredSeq:12,private:'canary',...patch})+'\n');
 for(const patch of [{gen:-1},{gen:1.5},{coveredSeq:0},{coveredSeq:1.5}])send(children[0],patch);assert.equal(events.length,0);
 send(children[0]);assert.deepEqual(events,[{sourceGen:3,coveredSeq:12,recognizer:1}]);asr.kill({discard:true});asr.start({always:true});
 send(children[0]);assert.equal(events.length,1);send(children[1]);assert.equal(events[1].recognizer,2);assert(!JSON.stringify(events).includes('canary'));
});
