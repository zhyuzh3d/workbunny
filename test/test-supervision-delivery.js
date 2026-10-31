'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {TaskSupervision}=require('../src/main/task-supervision');
const {Monitor}=require('../src/main/monitor');
const {scopedMonitorContext}=require('../src/main/work-context');
function fixture(){
 let now=100000,mode='normal',release,queued;const events=[],spoken=[],saved=new Map();
 const cfg={memory:{enabled:true},monitor:{enabled:true,speakOnDone:false,speakOnLong:true,speakOnStall:true,speakOnRest:false,minGapMs:40000}};
 const snap={sessionId:'fixture',lastEventAt:99000,task:{id:1,messageKey:'one',userText:'整理资料',startedAt:20000,endedAt:99000,status:'ok',endReason:'done'},history:[]};
 const ctx={Date:{now:()=>now},require,config:{load:()=>cfg},memory:{ready:true,generation:1,addMessageOnce:async(id,role,text)=>{if(mode==='defer')await new Promise(r=>{release=r;queued=true});const old=saved.get(id);if(old&&old!==text)throw Error('conflicting duplicate');saved.set(id,text);return{record:{id}};}},
  monitor:{view:{running:[],done:[snap]}},delegationMonitor:null,storageBusy:false,screenLocked:false,connection:{status:()=>({ready:true})},supervisionBusy:false,currentScene:()=> 'private',
  scopedWork:async view=>({view}),taskSupervision:new TaskSupervision({clock:()=>now,bootAt:0}),busy:false,speaking:false,composing:false,speakerFilter:{enrollment:false},desktop:null,secretary:null,
  quietUntil:0,lastHeardAt:0,BOOT_AT:0,lastProactiveAt:0,workSpanStart:0,restNoticedAt:0,presentedReplies:new Set(),history:[],scopePolicy:{rank:()=>2},inputAdmission:{containsSecret:t=>t.includes('fixture-secret')},win:null,
  send:(name,data)=>events.push({name,...data}),speak:(text,opts)=>spoken.push({text,...opts}),log:()=>{}};
 const source=fs.readFileSync('src/main/index.js','utf8');vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function proactiveAllowed()'),source.indexOf('async function proactive()')),ctx);
 return{ctx,cfg,snap,events,spoken,saved,advance:ms=>now+=ms,defer:()=>{mode='defer'},isQueued:()=>queued,release:()=>{mode='normal';release()}};
}
test('disabled completion stays pending, then is shown and spoken exactly once when enabled',async()=>{
 const f=fixture();await f.ctx.refreshSupervision();assert.equal(f.spoken.length,0);assert.equal(f.ctx.taskSupervision.pending.length,1);
 f.cfg.monitor.speakOnDone=true;await f.ctx.refreshSupervision();assert.equal(f.spoken.length,1);assert.equal(f.events.filter(e=>e.name==='chat').length,1);
 f.advance(50000);await f.ctx.refreshSupervision();assert.equal(f.spoken.length,1);assert.equal(f.saved.size,1);
});
test('speech starting while an alert is persisted defers delivery without losing or duplicating its record',async()=>{
 const f=fixture();f.cfg.monitor.speakOnDone=true;f.defer();const running=f.ctx.refreshSupervision();
 while(!f.isQueued())await Promise.resolve();f.ctx.speaking=true;f.release();await running;
 assert.equal(f.spoken.length,0);assert.equal(f.ctx.taskSupervision.pending.length,1);
 f.ctx.speaking=false;await f.ctx.refreshSupervision();assert.equal(f.spoken.length,1);assert.equal(f.saved.size,1);
});
test('sensitive task titles are replaced with a generic warning without losing failed status',async()=>{
 const f=fixture();f.cfg.monitor.speakOnDone=true;f.snap.task.status='failed';f.snap.task.userText='fixture-secret';
 await f.ctx.refreshSupervision();assert.equal(f.spoken.length,1);assert(!f.spoken[0].text.includes('fixture-secret'));assert.match(f.spoken[0].text,/未能完成/);
});
test('actual monitor input carries a completed WorkBuddy round through scoped history to supervision',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-supervision-monitor-')),dir=path.join(root,'project');fs.mkdirSync(dir);
 const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,'');const monitor=new Monitor();monitor.start(root);
 t.after(()=>{monitor.stop();fs.rmSync(root,{recursive:true,force:true})});
 const now=Date.now(),write=(role,content,at)=>fs.appendFileSync(file,JSON.stringify({type:'message',role,content:[{type:'text',text:content}],timestamp:at})+'\n');
 write('user','请检查第一项',now);monitor.scan();write('assistant','第一项已经有结果。',now+1);monitor.scan();
 const snap=[...monitor.sessions.values()][0].snap;monitor.finishTask('done',undefined,snap);
 write('user','请继续第二项',now+2);monitor.scan();
 const scoped=scopedMonitorContext(monitor.view,{scene:'private',bootAt:now-1,ready:true}).view;
 const supervision=new TaskSupervision({clock:()=>now+3,bootAt:now-1});supervision.observe([...scoped.running,...scoped.done]);
 assert.equal(scoped.running.length,1);assert.equal(supervision.peek()?.kind,'done');assert.match(supervision.peek().text,/第一项/);
});
