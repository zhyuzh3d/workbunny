'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,visualDraftSubmit}=require('../src/main/desktop-service');
function fixture({matched=true,changed=false}={}){
 let present=true,captures=0,models=0;const calls=[],rect={x:10,y:20,width:800,height:600},header={text:'Alice',confidence:1,x:.4,y:.05,width:.1,height:.03};
 const message='[ᕱᕱ] The AI assistant is ready.';
 const native={request:async(op,payload)=>{calls.push({op,payload});if(op==='frontmost')return {application:{pid:12,bundleId:'com.tencent.xinWeChat'},windows:[{pid:12,windowId:7,rect,layer:0}]};
  if(op==='capture')return {pngBase64:Buffer.from(changed&&++captures>1?'changed':'original').toString('base64'),desktopRect:rect,width:800,height:600,backend:'CGDisplayStream',capturedAt:Date.now()};
  if(op==='recognize')return {texts:[header,...(present?[{text:'[ᕱᕱ] The Al assistant is ready.',confidence:1,x:.4,y:.82,width:.4,height:.04}]:[])]};
  if(op==='key'&&payload.key==='backspace')present=false;return {performed:true};},cancel:async()=>{},close:async()=>{}};
 const svc=new DesktopService({native,imageResize:b=>b,imageCrop:b=>b,modelRequest:async()=>{models++;return {text:JSON.stringify({matched,composer:{x:.3,y:.8,width:.65,height:.16},nextAction:matched?{action:'click',purpose:'submit',x:.9,y:.95,reason:'当前截图显示可发送'}:null})};}});
 svc.task={id:'draft-fixture',target:'wechat',operation:'send',status:'paused',scene:'life',domain:'life',visibilityFloor:1,privacyEpoch:1,sources:['task'],recipient:'Alice',message,draftInserted:true,supersededByNewMessage:true,scope:{pid:12,windowId:7},steps:[],startedAt:Date.now()};
 const clear=()=>svc.clearSupersededDraft({privacyEpoch:1,sources:['task'],scene:'life',observe:async()=>({headerMatched:true,draft:present?'[ᕱᕱ] The Al assistant is ready.':''})});
 return {svc,calls,clear,models:()=>models};
}
test('OCR letter confusion uses one independent visual proof and clears only the known unsubmitted draft',async()=>{
 const f=fixture();assert((await f.clear()).ok);assert.equal(f.models(),1);assert.deepEqual(f.calls.filter(c=>c.op==='key').map(c=>c.payload.key),['a','backspace']);assert(!f.calls.some(c=>c.op==='type'||c.payload?.key==='enter'));await f.svc.close();
});
test('an uncertain or different draft is preserved and identical evidence does not trigger repeated model verification',async()=>{
 const f=fixture({matched:false});assert.equal((await f.clear()).ok,false);assert.equal((await f.clear()).ok,false);assert.equal(f.models(),1);assert(!f.calls.some(c=>c.op==='key'||c.op==='click'));await f.svc.close();
});
test('a draft changed during the visual request is preserved even if the late model says it matched',async()=>{
 const f=fixture({changed:true});assert.equal((await f.clear()).ok,false);assert(!f.calls.some(c=>c.op==='key'||c.op==='click'));await f.svc.close();
});
test('a visual draft proof is bound to both the actual image and original message',async()=>{
 const f=fixture();f.svc.running=true;f.svc.controller=new AbortController();const gen=f.svc.generation,shot=await f.svc.capture({bundleId:'com.tencent.xinWeChat',pid:12,windowId:7},gen);
 assert(await f.svc.confirmWeChatDraft(shot,f.svc.task,gen));shot.ocr.push({text:'发送',confidence:1,x:.8,y:.94,width:.1,height:.04});
 assert(visualDraftSubmit(f.svc.task,shot,true));assert.equal(visualDraftSubmit({...f.svc.task,message:'a different draft'},shot,true),null);
 assert.equal(visualDraftSubmit(f.svc.task,{...shot,preview:'different image'},true),null);f.svc.running=false;await f.svc.close();
});
test('one visual judgment chooses the next submit step; OCR disagreement does not force another planning request',async()=>{
 const f=fixture();f.svc.running=true;f.svc.controller=new AbortController();
 const shot=await f.svc.capture({bundleId:'com.tencent.xinWeChat',pid:12,windowId:7},f.svc.generation);
 await f.svc.confirmWeChatDraft(shot,f.svc.task,f.svc.generation);
 const next=visualDraftSubmit(f.svc.task,shot,true);assert.equal(next.action,'click');assert.equal(next.purpose,'submit');assert.equal(next.x,.9);assert.equal(f.models(),1);
 f.svc.running=false;await f.svc.close();
});
test('Bunny may judge delivery from actual screenshots without fixed bubble geometry or a second transcription',()=>{
 const {validateAction,validateWechatAction}=require('../src/main/desktop-service');
 const action=validateAction({action:'done',completed:true,evidence:'对照前后截图，本次正文已在会话中出现',receipt:{observed:'delivered',basis:'输入框清空且出现本次的新消息，识别标点有小偏差'}});
 const task={operation:'send',recipient:'Alice',message:'The actual message.',draftInserted:true,submitAttemptedAt:10,hasBeforeSubmit:true,screenshot:{at:11,ocr:[{text:'Alice',confidence:1,x:.4,y:.04}]}};
 assert.doesNotThrow(()=>validateWechatAction(action,task));
 assert.throws(()=>validateWechatAction(action,{...task,hasBeforeSubmit:false}));
 assert.throws(()=>validateWechatAction(action,{...task,screenshot:{...task.screenshot,at:9}}));
});
