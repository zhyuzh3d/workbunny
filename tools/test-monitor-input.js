'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{Monitor}=require('../src/main/monitor');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-monitor-')),file=path.join(dir,'session.jsonl');fs.writeFileSync(file,'');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const m=new Monitor();m.attach({file,size:0});return{m,file,e:m.sessions.get(file)};}
test('Chinese split across UTF-8 byte chunks and ISO timestamps remain an exact task',t=>{
 const {m,file,e}=fixture(t),stamp='2026-10-25T00:10:00Z',bytes=Buffer.from(JSON.stringify({type:'message',role:'user',timestamp:stamp,content:'你好，帮我检查这个项目。'})+'\n');const start=bytes.indexOf(Buffer.from('你'))+1;
 fs.appendFileSync(file,bytes.subarray(0,start));m.readNew(e);assert.equal(e.snap.task,null);fs.appendFileSync(file,bytes.subarray(start));m.readNew(e);assert.equal(e.snap.task.userText,'你好，帮我检查这个项目。');assert.equal(e.snap.task.startedAt,Date.parse(stamp));
});
test('replaced or truncated session files do not leave an old offset permanently stuck',t=>{
 const {m,file,e}=fixture(t);fs.writeFileSync(file,JSON.stringify({type:'message',role:'user',content:'原来的长任务说明'.repeat(30),timestamp:Date.now()})+'\n');m.readNew(e);
 fs.writeFileSync(file,JSON.stringify({type:'message',role:'user',content:'新的任务',timestamp:Date.now()})+'\n');m.readNew(e);assert.equal(e.snap.task.userText,'新的任务');
 const replacement=file+'.new';fs.writeFileSync(replacement,JSON.stringify({type:'message',role:'user',content:'替换文件后的任务',timestamp:Date.now()})+'\n');fs.renameSync(replacement,file);m.readNew(e);assert.equal(e.snap.task.userText,'替换文件后的任务');
});

function addMessage(m,e,role,content,timestamp=Date.now()){
 m.handleEvent({type:'message',role,content,timestamp},e);
}
test('review prose with quoted failures, negative wording, or code references is not classified as task failure',t=>{
 const {m,e}=fixture(t);const done=[];m.on('taskDone',snap=>done.push(snap.task.status));
 addMessage(m,e,'user','审查这次交付的错误处理。',1000);
 m.handleEvent({type:'function_call_result',status:'failed',timestamp:1100},e);
 const review='检查结果：代码块里的“验收证据校验失败”是要处理的分支；日志曾写“无法完成”，但这不是本次结论。当前没有失败项。';
 addMessage(m,e,'assistant',review,1200);
 m.finishTask('done',undefined,e.snap);
 assert.equal(e.snap.task.status,'ok','failure terms in review, quoted errors, and negation are not a failure self-report');
 assert.equal(e.snap.task.failures,1,'a failed tool call remains hidden task metadata and does not determine final status');
 assert.equal(e.snap.history[0].summary,review);
 assert.deepEqual(done,['ok']);
});
test('an explicit first-person failure opening is classified failed',t=>{
 const {m,e}=fixture(t);const done=[];m.on('taskDone',snap=>done.push(snap.task.status));
 addMessage(m,e,'user','请检查这个项目并交付报告。',2000);
 addMessage(m,e,'assistant','抱歉，我没能完成这次任务：当前环境缺少必要权限。',2400);
 m.finishTask('done',undefined,e.snap);
 assert.equal(e.snap.task.status,'failed');
 assert.deepEqual(done,['failed']);
});
test('a failed tool call followed by an explicit successful final answer stays successful',t=>{
 const {m,e}=fixture(t);
 addMessage(m,e,'user','帮我生成并核对报告。',3000);
 m.handleEvent({type:'function_call',timestamp:3100},e);
 m.handleEvent({type:'function_call_result',status:'failed',timestamp:3200},e);
 addMessage(m,e,'assistant','报告已经生成并核对完成，所需内容均已交付。',3500);
 m.finishTask('done',undefined,e.snap);
 assert.equal(e.snap.task.status,'ok');
 assert.equal(e.snap.task.failures,1);
});
test('abandoned and superseded outcomes retain their existing semantics',t=>{
 const {m,e}=fixture(t);const done=[];m.on('taskDone',snap=>done.push(snap.task.endReason));
 addMessage(m,e,'user','旧任务甲，请检查内容。',4000);
 addMessage(m,e,'assistant','初步结果已整理。',4100);
 addMessage(m,e,'user','新任务乙，请检查另一项。',4200);
 assert.equal(e.snap.history[0].status,'ok','a superseded task with a candidate answer remains completed');
 assert.equal(e.snap.history[0].endReason,'superseded');
 assert.deepEqual(done,[],'superseded tasks do not emit completion notifications');
 addMessage(m,e,'user','新任务丙，尚未开始。',4300);
 assert.equal(e.snap.history[0].status,'abandoned','superseded task without a final answer remains abandoned');
 assert.equal(e.snap.history[0].endReason,'superseded');
 addMessage(m,e,'assistant','抱歉，我没能完成它。',4400);
 m.finishTask('abandoned',undefined,e.snap);
 assert.equal(e.snap.history[0].status,'abandoned','an explicit abandonment remains abandoned even with failure wording');
 assert.equal(e.snap.history[0].endReason,'abandoned');
 assert.deepEqual(done,[]);
});
