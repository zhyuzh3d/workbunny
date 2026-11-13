'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { approveInput } = require('../src/main/wechat-conversation-input');
const { DesktopService } = require('../src/main/desktop-service');
const {fixture}=require('./support/visual-fixture.cjs');

const box = (x, y, width, height) => ({ x, y, width, height });
const ocr = (text, x, y, width = .08) => ({ text, ...box(x, y, width, .018), confidence: .99 });
const heading = ocr('Fixture contact', .37, .04);
const task = { recipient: 'Fixture contact', operation: 'send', message: 'Test reply' };
const snapshot = (revision, ...rows) => ({ revision, ocr: [heading, ...rows] });
const review = (kind, region, location) => async kinds => {
  assert(kinds.includes(kind));
  return { kind, box: region, location };
};
const denied = { code: 'E_WECHAT_CONVERSATION_INPUT', dispatched: false };
test('missing or conflicting coarse labels are refined once over the whole list, retaining exact and duplicate guards',async()=>{
 const identity={mode:'visual',sessionId:'synthetic-session'},control=box(.13,.22,.16,.05),action={action:'click',x:.2,y:.25};
 for(const coarse of [[],[ocr(task.recipient,.03,.09)]]){
  const shot={...snapshot(1,...coarse),visualFrameId:'frame',identity};let reads=0;
  const approval=await approveInput({action,task,shot,review:review('contact',control),refineText:async(region,focusRegion)=>{reads++;assert.deepEqual(region,box(0,0,.33,1));assert.deepEqual(focusRegion,control);return {frameId:'frame',identity,region,complete:true,texts:[ocr(task.recipient,.15,.24)]};}});
  assert.equal(reads,1);assert.equal(approval.action.x,.19);assert.equal(shot.ocr.filter(r=>r.text===task.recipient&&r.x<.33).length,1);
 }
 const shot={...snapshot(1),visualFrameId:'frame',identity};let reads=0;
 await assert.rejects(approveInput({action,task,shot,review:review('contact',control),refineText:async region=>{reads++;return {frameId:'frame',identity,region,complete:true,texts:[ocr(task.recipient,.15,.24),ocr(task.recipient,.15,.6)]};}}),e=>e.code==='E_WECHAT_CONVERSATION_INPUT'&&e.diagnostic.candidateCount===2);assert.equal(reads,1);
});
test('incomplete, partial-region, wrong-frame and wrong-identity refinements never approve an input',async()=>{
 const identity={mode:'visual',sessionId:'synthetic-session'};
 for(const change of ['incomplete','partial','frame','identity']){
  const shot={...snapshot(1),visualFrameId:'frame',identity};let reads=0;
  await assert.rejects(approveInput({action:{action:'click',x:.2,y:.25},task,shot,review:review('contact',box(.13,.22,.16,.05)),refineText:async region=>{reads++;return {frameId:change==='frame'?'old-frame':'frame',identity:change==='identity'?{mode:'visual',sessionId:'other'}:identity,region:change==='partial'?box(.13,.22,.16,.05):region,complete:change!=='incomplete',texts:[ocr(task.recipient,.15,.24)]};}}),denied);assert.equal(reads,1);
 }
});
test('control rejection distinguishes missing labels from labels outside the recognized control without recording text',async()=>{
 for(const [rows,count,within]of [[[],0,false],[[ocr('Fixture contact',.15,.24)],1,false]]){
  await assert.rejects(approveInput({action:{action:'click',x:.2,y:.35},task,shot:{revision:1,ocr:rows,visualFrameId:'frame',identity:{mode:'visual'}},review:review('contact',box(.13,.33,.16,.05))}),e=>{
   assert.equal(e.diagnostic.candidateCount,count);assert.equal(e.diagnostic.guardChecks.labelWithinControl,within);assert.equal(e.diagnostic.guardChecks.hasVisualFrame,true);assert(!JSON.stringify(e.diagnostic).includes('Fixture contact'));return e.code==='E_WECHAT_CONVERSATION_INPUT';
  });
 }
});

