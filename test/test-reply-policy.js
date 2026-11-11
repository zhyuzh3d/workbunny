'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {makeReplyGate}=require('../src/main/reply-policy');
const {makeSentenceSplitter}=require('../src/main/llm');
test('split skip marker never leaks as a response; regular replies pass immediately',()=>{
 for(const pieces of [['<','sk','ip','>'],[' ','< SK','IP /','>']]){const output=[];const gate=makeReplyGate(t=>output.push(t));pieces.forEach(t=>gate.push(t));gate.flush();assert.equal(gate.skipped,true);assert.deepEqual(output,[]);}
 const output=[];const gate=makeReplyGate(t=>output.push(t));gate.push('在呢。');assert.deepEqual(output,['在呢。']);gate.push('你说。');gate.flush();assert.deepEqual(output,['在呢。','你说。']);
});
test('a one-call answer keeps short sentences and the final fragment exactly once',()=>{
 const output=[];const splitter=makeSentenceSplitter(t=>output.push(t));['好','。','我在','呢'].forEach(t=>splitter.push(t));splitter.flush();assert.deepEqual(output,['好。','我在呢']);
});
test('ASR experience is versioned channel-specific guidance and timing/playback remain factual clues',()=>{
 const {voiceExperience,voiceContext}=require('../src/main/reply-policy'),p=require('../src/main/perception');
 assert.equal(voiceExperience(p.keyboard()),null);assert.equal(voiceExperience({sensor:'wechat.asr',channel:'wechat.voice'}),null);const guide=voiceExperience(p.speech());assert.equal(guide.revision,8);assert(guide.instructions.includes('不能单独决定'));
 const context=voiceContext({now:10000,lastOwnerAt:1000,turn:{audioStartAtMs:8000,audioEndAtMs:9000,observation:{playbackTextMatch:true,configuredNameMatch:true}},playback:[{text:'unplayed private',startedAt:null},{text:'played',startedAt:6000,endedAt:7000}]});assert.equal(context.sinceAcceptedOwnerMs,8000);assert.equal(context.playbackTextMatch,true);assert.equal(context.configuredNameMatch,true);assert.deepEqual(context.recentPlayback.map(row=>row.text),['played']);
});
test('dialogue gaps use capture time and the latest accepted side without imposing an intent threshold',()=>{
 const {voiceContext}=require('../src/main/reply-policy');
 const turn={audioStartAtMs:8000,audioEndAtMs:9000};
 assert.equal(voiceContext({now:10000,turn,lastOwnerAt:1000,lastDialogueAt:6000}).dialogueGapMs,2000);
 assert.equal(voiceContext({now:10000,turn,lastOwnerAt:7000,lastDialogueAt:6000}).dialogueGapMs,1000);
 assert.equal(voiceContext({now:10000,turn,lastDialogueAt:8500}).dialogueGapMs,-500,'capture can overlap a prior reply being presented');
 assert.equal(voiceContext({now:10000,turn,lastOwnerAt:12000,lastDialogueAt:NaN}).dialogueGapMs,null,'unknown or future timestamps do not create a gap');
 assert.equal(voiceContext({now:10000,turn:{audioEndAtMs:9000},lastOwnerAt:6000}).dialogueGapMs,3000);
 assert.equal(voiceContext({now:10000,lastOwnerAt:6000}).dialogueGapMs,4000);
 assert.equal(voiceContext({now:10000,turn:{audioStartAtMs:9500,audioEndAtMs:9000},lastOwnerAt:6000}).dialogueGapMs,3000,'invalid capture ordering uses the valid end time');
});
test('voice context distinguishes pending inference and synthesis from real playback without interpreting candidate words',()=>{
 const {voiceContext}=require('../src/main/reply-policy');
 const ongoing=[{inputSource:'microphone-candidate',inputText:'an earlier question',semanticAccepted:false,phase:'interpreting',replyPresented:false,turn:1,inputAt:1000,startedAt:1500}];
 const context=voiceContext({now:5000,turn:{audioEndAtMs:4500},speaking:false,ongoing});assert.equal(context.lastAcceptedOwnerAt,null);assert.equal(context.ongoingResponses.length,1);assert.equal(context.ongoingResponses[0].inputText,'an earlier question');assert.equal(context.ongoingResponses[0].semanticAccepted,false);assert.equal(context.ongoingResponses[0].replyPresented,false);assert.equal(context.outputAtRequest,'idle');
 assert.equal(voiceContext({now:5000,speaking:true,playback:[{startedAt:null,endedAt:null,text:'not played'}]}).outputAtRequest,'preparing');
 assert.equal(voiceContext({now:5000,speaking:true,playback:[{startedAt:4000,endedAt:null,text:'actually played'}]}).outputAtRequest,'playing');
 assert.equal(voiceContext({now:5000,ongoing:Array(5).fill(ongoing[0])}).ongoingResponses.length,2);
});
test('ASR vocabulary is a bounded fresh reference and never mutates caller settings',()=>{
 const {voiceContext}=require('../src/main/reply-policy'),{snapshot}=require('../src/main/hearing-hotwords');
 const settings={buddy:{name:'芭尼'},asr:{wakeAliases:['小芭'],hotwords:['WorkBunny','Workbuddy']}},before=JSON.stringify(settings);
 const value=snapshot(settings),context=voiceContext({now:5000,vocabulary:value});
 assert.deepEqual(context.vocabulary,{revision:value.revision,name:'芭尼',aliases:['小芭'],hotwords:['WorkBunny','Workbuddy']});
 assert.equal(context.vocabulary.effective,undefined,'do not duplicate the effective word array in the request');
 context.vocabulary.hotwords.push('unrelated');assert.equal(JSON.stringify(settings),before);assert.equal(value.hotwords.length,2);
 settings.asr.hotwords=['新术语'];assert.deepEqual(voiceContext({vocabulary:snapshot(settings)}).vocabulary.hotwords,['新术语']);
 assert.equal(voiceContext().vocabulary,undefined);
});
