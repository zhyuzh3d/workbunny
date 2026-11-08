'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {workOrder,workMessage}=require('../src/main/work-order');
const {AgentService}=require('../src/main/agent-service');
const {DesktopService}=require('../src/main/desktop-service');
const {createSensitivePolicy,removeSensitiveAttachment}=require('../src/main/sensitive-policy');
const privateText='private-original-dialogue-canary';
const interpreted=()=>({goal:'制作并向主人交付文件',criteria:'整体交付要求',policy:'只修改指定文件，不联网',context:'整理后的后备背景',
 workRequest:{goal:'创建 /fixture/结果.txt，逐字写入 "Hello, 世界!"',context:'采用已确认的 UTF-8 格式',criteria:'回读字节与指定内容完全一致',output:'files'},
 state:{ownerRequest:privateText,ownerContext:'private-earlier-dialogue-canary'},associationMarker:'[workbunny:fixture]'});

test('the shared brief preserves interpreted details and constraints without reading private original fields',()=>{
 const task=interpreted(),before=structuredClone(task);
 Object.defineProperty(task.state,'ownerRequest',{get(){throw Error('original must stay private');}});
 const body=workMessage(task,workOrder(task));
 for(const required of [task.workRequest.goal,task.workRequest.context,task.workRequest.criteria,task.policy,'成果形式：文件',task.associationMarker])assert(body.includes(required),required);
 for(const omitted of [privateText,before.state.ownerContext,task.criteria,'主人本轮原文'])assert(!body.includes(omitted),omitted);
 assert.equal(task.goal,before.goal);assert.deepEqual(task.workRequest,before.workRequest);
});

test('legacy tasks use their interpreted goal rather than original wording as a fallback',()=>{
 const task={goal:'生成本地网页，不要发布',context:'已确认采用浅色背景',criteria:'离线可打开',state:{ownerRequest:privateText}};
 const body=workMessage(task,workOrder(task));assert(body.includes(task.goal));assert(body.includes(task.context));assert(body.includes(task.criteria));assert(!body.includes(privateText));
});

test('a published game brief carries concrete requirements without host or lifecycle boilerplate',()=>{
 const task={goal:'制作并发布花园小游戏',policy:'不登录、不付费，不上传个人资料',
  workRequest:{goal:'制作围住花园的小游戏，提供开始、重试和胜利判定；发布为公开网页并返回实际网址',context:'家长与孩子共同游玩，支持鼠标与触屏',criteria:'检查真实网址可以打开，围住花园后出现胜利反馈',output:'files'},
  delivery:{channel:'speech'},state:{ownerRequest:privateText},associationMarker:'[workbunny:game-fixture]'};
 const brief=workOrder(task),initial=workMessage(task,brief);
 assert(initial.startsWith(task.workRequest.goal));for(const required of [task.workRequest.context,task.workRequest.criteria,task.policy,'成果形式：文件'])assert(initial.includes(required));
 assert.doesNotMatch(initial,/Bunny|通讯软件|执行分工|不是新的授权|已绑定会话|主人本轮原文|制作目标（|必要上下文（/u);
 assert(!initial.includes(privateText));assert(initial.endsWith(task.associationMarker));assert.equal(initial.split(task.associationMarker).length,2);
 for(const options of [{followUp:true},{followUp:false}])assert.equal(workMessage(task,brief,options),initial,'the same brief is not padded differently by lifecycle');
});

test('actual task restrictions and requested literal wording remain intact, including words used by old boilerplate',()=>{
 const task={goal:'在说明中逐字写出“不是新的授权”，角色名使用Bunny',policy:'不得操作通讯软件；只修改本任务文件',criteria:'逐字回读上述说明',associationMarker:'[workbunny:literal-fixture]'};
 const body=workMessage(task,workOrder(task));for(const required of [task.goal,task.policy,task.criteria])assert(body.includes(required));assert(body.endsWith(task.associationMarker));
});