test('the conversation guard checks the actual UI target and denies links disguised as navigation or submission', async () => {
  const shot = snapshot(1, ocr('Fixture contact', .15, .24), ocr('发送', .65, .5), ocr('发送', .88, .92));
  const open = await approveInput({ action: { action: 'click', x: .2, y: .25 }, task, shot, review: review('contact', box(.13, .22, .16, .05)) });
  assert.equal(open.action.x, .19);
  await assert.rejects(approveInput({ action: { action: 'click', x: .7, y: .51 }, task, shot, review: review('contact', box(.13, .22, .16, .05)) }), denied);
  await assert.rejects(approveInput({ action: { action: 'click', purpose: 'submit', x: .7, y: .51 }, task, shot, review: review('send', box(.63, .48, .15, .06)) }), denied);
  await assert.rejects(approveInput({ action: { action: 'key', key: 'enter', modifiers: [] }, task, shot, review: async () => assert.fail() }), denied);
  await assert.rejects(approveInput({ action: { action: 'click', button: 'right', x: .6, y: .4 }, task, shot, review: async () => assert.fail() }), denied);
  const reply = await approveInput({ action: { action: 'type', purpose: 'task', text: task.message, focus: { x: .6, y: .5 } },
    task, shot, review: review('composer', box(.4, .72, .42, .12)) });
  assert(reply.action.focus.y > .72, 'typing uses the verified editor instead of a supplied bubble coordinate');
  const send = await approveInput({ action: { action: 'key', key: 'enter', purpose: 'submit', modifiers: [] },
    task, shot, review: review('send', box(.86, .90, .12, .07)) });
  assert.equal(send.action.action, 'click');
  assert(send.action.y > .9);
});

test('transcription accepts only a new menu and its native transcription item', async () => {
  const voice = { ...task, operation: 'read', readRequest: { kind: 'voice-transcript', sequence: 12 } };
  const before = snapshot(1);
  const right = await approveInput({ task: voice, shot: before, action: { action: 'click', button: 'right', x: .5, y: .33 },
    review: review('voice', box(.43, .30, .16, .08)) });
  assert.equal(right.next, 'menu');
  const state = { stage: right.next, revision: before.revision, shot: before };
  const action = { action: 'click', x: .57, y: .41 };
  const verifyMenu = review('transcribe', box(.52, .39, .16, .045));
  await assert.rejects(approveInput({ action, task: voice, shot: before, state, review: verifyMenu }), denied);
  await assert.rejects(approveInput({ action, task: voice, shot: snapshot(2, ocr('识别图中二维码', .53, .4)), state, review: verifyMenu }), denied);
  const convert = await approveInput({ action, task: voice, shot: snapshot(2, ocr('转文字', .53, .4)), state, review: verifyMenu });
  assert.equal(convert.menu, true);
  assert.equal(convert.next, null);
});

test('file reception follows a checked menu and a host-chosen save location', async () => {
  const directory = '/private/tmp/wb-fixture';
  const file = { ...task, operation: 'read', readRequest: { kind: 'attachment-save', fileName: 'notes.txt', destination: { directory } } };
  const before = snapshot(1, ocr('notes.txt', .45, .32));
  const right = await approveInput({ action: { action: 'click', button: 'right', x: .49, y: .33 },
    task: file, shot: before, review: review('file', box(.42, .30, .21, .08)) });
  assert.equal(right.next, 'menu');
  const menu = snapshot(2, ocr('另存为…', .53, .4));
  const saveAs = await approveInput({ action: { action: 'click', x: .57, y: .41 }, task: file,
    shot: menu, state: { stage: right.next, revision: before.revision, shot: before }, review: review('saveAs', box(.52, .39, .16, .045)) });
  assert.equal(saveAs.next, 'saveDialog');
  const dialog = snapshot(3, ocr('存储为：', .3, .25), ocr('取消', .45, .7), ocr('保存', .60, .7));
  const go = await approveInput({ action: { action: 'key', key: 'g', modifiers: ['cmd', 'shift'] }, task: file,
    shot: dialog, state: { stage: saveAs.next, revision: menu.revision }, review: review('saveDialog', box(.38, .25, .24, .04)) });
  const folder = snapshot(4, ocr('前往文件夹：', .33, .3));
  const type = await approveInput({ action: { action: 'type', purpose: 'file-path', text: '/other' }, task: file,
    shot: folder, state: { stage: go.next, revision: dialog.revision }, review: review('folderField', box(.35, .36, .3, .05)) });
  assert.equal(type.action.text, directory);
  const enter = await approveInput({ action: { action: 'key', key: 'enter', modifiers: [] }, task: file,
    shot: snapshot(5, ...folder.ocr.slice(1), ocr(directory, .37, .43, .2)),
    state: { stage: type.next, revision: folder.revision }, review: review('folderChoice', box(.36, .41, .3, .06), box(.36, .41, .3, .06)) });
  assert.equal(enter.next, 'destination');
  const save = { action: 'click', x: .64, y: .71 };
  const saveReview = review('save', box(.59, .68, .1, .05), box(.35, .42, .2, .06));
  await assert.rejects(approveInput({ action: save, task: file, shot: { ...dialog, revision: 6 },
    state: { stage: enter.next, revision: 5 }, review: saveReview }), denied);
  const saved = await approveInput({ action: save, task: file, shot: snapshot(6, ...dialog.ocr.slice(1), ocr('wb-fixture', .39, .44)),
    state: { stage: enter.next, revision: 5 }, review: saveReview });
  assert.equal(saved.next, 'submitted');
});

