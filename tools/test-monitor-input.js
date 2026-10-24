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
