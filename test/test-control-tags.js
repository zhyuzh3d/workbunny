'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractTags}=require('../src/main/llm');
const {conversationText}=require('../src/main/conversation-text');
const {validateReply}=require('../src/main/reply-format');
const {requestReply}=require('../src/main/reply-request');

test('qualified control selectors stay out of prose while the surrounding response and concrete motion survive',()=>{
 const raw='这一句听完整了。<m>talk:ov_idle_talking</m>\n\n请接着说。<e>happy</e>';
 const tags=extractTags(raw);assert.equal(tags.clean,'这一句听完整了。\n\n请接着说。');
 assert.deepEqual(tags.motions,['ov_idle_talking']);assert.deepEqual(tags.emos,['happy']);
 assert.equal(conversationText(raw),tags.clean);
 assert.equal(validateReply(JSON.stringify({kind:'chat',text:raw})).text,tags.clean);
});
test('invalid or unfinished control values cannot become spoken data or swallow adjacent prose',()=>{
 for(const value of ['not:a:selector','invalid value','{"action":"stop"}','<tool_call>code()</tool_call>']){
  const tags=extractTags('前一句。<m>'+value+'</m>后一句。');
  assert.equal(tags.clean,'前一句。后一句。');assert.deepEqual(tags.motions,[]);
  assert.equal(validateReply(JSON.stringify({kind:'chat',text:'前一句。<m>'+value+'</m>后一句。'})).intent,null);
 }
 assert.deepEqual(extractTags('你好<m>talk:safe_motion，继续聊。'),{clean:'你好，继续聊。',motions:['safe_motion'],emos:[]});
 assert.equal(conversationText('配置字段 talk:ov_idle_talking 是普通说明。'),'配置字段 talk:ov_idle_talking 是普通说明。');
});
test('valid motion IDs, categories, emotions, numbers and hyphens retain their existing behavior',()=>{
 assert.deepEqual(extractTags('收到<m>greet</m><m>gesture_2-a</m><e>relaxed</e>。'),{clean:'收到。',motions:['greet','gesture_2-a'],emos:['relaxed']});
});
test('normalized selectors still pass through catalog availability and permission checks',()=>{
 const {MotionLibrary}=require('../src/main/motion-library');let settings={motions:{disabled:[]}};
 const library=new MotionLibrary({motions:[{key:'safe_motion',slot:'talk',label:'fixture',use:'fixture'}],groups:[{id:'talk',label:'talk'}],getConfig:()=>settings,saveConfig(){}});
 const selector=extractTags('<m>talk:safe_motion</m>').motions[0];assert.equal(library.select(selector).key,'safe_motion');
 settings={motions:{disabled:['safe_motion']}};assert.equal(library.select(selector),null);
 assert.equal(library.select(extractTags('<m>talk:missing_motion</m>').motions[0]),null);
 assert.deepEqual(validateReply(JSON.stringify({kind:'action',intent:{action:'stop'}})).intent,{action:'stop'});
});
test('the reply request delivers clean speech and a separate motion without a protocol retry',async()=>{
 const raw=JSON.stringify({kind:'chat',text:'我听见了。<m>talk:safe_motion</m>请继续。'}),sentences=[];
 const result=await requestReply({chat:async()=>({raw}),maxRepairs:0,request:{provider:'deepseek',messages:[{role:'user',content:'能听见吗'}],onSentence:text=>sentences.push(text)}});
 assert.equal(result.attempts,1);assert.equal(result.text,'我听见了。请继续。');assert.deepEqual(result.motions,['safe_motion']);
 assert.deepEqual(sentences,['我听见了。','请继续。']);assert(!sentences.some(text=>text.includes('talk:')));
});