test('visual dispatch rejects missing or mismatched menu approval and rechecks the grant after fresh pixels', async t => {
  const h=fixture();h.native.close=()=>{};h.native.cancel=()=>{};h.location.software='WeChat';h.location.texts=[heading,ocr('转文字',.54,.4)];
  let revokeOnCapture=false,current=true;const request=h.native.request;h.native.request=async(op,args)=>{const result=await request(op,args);if(op==='displayCapture'&&revokeOnCapture)current=false;return result;};
  const service=new DesktopService({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap,sensitivePolicy:{checkChannel:()=>{if(!current)throw require('../src/main/dialogue-channels').stale();}}});t.after(()=>service.close());
  const scope=h.visual.identity();service.visualSessions=new Map([['wechat',h.visual]]);service.task={target:'wechat',operation:'read',readRequest:{kind:'voice-transcript',sequence:1},scene:'life',domain:'life',visibilityFloor:1,recipient:task.recipient,channelConversation:true,channelAuthorization:{account:require('../src/main/visual-session').visualAccount(scope),scene:'life'}};service.running=true;service.generation=1;service.controller=new AbortController();
  const shot=await service.captureVisual(scope,1),action={action:'click',x:.58,y:.41},approval={action,shot,target:box(.54,.4,.08,.018),related:[heading],menu:true,next:null};
  await assert.rejects(service.act(action,scope,shot,1),denied);
  await assert.rejects(service.act(action,scope,shot,1,{approval:{...approval,shot:{...shot}}}),denied);
  revokeOnCapture=true;await assert.rejects(service.act(action,scope,shot,1,{approval}),{code:'E_CHANNEL_CHANGED'});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
  current=true;revokeOnCapture=false;await service.act(action,scope,shot,1,{approval});assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
});
test('ordinary channel input still rechecks authority after fresh pixels without staged approval',async t=>{
 for(const operation of ['open','send']){
  const h=fixture();h.native.close=()=>{};h.native.cancel=()=>{};h.location.software='WeChat';let revoke=false,current=true,checks=0;const native=h.native.request;
  h.native.request=async(op,...args)=>{const result=await native(op,...args);if(op==='displayCapture'&&revoke)current=false;return result;};
  const service=new DesktopService({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap,sensitivePolicy:{checkChannel:()=>{checks++;if(!current)throw require('../src/main/dialogue-channels').stale();},check:async()=>({})}});t.after(()=>service.close());const scope=h.visual.identity();service.visualSessions=new Map([['wechat',h.visual]]);
  service.task={...task,target:'wechat',operation,scene:'life',domain:'life',visibilityFloor:1,channelConversation:true,channelAuthorization:{account:require('../src/main/visual-session').visualAccount(scope),scene:'life'}};service.running=true;service.generation=1;service.controller=new AbortController();
  const shot=await service.captureVisual(scope,1),action={action:'click',x:.6,y:.4};revoke=true;await assert.rejects(service.act(action,scope,shot,1),{code:'E_CHANNEL_CHANGED'});assert(checks>=2);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
 }
});
test('ordinary authorized navigation does not require independent role or text approval when coarse labels are missing',async t=>{
 for(const known of [false,true]){
  const h=fixture();h.native.close=()=>{};h.native.cancel=()=>{};h.location={...h.location,software:'WeChat',region:box(0,0,1,1),mainRegion:box(0,0,1,1),texts:[heading,...(known?[ocr(task.recipient,.15,.24)]:[])]};
  let refined=0,clicked=false;const visualRequest=h.visual.request,nativeRequest=h.native.request;
  h.visual.request=async options=>{let input;try{input=JSON.parse(options.messages.find(m=>m.role==='user').content[0].text);}catch{}
   if(input?.purpose==='visual-text-region'){refined++;assert(input.focusInScope);assert.equal(options.maxTokens,1024);assert.equal(options.messages.find(m=>m.role==='user').content.filter(c=>c.type==='image_url').length,2);return {response:{text:JSON.stringify({complete:true,label:task.recipient,texts:[ocr(task.recipient,.15/.33,.24,.08/.33)]})}};}return visualRequest(options);};
  h.native.request=async(op,args)=>{const result=await nativeRequest(op,args);if(op==='displayInput'){assert.equal(args.action,'click');clicked=true;}return result;};
  const service=new DesktopService({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap,planner:async()=>clicked?{action:'done',completed:true,evidence:'synthetic target opened'}:{action:'click',x:.2,y:.25},modelRequest:async()=>({text:JSON.stringify({kind:'contact',box:box(.13,.22,.16,.05)})})});t.after(()=>service.close());
  service.visualSessions=new Map([['wechat',h.visual]]);service.task={id:'synthetic-open-'+known,target:'wechat',operation:'open',recipient:task.recipient,goal:'open synthetic contact',scene:'life',domain:'life',visibilityFloor:1,steps:[],channelConversation:true,channelAuthorization:{account:require('../src/main/visual-session').visualAccount(h.visual.identity()),scene:'life'},workModel:'hy3',startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
  await service.run(1,{...service.task});assert.equal(service.task.status,'review');assert.equal(refined,0);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
 }
});

test('an authorized channel reply uses the normal visual plan without independent input approval or action rewriting', async t => {
  const inputs = [];
  let step = 0, draft = false, sent = false;
  let h;h=fixture({onInput:()=>{}});h.native.close=()=>{};h.native.cancel=()=>{};h.location={...h.location,software:'WeChat',region:box(0,0,1,1),mainRegion:box(0,0,1,1),identityRegion:box(.02,.02,.2,.12),focusRegion:box(.4,.72,.42,.12),texts:[heading,ocr('发送',.88,.92)]};
  const request=h.native.request;h.native.request=async(op,input)=>{const result=await request(op,input);if(op==='displayInput'){inputs.push(input);if(input.action==='type')draft=true;if(input.action==='key'&&input.key==='enter'){sent=true;draft=false;}h.location.texts=[heading,ocr('发送',.88,.92),...(draft?[ocr(task.message,.46,.78)]:sent?[ocr(task.message,.64,.45)]:[])];h.visual.anchor.needsRelocate=true;}return result;};
  const service = new DesktopService({
    native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap,
    planner: async () => {
      if (++step === 1) return { action: 'click', x: .6, y: .4 };
      if (step === 2) return { action: 'type', text: 'Different model text', then: [{ action: 'key', key: 'enter', purpose: 'submit' }] };
      assert(sent);
      return { action: 'done', completed: true, evidence: 'Confirmed the new reply', receipt: { observed: 'delivered', basis: 'New reply visible' } };
    },
    modelRequest: async () => { assert.fail('ordinary sends must not request staged role approval');
    },
  });
  t.after(()=>service.close());service.visualSessions=new Map([['wechat',h.visual]]);
  service.task = { ...task, id: 'managed-reply', channelConversation: true, channelAuthorization: { account: require('../src/main/visual-session').visualAccount(h.visual.identity()), scene: 'life' },
    scene: 'life', domain: 'life', visibilityFloor: 1, target: 'wechat', goal: 'Reply', steps: [], workModel: 'hy3', startedAt: Date.now() };
  service.running = true;
  service.generation = 1;
  service.controller = new AbortController();
  await service.run(1, { ...service.task });
  assert.equal(service.task.sendState, 'confirmed');
  assert.deepEqual(inputs.map(input => input.action), ['click', 'type', 'key']);
  assert.equal(inputs[1].text, task.message);assert(inputs[0].y<80,'the approved visual plan is not rewritten into an independently selected composer click');
  assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
});
