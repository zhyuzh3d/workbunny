'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service'),effects=require('../src/main/effect-review');
const {alignedChangeFacts}=require('../src/main/screen-evidence');
function pixels(rect,changed=false){const data=[];for(let y=0;y<rect.height;y++)for(let x=0;x<rect.width;x++){const v=changed&&x===3&&y===3?0:220;data.push(v,v,v,255);}return Buffer.from(JSON.stringify({width:rect.width,height:rect.height,data}));}
const bitmap=b=>JSON.parse(b.toString());
function shot(rect,changed=false){const sourcePixels=pixels(rect,changed);return {rect,pixelRect:rect,sourceRect:{x:0,y:0,width:20,height:20},capturedAt:Date.now(),at:Date.now(),width:rect.width,height:rect.height,sourcePixels,preview:'data:image/png;base64,'+sourcePixels.toString('base64'),ocr:[],perceptionSource:'vision-model',visualFrameId:'actual-'+rect.x};}
test('visual frame metadata preserves the actual rounded pixel crop separately from the estimated input rectangle',async()=>{
 const f=require('./support/visual-fixture.cjs').fixture(),region={x:.103,y:.107,width:.797,height:.793};f.location={...f.location,region,mainRegion:region,monitorRegions:[{x:.2,y:.2,width:.5,height:.4}]};
 const frame=await f.visual.observe();assert(Math.abs(frame.desktopRect.x-20.6)<1e-6);assert.deepEqual(frame.pixelRect,{x:20,y:12,width:160,height:96});assert.equal(frame.width,160);assert.equal(frame.height,96);assert.equal(f.calls.filter(c=>c.op==='displayInput').length,0);f.visual.close();
});
test('an actual GUI request restores complete method sections from the trusted package after upstream summaries omitted them',async()=>{
 let request;const service={task:{id:'physical',steps:[]},progress:()=>({snapshot:()=>({})}),update(){},modelRequest:async o=>{request=o;return {text:'{"action":"done","completed":false,"evidence":"Synthetic read only result"}'};}};
 await DesktopService.prototype.nextAction.call(service,{id:'physical',target:'wechat',operation:'send',goal:'Send the authorized ordinary question',recipient:'Fixture',message:'Synthetic question',workModel:'hy3',operatingKnowledge:[{packageId:'wechat',origin:'innate',revision:21,tags:['software:wechat'],instructions:'## 任务含义\n\n这里只是上游短摘要。',truncated:true}]},{preview:'synthetic',ocr:[]},new AbortController().signal);
 const p=JSON.parse(request.messages.find(m=>m.role==='user').content[0].text),knowledge=p.operatingKnowledge.map(k=>k.instructions).join('\n');
 assert.equal(p.draftInputAttempted,false);assert.equal(p.draftInserted,undefined,'the compact first request also calls native input an attempt');
 for(const term of ['空白编辑区','工具栏','裁图'])assert(knowledge.includes(term),term+' reaches the actual visual model');
 const section=require('../src/main/software-skill-package').loadSoftwarePackages().find(p=>p.application==='wechat').instructions.split(/(?=^##\s)/mu).find(s=>s.startsWith('## 连贯操作'));
 assert(knowledge.includes(section.trim()),'the selected method includes the complete sequence, not its opening paragraph');
});
test('the existing final request receives screen-aligned no-change facts despite a changed crop, without a second model or business verdict',async()=>{
 const before=shot({x:0,y:0,width:20,height:20}),current=shot({x:2,y:2,width:16,height:16});
 const f=alignedChangeFacts(bitmap,before,current);assert.equal(f.available,true);assert.equal(f.cropChanged,true);assert.equal(f.changedPixels,0);assert.equal(f.changedRatio,0);assert.deepEqual(f.overlap,{x:2,y:2,width:16,height:16});assert(!Object.hasOwn(f,'completed'));
 const textured=r=>{const s=shot(r),p=bitmap(s.sourcePixels);for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++)for(let c=0;c<3;c++)p.data[(y*r.width+x)*4+c]=((x+r.x)*37+(y+r.y)*53)%211;s.sourcePixels=Buffer.from(JSON.stringify(p));return s;};assert.equal(alignedChangeFacts(bitmap,textured(before.rect),textured(current.rect)).changedPixels,0,'coordinate alignment must also hold for nonuniform content');
 assert(alignedChangeFacts(bitmap,before,shot(current.rect,true)).changedPixels>0);assert.equal(alignedChangeFacts(bitmap,before,{...current,sourceRect:{x:0,y:0,width:40,height:20}}).reason,'display-geometry-changed');
 let requests=0,payload;const service={bitmap,task:{id:'physical',steps:[]},wechatBeforeSubmit:{...before,taskId:'physical'},progress:()=>({snapshot:()=>({})}),update(){},modelRequest:async o=>{requests++;payload=JSON.parse(o.messages.find(m=>m.role==='user').content[0].text);return {text:'{"action":"done","completed":false,"evidence":"The existing blank editor and grey control remain visible"}'};}};
 await DesktopService.prototype.nextAction.call(service,{id:'physical',target:'wechat',operation:'send',goal:'Send the authorized note',recipient:'Fixture',message:'Synthetic note',workModel:'hy3',draftInserted:true,submitAttempted:true,useInnateExperience:false},current,new AbortController().signal);
 assert.equal(requests,1);assert.equal(payload.draftInputAttempted,true);assert.equal(payload.draftInserted,undefined);assert.equal(payload.imageComparison.changedPixels,0);assert.equal(payload.imageComparison.current.capturedAt,current.capturedAt);assert.equal(payload.message,undefined);
});
function assessment(){return {goalNotMet:true,acceptPossibleDuplicate:true,editorState:'empty',basis:'The fresh visible editor is blank; the original input did not reach it',strategy:'Focus the actual empty editor and restore only the original authorized text',duplicateImpact:'At most one duplicate ordinary note, within the owner authorized scope'};}
async function recovery(t,{major=false,stale=false,existingDraft=false}={}){
 const old={id:'old',key:'old-key',effect:'write',status:'intent',at:100,inputOutcome:{dispatched:true,reportsSubmitted:36,completion:'unknown',releaseConfirmed:true}},task={id:'canonical',goal:major?'Make a payment':'Send the ordinary authorized note',scene:'life',visibilityFloor:1,status:'waiting',state:{},authority:{verified:true},operations:{old}},actual=[];let plans=0;
 const service=new DesktopService({native:{setInputContext(){},close:async()=>{}},planner:async()=>{plans++;if(plans===1)return {action:'type',purpose:'task',text:'Model text must never replace the host authorized body',focus:{x:.5,y:.6},continuationAssessment:{...assessment(),...(existingDraft?{editorState:'present'}:{})}};if(plans===2)return {action:'key',key:'return',modifiers:[],purpose:'submit',continuationAssessment:{...assessment(),strategy:'Submit the newly restored original authorized note once'}};return {action:'done',completed:true,evidence:'The resulting new item is visible',receipt:{observed:'delivered',basis:'Actual resulting item after the new strategy'}};}});t.after(()=>service.close());
 service.task={id:'physical',target:'wechat',operation:'send',message:'Host authorized synthetic note',recipient:'Fixture',goal:task.goal,workModel:'hy3',scene:'life',domain:'life',visibilityFloor:1,steps:[],draftInserted:true,startedAt:Date.now(),submitAttemptedAt:100,submissionAttempts:[{id:'old-submit',outcome:'unknown'}]};service.running=true;service.generation=1;service.controller=new AbortController();service.visualSessions=new Map([['wechat',{observe:async()=>({}),identity:()=>({mode:'visual',sessionId:'fixture'})}]]);
 service.capture=async()=>({...shot({x:0,y:0,width:20,height:20}),visualFrameId:'fresh-'+plans});service.assertScreenshotCurrent=async()=>{};
 service.act=async action=>{assert.equal(action.action==='type'?action.text:'Host authorized synthetic note','Host authorized synthetic note');actual.push(action.action);};
 const context={task,operation:old,input:{message:service.task.message},tool:{continuationPolicy:effects.boundedPolicy},save:async()=>{},isCurrent:()=>!stale};
 return {old,task,actual,service,run:()=>effects.scope(context,()=>service.run(1,{...service.task}))};
}
test('a trusted bounded empty-editor recovery actually types only the host body then submits with new records, retaining all old unknown input',async t=>{
 const f=await recovery(t);await f.run();assert.deepEqual(f.actual,['type','key']);assert.equal(f.service.task.status,'review');assert.equal(f.old.status,'intent');assert.equal(f.old.inputOutcome.reportsSubmitted,36);assert.equal(f.old.inputOutcome.completion,'unknown');assert.equal(f.old.effectReviews.length,2);assert(f.old.effectReviews.every(r=>r.continuation.status==='consumed'));assert.equal(new Set(f.old.effectReviews.map(r=>r.continuation.next.key)).size,2);assert(f.old.effectReviews.every(r=>r.continuation.next.key!==f.old.key));assert.equal(f.service.task.submissionAttempts[0].outcome,'unknown');
});
for(const variant of ['major','stale','existingDraft'])test('body recovery does not bypass '+variant+' boundaries',async t=>{
 const f=await recovery(t,{[variant]:true});await assert.rejects(f.run());assert.deepEqual(f.actual,[]);assert.equal(f.old.status,'intent');assert.equal(f.old.inputOutcome.reportsSubmitted,36);
});
