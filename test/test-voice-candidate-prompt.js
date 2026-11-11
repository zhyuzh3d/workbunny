'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestReply}=require('../src/main/reply-request');
const experience=require('../src/main/voice-input-experience');
const cognitive=require('../src/main/dialogue-cognition');
const {voiceExperience}=require('../src/main/reply-policy');
const {speech,keyboard}=require('../src/main/perception');
const skipped=JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',grade:'unassessed',note:'no established exchange',grasp:'insufficient',pace:'listen'},{stage:'reply',reply:{kind:'skip'}},{stage:'prediction',expect:null}]});
const request=()=>({cognitive:true,allowEmptyVoiceDecision:true,inputExperience:voiceExperience(speech()),timeoutMs:1000,messages:[{role:'system',content:'general role material\n'+cognitive.RULE+'\n'+experience.instructions},{role:'user',content:JSON.stringify({character:'microphone-observation',trust:'unconfirmed-speaker-and-intent',text:'synthetic fragment'})}]});
test('the final protocol reminder preserves source uncertainty and ASR experience in the same successful skip request',async()=>{
 let calls=0;const result=await requestReply({selfRepair:true,request:request(),chat:async options=>{calls++;assert.equal(options.inputExperience,undefined);const last=options.messages.at(-1).content;assert(last.includes(experience.protocolReminder));assert(last.indexOf(experience.protocolReminder)>last.indexOf(cognitive.RULE));assert(!last.includes('本轮主人原文'));return {raw:skipped};}});assert.equal(calls,1);assert.equal(result.reply.skipped,true);assert.equal(result.text,'');
});
test('format repair and core fallback retain ASR source guidance and can choose empty without a further model call',async()=>{
 let calls=0;const result=await requestReply({request:request(),chat:async options=>{calls++;assert(options.messages.some(message=>message.content.includes(experience.protocolReminder)));return {raw:calls<=2?'invalid envelope':'{"kind":"chat","text":""}'};}});assert.equal(calls,3);assert.equal(result.reply.skipped,true);assert.equal(result.text,'');
});
test('ordinary typed requests do not load ASR interpretation guidance or change their protocol',async()=>{
 assert.equal(voiceExperience(keyboard()),null);let calls=0;const r=request();delete r.inputExperience;r.allowEmptyVoiceDecision=false;r.messages=[{role:'system',content:cognitive.RULE},{role:'user',content:'ordinary keyboard request'}];
 const result=await requestReply({request:r,chat:async options=>{calls++;assert(!JSON.stringify(options.messages).includes('microphone-observation'));assert(!JSON.stringify(options.messages).includes(experience.instructions));assert(!options.messages.some(message=>message.content.includes(experience.protocolReminder)));return {raw:skipped};}});assert.equal(calls,1);assert(result.reply.skipped);
});
test('revised guidance reaches the same call for damaged questions while accepting reply, clarification and silence through the existing protocol',async()=>{
 const cases=[['因为你要告诉我晚上吃点什么还简单。',{kind:'chat',text:'ordinary conversation answer',turnDisposition:'replace'}],['那个你说明白月亮白天看见怎么那个。',{kind:'chat',text:'one short clarification',turnDisposition:'replace'}],['嗯嗯。',{kind:'skip'}]];
 for(const [candidate,reply]of cases){let calls=0;const r=request();r.allowTurnDisposition=true;r.messages.at(-1).content=JSON.stringify({character:'microphone-observation',trust:'unconfirmed-speaker-and-intent',text:candidate});
  const output=JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',grade:'unassessed',note:'synthetic input observation',grasp:'insufficient',pace:'listen'},{stage:'reply',reply},{stage:'prediction',expect:null}]});
  const result=await requestReply({request:r,chat:async options=>{calls++;assert.equal(experience.revision,8);assert(options.messages[0].content.includes(experience.instructions));assert(options.messages.at(-1).content.startsWith(r.messages.at(-1).content));assert(options.messages.at(-1).content.includes(experience.protocolReminder));return {raw:output};}});
  assert.equal(calls,1);assert.equal(result.reply.skipped,reply.kind==='skip');if(reply.kind==='chat')assert.equal(result.reply.turnDisposition,reply.turnDisposition);
 }
});
test('the candidate reminder explicitly supports recognition correction and semantic use of dialogue timing',async()=>{
 const r=request();r.messages.at(-1).content=JSON.stringify({character:'microphone-observation',trust:'unconfirmed-speaker-and-intent',voiceContext:{dialogueGapMs:2500},text:'synthetic recognition error'});
 const result=await requestReply({request:r,chat:async options=>{const final=options.messages.at(-1).content;assert(final.includes('ASR可能听错'));assert(final.includes('合理纠正'));assert(final.includes('voiceContext.dialogueGapMs'));assert(final.includes('间隔不能单独决定'));assert(final.includes('不显示气泡、不发声'));return {raw:skipped};}});
 assert.equal(result.reply.skipped,true);
});
test('ASR guidance covers standalone address and revisable history without a minimum text length', () => {
  assert(experience.instructions.includes('单独呼唤'));
  assert(experience.instructions.includes('一个字、一个词'));
  assert(experience.instructions.includes(experience.historyGuidance));
  assert(experience.protocolReminder.includes('把整个输入以及句首当作可能的称呼'));
  assert(experience.instructions.includes('把环境声音误识别成用户说的字或词'));
  assert(experience.protocolReminder.includes('距离用户上一句发言较久'));
  assert(experience.protocolReminder.includes('voiceContext.sinceAcceptedOwnerMs'));
  assert(experience.protocolReminder.includes('不能设置最少字数或固定间隔'));
  assert(experience.protocolReminder.includes('与名字、昵称或别称同音近音的单个词'));
  for (const name of ['芭尼', '把你', '云朵', '小鹿', '米诺']) {
    assert(!experience.instructions.includes(name));
  }
});
test('same-call guidance reflects immediate interruption and leaves unfinished inputs with the scheduler',async()=>{
 const r=request();let calls=0;
 const result=await requestReply({request:r,chat:async options=>{calls++;const system=options.messages[0].content,final=options.messages.at(-1).content;
  assert(system.includes('立即中断当前对话推理'));assert(system.includes('先前未完成输入由调度器保留或恢复'));
  assert(final.includes('立即中断当前推理和语音'));assert(final.includes('keep仅保留协议兼容'));
  for(const stale of ['keep保留前轮推理','让原回答继续','保持原回答进行','沿现有播放队列后接','keep仅用于继续保留旧交付'])assert(!system.includes(stale)&&!final.includes(stale));
  return {raw:skipped};
 }});
 assert.equal(calls,1);assert.equal(result.reply.skipped,true);assert.equal(result.text,'');
});