test('a composed work step overrides the overall production goal without losing shared constraints',()=>{
 const task=interpreted(),body=workOrder(task,{goal:'只检查已经生成的结果文件',context:'当前步骤仅回读，不重建文件'});
 assert(body.includes('只检查已经生成的结果文件'));assert(body.includes('当前步骤仅回读，不重建文件'));assert(body.includes(task.policy));assert(!body.includes(task.workRequest.goal));assert(!body.includes(privateText));
});

test('sensitive attachments contain only the interpreted brief, with original dialogue retained privately',async t=>{
 const secret='synthetic-required-credential-42',task=interpreted();task.workRequest.goal='读取授权测试账号，密码：'+secret;
 const service=new DesktopService({native:{request:async()=>({accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true}),cancel:async()=>{},close:async()=>{}},planner:async()=>({}),persist:async()=>{},sensitivePolicy:createSensitivePolicy({getValues:async()=>[secret]})});
 service.run=async()=>{};t.after(()=>service.close());
 const result=await service.start({target:'workbuddy',origin:'agent',goal:workOrder(task),criteria:task.workRequest.criteria,userRequest:privateText,historicalContext:task.state.ownerContext});assert.equal(result.ok,true,result.error);
 const attachment=service.task.sensitiveAttachment;assert(attachment);t.after(()=>removeSensitiveAttachment(attachment).catch(()=>{}));
 const bytes=fs.readFileSync(attachment.path,'utf8');assert(bytes.includes(secret));assert(bytes.includes(task.workRequest.criteria));assert(!bytes.includes(privateText));assert(!bytes.includes(task.state.ownerContext));assert(!service.task.outboundText.includes(secret));assert(!service.task.outboundText.includes('完整原文'));
});

test('owner continuation sends a new interpreted brief in the same bound session while keeping provenance private',async()=>{
 const task={...interpreted(),id:'new-logical',scene:'life',privacyEpoch:1,sources:['new-source'],parameters:{sourceTaskId:'old-logical'}};
 const prior={id:'old-physical',sessionId:'bound-session',handoffSent:true,target:'workbuddy',sources:['old-logical'],goal:'old-normalized-goal',associationMarker:'[workbunny:old-physical]',followUpRound:0,userRequest:'private-old-original'};task.state.priorJob={jobId:prior.id};
 let submitted;const desktop={task:prior,running:false,journal:async()=>{},followUp:async function({text,ownerInitiated}){assert.equal(ownerInitiated,true);submitted=workMessage(this.task,text,{followUp:true});assert.equal(this.task.sessionId,prior.sessionId);return {ok:true};}};
 const context={desktop,runtime:{save:async()=>{}},waitForWorkSubmission:async()=>({ok:true,verified:true})};
 const result=await AgentService.prototype.continueWork.call(context,task,new AbortController().signal);assert(result.ok);assert(submitted.includes(task.workRequest.goal));assert(submitted.includes(task.workRequest.context));assert(submitted.includes(task.workRequest.criteria));assert(submitted.includes(task.policy));assert(!submitted.includes(privateText));assert(!submitted.includes('private-old-original'));assert.equal(desktop.task.userRequest,privateText);assert.equal(task.state.ownerRequest,privateText);
});

