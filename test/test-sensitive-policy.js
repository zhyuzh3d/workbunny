'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {sensitiveValues,hasProtectedContent,createSensitivePolicy}=require('../src/main/sensitive-policy');
const fixtureSecret='Example-only-Key-4928';

test('labelled and remembered values are caught even without a password label at the exit',()=>{
 assert(sensitiveValues('请记住我的密码是'+fixtureSecret).includes(fixtureSecret));
 assert(hasProtectedContent('这是你要的：'+fixtureSecret,[fixtureSecret]));
 assert(hasProtectedContent(Buffer.from(fixtureSecret).toString('base64'),[fixtureSecret]));
 assert(hasProtectedContent('password: AnotherFixture7',[]));
 assert(!hasProtectedContent('正常的项目状态报告',[fixtureSecret]));
});

test('the host rejects secret text, other contacts, altered files and uninspectable attachments',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-sensitive-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'private.txt'),bytes=Buffer.from('示例凭据：'+fixtureSecret);fs.writeFileSync(file,bytes,{mode:0o600});
 const attachment={path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const policy=createSensitivePolicy({getValues:async()=>[fixtureSecret]});
 await assert.rejects(policy.check({target:'wechat',recipient:'Alice',ownership:'owner',text:fixtureSecret}),/不能作为/);
 await assert.rejects(policy.check({target:'workbuddy',text:'密码是'+fixtureSecret}),/不能作为/);
 await assert.rejects(policy.check({target:'wechat',recipient:'Alice',ownership:'owner',attachment,taskAuthorized:true,fileHelperVerified:true}),/文件传输助手/);
 await assert.rejects(policy.check({target:'wechat',recipient:'文件传输助手',ownership:'bunny',attachment,taskAuthorized:true,fileHelperVerified:true}),/文件传输助手/);
 await assert.rejects(policy.check({target:'wechat',recipient:'文件传输助手',ownership:'owner',attachment,taskAuthorized:true}),/文件传输助手/);
 assert((await policy.check({target:'wechat',recipient:'文件传输助手',ownership:'owner',attachment,taskAuthorized:true,stage:'prepare'})).requiresFileHelperVerification);
 assert((await policy.check({target:'wechat',recipient:'文件传输助手',ownership:'owner',attachment,taskAuthorized:true,fileHelperVerified:true})).sensitiveAttachment);
 assert((await policy.check({target:'workbuddy',attachment,taskAuthorized:true})).sensitiveAttachment);
 fs.writeFileSync(file,'changed');await assert.rejects(policy.check({target:'workbuddy',attachment,taskAuthorized:true}),/发生变化/);
 const binary=Buffer.from([0x89,0x50,0x4e,0x47,0x00,0xff]),other=path.join(dir,'unknown.png');fs.writeFileSync(other,binary);
 await assert.rejects(policy.check({target:'wechat',recipient:'Alice',attachment:{path:other,sha256:crypto.createHash('sha256').update(binary).digest('hex')}}),/无法核验/);
});

test('sensitive task context cannot bypass the controlled channels using terminal or GUI primitives',()=>{
 const {ToolRegistry}=require('../src/main/agent-tools'),registry=new ToolRegistry();
 for(const name of ['terminal.execute','screen.action'])registry.register({name,description:'fixture',effect:'write',capabilities:[],execute:async()=>({})});
 const task={state:{sensitiveContext:true},capabilities:[],subjects:[{application:'workbuddy'}]};
 assert.throws(()=>registry.check('terminal.execute',{command:'anything'},task),/受控/);
 assert.throws(()=>registry.check('screen.action',{application:'workbuddy',action:'type',text:'one character'},task),/受控/);
});

test('desktop blocks secret text to contacts and prepares a private file for authorized WorkBuddy work',async t=>{
 const {DesktopService}=require('../src/main/desktop-service');const nativeCalls=[];
 const policy=createSensitivePolicy({getValues:async()=>[fixtureSecret]});
 const service=new DesktopService({sensitivePolicy:policy,planner:async()=>({}),native:{request:async op=>{nativeCalls.push(op);return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};}},
  contactDirectory:{resolve:async recipient=>({recipient,aliases:[recipient],confirmed:true})}});
 const wechat=await service.start({target:'wechat',recipient:'Alice',goal:'发送消息',operation:'send',message:fixtureSecret});
 assert.equal(wechat.ok,false);assert.match(wechat.error,/不能作为/);assert.equal(nativeCalls.length,0);
 service.run=async()=>{};
 const work=await service.start({target:'workbuddy',goal:'帮我处理 '+fixtureSecret});assert.equal(work.ok,true,work.error);
 const attachment=service.task.sensitiveAttachment;t.after(()=>require('../src/main/sensitive-policy').removeSensitiveAttachment(attachment).catch(()=>{}));
 assert(attachment);assert(!service.task.outboundText.includes(fixtureSecret));assert(fs.readFileSync(attachment.path,'utf8').includes(fixtureSecret));
 assert.equal(fs.statSync(attachment.path).mode&0o777,0o600);assert.deepEqual(nativeCalls,['permissions']);
});

