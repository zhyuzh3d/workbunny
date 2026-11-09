'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectExperience,assembleContext,applyContextAdjustment}=require('../src/main/context-assembler');
const {ConversationBrain}=require('../src/main/conversation-brain');

test('experience selection respects the application and retains relevant complete passages and provenance',()=>{
 const items=[
  {packageId:'wechat',application:'wechat',status:'bundled',instructions:'微信使用外部画面。\n\n'+('保存附件需要核对文件。'.repeat(100))+'\n\n语音消息可尝试转文字，并等待结果。'},
  {packageId:'workbuddy',application:'workbuddy',status:'bundled',instructions:'在工作台处理文档。'}
 ];
 const summary=selectExperience(items,{applications:['wechat'],query:'处理语音消息并转文字',maxTokens:100});
 assert.equal(summary.length,1);assert.equal(summary[0].packageId,'wechat');assert.equal(summary[0].status,'bundled');
 assert(summary[0].instructions.includes('语音消息'));assert(!summary[0].instructions.includes('保存附件'));assert.equal(summary[0].truncated,true);
 const full=selectExperience(items,{applications:['wechat'],mode:'full',maxTokens:5000});
 assert(full[0].instructions.includes('保存附件'));assert.equal(full[0].truncated,undefined);
});
test('current issue relevance is ranked across source sections before item and token limits',()=>{
 const items=Array.from({length:5},(_,i)=>({sourceId:'early-'+i,tags:['software:demo'],status:'bundled',instructions:'# 无关制作资料\n\n'+('页面颜色与文稿排版。'.repeat(70))}));
 items.push({sourceId:'late-relevant',tags:['software:demo'],status:'validated',instructions:'## 输入操作经验\n\n输入区位置来自当前画面。\n\n若刚才已聚焦且画面证据仍有效，不重复点击输入框。'});
 const chosen=selectExperience(items,{applications:['demo'],query:'当前截图聚焦输入框',maxTokens:240,maxItems:2});
 assert.equal(chosen[0].sourceId,'late-relevant');assert(chosen[0].instructions.includes('已聚焦且画面证据仍有效，不重复点击输入框'));
 assert(chosen.every(item=>item.instructions.replace(/^#{1,6}[^\n]*\n*/gmu,'').trim().length>6),'a heading or a leftover character is not a useful passage');
 assert(chosen.reduce((sum,item)=>sum+require('../src/main/context-budget').textTokens(item.instructions),0)<=240);assert(!chosen.some(item=>item.instructions.includes('页面颜色')));
});
test('conversation context uses related experience as data without dropping the actual incoming message',async()=>{
 let input;
 const brain=new ConversationBrain({request:async options=>{input=JSON.parse(options.messages[1].content);return {response:{text:JSON.stringify({decision:'reply',reply:'收到',summary:'已回应',completed:false,progress:{},unknown:[]})}};}});
 await brain.decide({task:{goal:'回复联系人',criteria:'自然回复',policy:'',parameters:{behavior:'reply'},state:{operatingKnowledge:[
  {packageId:'wechat',application:'wechat',status:'bundled',instructions:'针对微信消息回复。'},
  {packageId:'workbuddy',application:'workbuddy',status:'bundled',instructions:'工作台经验。'}]}},subject:{application:'wechat',recipient:'Alice'},conversation:{cursor:{}},incoming:[{text:'你好',kind:'text',incomingVerified:true}]});
 assert.equal(input.incoming[0].text,'你好');assert.deepEqual(input.operatingKnowledge.map(x=>x.packageId),['wechat']);
});

test('context fragments apply bounded choices while keeping the current goal and evidence',async()=>{
 const loaded=[];
 const assembled=await assembleContext({purpose:'task.plan',maxTokens:900,configuration:{core:{include:false},history:{limit:999,detail:'full'},unused:{include:false}},fragments:[
  {id:'core',required:true,load:async()=>({goal:'完成目标',event:'最新消息',evidence:'已确认回执'})},
  {id:'history',maxLimit:3,parameters:{limit:2},load:async p=>{loaded.push(p);return ['甲','乙','丙'].slice(0,p.limit);}},
  {id:'unused',load:async()=>{throw Error('should not be loaded');}}
 ]});
 assert.deepEqual(assembled.values.core,{goal:'完成目标',event:'最新消息',evidence:'已确认回执'});
 assert.equal(loaded[0].limit,3);assert.equal(loaded[0].detail,'full');assert.equal(assembled.metadata.omitted[0].reason,'not_selected');
});

test('optional context planning failures fall back and cancellation still propagates',async()=>{
 const fragments=[{id:'core',required:true,load:async()=>({goal:'继续任务'})},{id:'knowledge',load:async()=>['经验']}];
 const fallback=await assembleContext({fragments,preplan:true,planner:async()=>{throw Error('offline');}});
 assert.equal(fallback.metadata.planning,'local');assert.deepEqual(fallback.values.knowledge,['经验']);
 const planned=await assembleContext({fragments,preplan:true,planner:async()=>({core:{include:false},knowledge:{include:false}})});
 assert.equal(planned.metadata.planning,'model');assert.equal(planned.values.core.goal,'继续任务');assert.equal(planned.values.knowledge,undefined);
 const controller=new AbortController();controller.abort();await assert.rejects(assembleContext({fragments,signal:controller.signal}),{code:'E_ABORTED'});
});

test('self-tuning cannot modify mandatory goal, authorize tools, or exceed bounds',()=>{
 const task={state:{}};
 assert.deepEqual(applyContextAdjustment(task,{fragment:'knowledge',detail:'full',limit:3}),{fragment:'knowledge',parameters:{detail:'full',limit:3}});
 assert.throws(()=>applyContextAdjustment(task,{fragment:'core',include:false}),/只能调整/);
 assert.throws(()=>applyContextAdjustment(task,{fragment:'knowledge',limit:1000}),/参数无效/);
 assert.throws(()=>applyContextAdjustment(task,{fragment:'knowledge',detail:'full'}),/没有变化/);
 assert.deepEqual(task.state.contextTuning,{knowledge:{detail:'full',limit:3}});
});
test('fragment limits are enforced even if a loader ignores tuning, and exhausted optional sources are not loaded',async()=>{
 const assembled=await assembleContext({maxTokens:3000,configuration:{history:{maxTokens:100}},fragments:[
  {id:'core',required:true,load:async()=>({goal:'保留实际目标'})},
  {id:'history',recent:true,load:async()=>['旧内容'.repeat(80),'最新内容']},
 ]});
 assert.deepEqual(assembled.values.history,['最新内容']);
 let reads=0;const full=await assembleContext({maxTokens:512,fragments:[{id:'core',required:true,load:async()=>({goal:'必需事实'.repeat(1000)})},{id:'optional',load:async()=>{reads++;return 'unused';}}]});
 assert(full.metadata.requiredOverBudget);assert.equal(reads,0);assert.equal(full.metadata.omitted[0].reason,'budget');
 const controller=new AbortController();await assert.rejects(assembleContext({signal:controller.signal,fragments:[{id:'core',required:true,load:async()=>{controller.abort();return {goal:'cancelled'};}}]}),{code:'E_ABORTED'});
});
test('tag-scoped innate and learned software guides cannot leak into another execution context',()=>{
 const items=[{sourceId:'wx',tags:['software:wechat'],instructions:'微信专用操作'},{sourceId:'wb',tags:['software:workbuddy'],instructions:'WorkBuddy操作'},{sourceId:'mixed',tags:['software:wechat','software:workbuddy'],instructions:'跨软件操作'},{sourceId:'common',tags:['general:computer'],instructions:'通用框架经验'}];
 assert.deepEqual(selectExperience(items,{applications:['workbuddy']}).map(i=>i.sourceId),['wb','common']);assert.deepEqual(selectExperience(items,{applications:[]}).map(i=>i.sourceId),['common']);assert.deepEqual(selectExperience(items,{applications:['workbuddy','wechat']}).map(i=>i.sourceId),['wx','wb','mixed','common']);
});