test('automatic revision uses the real follow-up generator without attaching old owner dialogue',async()=>{
 let draft='',submitted;const native={cancel:async()=>{},close:async()=>{},request:async(op,args={})=>{
  if(op==='frontmost')return {application:{pid:123,bundleId:'com.tencent.workbuddy.mac'},windows:[{pid:123,windowId:7,layer:0,rect:{x:0,y:0,width:1000,height:700}}]};
  if(op==='workbuddyInspect')return {available:true,conversationReady:true,associationMarkerPresent:true,editorCount:1,selectedModel:'DeepSeek-V4.1-Flash',draftEmpty:!draft,draftMatchesRequest:!!draft&&draft===args.text,sendEnabled:!!draft,sendButtonRect:{x:900,y:620,width:40,height:40}};
  if(op==='workbuddyFill'){draft=args.text;return {filled:true};}
  if(op==='workbuddySend'){submitted=args.text;return {pressed:true};}
  throw Error('unexpected fixture operation '+op);
 }};
 const service=new DesktopService({native,planner:async()=>{throw Error('visual fallback must not run');},persist:async()=>{},observeWorkBuddy:async()=>({sessionId:'bound',taskId:submitted?2:1,messageKey:submitted?'new-message':'old-message',status:'ok',summary:'fixture result'})});
 service.ensureWorkBuddyMonitor=async()=>{};
 const physical=service.task={id:'physical',target:'workbuddy',status:'review',goal:'normalized production goal',criteria:'实际网址可访问',userRequest:privateText,authorizationContext:'private-earlier-dialogue-canary',outboundText:'previous-raw-canary',sources:['logical'],scene:'life',domain:'life',visibilityFloor:1,workModel:'deepseek-v4.1-flash',sessionId:'bound',monitorSessionId:'bound',monitorTaskId:1,monitorMessageKey:'old-message',monitorStatus:'ok',monitorSummary:'fixture result',associationMarker:'[workbunny:physical]',handoffSent:true,followUpRound:0,steps:[]};
 const task={id:'logical',state:{job:{jobId:physical.id}},status:'waiting'};
 const context={desktop:service,runtime:{save:async()=>{},journal:{authorized:async()=>true}},learning:{reviewContext:async()=>({knowledge:[],sourceIds:[],availability:'fixture',isCurrent:async()=>true})},verify:async()=>({verdict:'revise',followUp:'补充实际公开网址，并检查首页可以打开',report:'尚缺公开网址'})};
 try{const result=await AgentService.prototype.workStatus.call(context,physical.id,task,new AbortController().signal);assert.equal(result.completed,false,JSON.stringify(result));assert(submitted,'real follow-up must reach the mock native submit');assert(submitted.includes('补充实际公开网址，并检查首页可以打开'));assert(submitted.includes(physical.criteria));assert(submitted.endsWith(physical.associationMarker));assert.equal(submitted.split(physical.associationMarker).length,2);assert(!submitted.includes('补充要求本身不产生额外授权'));for(const omitted of [privateText,physical.authorizationContext,'previous-raw-canary'])assert(!submitted.includes(omitted));assert.equal(physical.userRequest,privateText);}finally{await service.close();}
});

for(const route of ['direct-update','interpreted-update'])for(const policy of [undefined,'新的约束：不能新增网络请求',''])test(`continuation preserves or explicitly replaces constraints: ${route}, ${policy===undefined?'inherit':policy?'replace':'clear'}`,async()=>{
 const records=new Map(),agent=new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},ready:()=>true,epoch:()=>1,autoSchedule:false,
  journal:{put:async task=>records.set(task.id,structuredClone(task)),list:async()=>[...records.values()],authorized:async()=>true}});
 const actor={role:'owner',verified:true,channel:'dialogue',sources:['owner-source'],scene:'life'};
 try{
  const old=await agent.start({skill:'work.delegate',goal:'制作网页',policy:'原约束：只使用现有文件',subjects:[{application:'workbuddy'}],workRequest:{goal:'制作网页',output:'files'}},actor),prior=agent.runtime.tasks.get(old.id);
  prior.status='completed';prior.state.job={jobId:'old-physical',sessionId:'bound'};await agent.runtime.save(prior);
  const patch={goal:'给网页增加一条说明',workRequest:{goal:'只在既有网页增加一条说明',criteria:'原有交互不变',output:'files'},...(policy===undefined?{}:{policy})},decision={kind:'update',id:prior.id,patch};
  let next;
  if(route==='direct-update'){const result=await agent.dispatch(decision,actor,{ownerRequest:privateText});assert(result.ok,result.error);next=agent.runtime.tasks.get(result.id);}
  else{agent.interpreter.interpret=async()=>decision;const result=await agent.command(privateText,actor);assert(result.ok);await agent.runtime.tick(result.id);next=agent.runtime.tasks.get(result.id);}
  assert.equal(next.skill,'work.delegate');assert.equal(next.policy,policy??prior.policy);const brief=workOrder(next);if(next.policy)assert(brief.includes(next.policy));else assert(!brief.includes(prior.policy));assert(!brief.includes(privateText));
 }finally{await agent.close();}
});