test('owner-labelled credentials are encrypted, recallable and included only in the owner dialogue context',async t=>{
 const {MemoryService}=require('../src/main/memory-service');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-secret-memory-'));
 const memory=new MemoryService({dir:path.join(dir,'vault'),bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,91),getSettings:()=>({enabled:true,extract:false,scene:'life'})});
 await memory.init();assert(memory.ready,memory.error);t.after(async()=>{await memory.close();fs.rmSync(dir,{recursive:true,force:true});});
 const owner=await memory.addMessage('user','请记住测试账号密码是'+fixtureSecret,{allowSensitive:true});
 const rows=await memory.query('memory',20,{scene:'life'}),saved=rows.find(row=>row.value.sensitive);assert(saved);assert.equal(saved.value.evidenceSourceId,owner.id);
 assert((await memory.sensitiveValues()).includes(fixtureSecret));
 const context=await memory.context('测试账号密码是什么',{allowSensitive:true});assert(JSON.stringify(context).includes(fixtureSecret));
 const background=await memory.context('测试账号密码是什么');assert(!JSON.stringify(background).includes(fixtureSecret));
 const recall=require('../src/main/conversation-recall').createRecallSession(memory,{scene:'life',allowSensitive:true});
 const found=await recall.run(require('../src/main/conversation-recall').FIND,{query:'测试账号密码'});assert(found.results.some(item=>item.id===saved.id));
 await assert.rejects(memory.addMessage('user','密码是ExampleThirdParty9',{characterId:'other'}),/主人对话/);
 await memory.remove(saved.id);assert(!(await memory.sensitiveValues()).includes(fixtureSecret));
});

test('WorkBuddy attachment must be visibly present before the safe prompt is submitted',async t=>{
 const {DesktopService}=require('../src/main/desktop-service');const calls=[];
 const policy=createSensitivePolicy({getValues:async()=>[fixtureSecret]}),prepared=await policy.prepareWorkBuddy('处理测试账号 '+fixtureSecret);
 t.after(()=>require('../src/main/sensitive-policy').removeSensitiveAttachment(prepared.attachment).catch(()=>{}));
 const service=new DesktopService({sensitivePolicy:policy,native:{request:async(op,payload)=>{
  calls.push({op,payload});
  if(op==='workbuddyInspect')return {available:true,homeReady:true,editorCount:1,selectedModel:'deepseek-v4.1-flash',draftEmpty:true};
  if(op==='workbuddyFill')return {filled:true};if(op==='pasteFile')return {performed:true};if(op==='workbuddySend')return {pressed:true,postContextValid:true};
  throw Error('unexpected native call');
 }}});
 service.task={id:'fixture',target:'workbuddy',scene:'life',domain:'life',visibilityFloor:1,outboundText:prepared.text,steps:[],sensitiveAttachment:prepared.attachment};
 service.running=true;service.generation=1;
 service.assertScreenshotCurrent=async()=>{};
 service.capture=async()=>({ocr:[{text:path.basename(prepared.attachment.path),confidence:.99}]});
 assert(await service.tryWorkBuddyHandoff({outboundText:prepared.text},{bundleId:'com.tencent.workbuddy.mac',pid:1,windowId:2},{},1));
 assert.deepEqual(calls.map(call=>call.op),['workbuddyInspect','workbuddyFill','pasteFile','workbuddySend']);
 assert(!JSON.stringify(calls).includes(fixtureSecret));assert.equal(service.task.sensitiveAttachmentState,'delivered');assert(!fs.existsSync(prepared.attachment.path));
});

test('sensitive filehelper delivery prepares a text file but refuses input without independent system evidence',async t=>{
 const {DesktopService}=require('../src/main/desktop-service'),calls=[];
 const service=new DesktopService({planner:async()=>({}),sensitivePolicy:createSensitivePolicy({getValues:async()=>[fixtureSecret]}),
  native:{request:async(op)=>{calls.push(op);return {accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true};}},
  contactDirectory:{resolve:async recipient=>({recipient,aliases:[recipient],confirmed:true})}});
 service.run=async()=>{};
 const result=await service.start({target:'wechat',recipient:'文件传输助手',operation:'send',goal:'给主人发送示例凭据',message:fixtureSecret});assert(result.ok,result.error);
 const file=service.task.attachment;t.after(()=>require('../src/main/sensitive-policy').removeSensitiveAttachment(file).catch(()=>{}));
 assert(file);assert.equal(service.task.requiresFileHelperVerification,true);assert(!service.task.message.includes(fixtureSecret));
 const scope={bundleId:'com.tencent.xinWeChat',pid:2,windowId:3};
 const shot={ocr:[{text:'文件传输助手',confidence:.99,x:.4,y:.02,width:.2,height:.03}]};
 await assert.rejects(service.act({action:'type',purpose:'task',text:service.task.message},scope,shot,service.generation),/文件传输助手/);
 assert.deepEqual(calls,['permissions']);
});
