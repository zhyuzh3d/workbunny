import test from 'node:test';
import assert from 'node:assert/strict';
import {taskActivity} from '../src/renderer/task-activity.mjs';
import presentation from '../src/main/task-presentation.js';
const {taskPresentation}=presentation,now=100000;
const monitor=(id,extra={})=>({id,skill:'conversation.manage',subjects:[{application:'wechat',recipient:id}],parameters:{behavior:'reply'},status:'waiting',createdAt:10,state:{conversations:{[id]:{cursor:{ready:true}}}},...extra});
const publicTask=t=>({...t,presentation:taskPresentation(t)});
test('a physical desktop operation cannot hide any of six ongoing monitors',()=>{
 const tasks=Array.from({length:6},(_,i)=>publicTask(monitor('Alice'+i)));
 const rows=taskActivity({agent:{tasks},desktop:{running:true,task:{id:'send-1',status:'running',recipient:'文件传输助手',sources:['Alice0']}},now});
 assert.equal(rows.length,6);assert(rows.every(r=>r.text.includes('持续监看')));assert(rows.every(r=>!r.terminal));assert(rows.every(r=>r.icon==='bunny'));
 assert.equal(taskActivity({agent:{tasks},desktop:{running:true,task:{id:'other',status:'running',recipient:'文件传输助手'}},now}).length,7);
});
test('one delegated WorkBuddy job has one row while independent WorkBuddy jobs stay visible',()=>{
 const task=publicTask({id:'logical',skill:'work.delegate',goal:'制作项目周报',status:'waiting',workJobId:'job',state:{job:{}},createdAt:1});
 const work={tasks:[{bunnyTaskId:'job',sessionId:'session',taskId:1,status:'running',name:'内部执行名'},{sessionId:'manual',taskId:2,status:'running',name:'主人自己布置的任务'}]};
 const rows=taskActivity({agent:{tasks:[task]},desktop:{task:{id:'job',status:'monitoring',sources:['logical']}},work,now});
 assert.equal(rows.length,2);assert(rows.some(r=>r.taskId==='logical'));assert(rows.some(r=>r.icon==='workbuddy'&&r.text.includes('主人自己布置')));assert(rows.every(r=>r.icon==='workbuddy'));
});
test('paused follow-up preserves actual external running state; stopped follow-up does not hide the job',()=>{
 const task=publicTask({id:'logical',skill:'work.delegate',goal:'制作周报',status:'paused',workJobId:'job',state:{job:{}}});
 const work={tasks:[{bunnyTaskId:'job',sessionId:'session',taskId:1,status:'running',name:'制作周报'}]};
 assert.match(taskActivity({agent:{tasks:[task]},work,now})[0].text,/暂停跟进.*仍在执行/u);
 const rows=taskActivity({agent:{tasks:[{...task,status:'stopped'}]},desktop:{task:{id:'job',target:'workbuddy',status:'monitoring'}},work,now});
 assert.equal(rows.length,1);assert.match(rows[0].text,/WorkBuddy/u);assert.equal(rows[0].terminal,false);assert.equal(rows[0].icon,'workbuddy');
});
test('completed logical work deduplicates executor receipts and expires without new task events',()=>{
 const task=publicTask({id:'logical',skill:'work.delegate',goal:'制作周报',status:'completed',updatedAt:now-500,workJobId:'job',state:{result:{summary:'完成'}}});
 const input={agent:{tasks:[task]},desktop:{task:{id:'job',status:'accepted'}},recentUntil:now+1000,work:{tasks:[{bunnyTaskId:'job',sessionId:'session',taskId:1,status:'completed',endedAt:now-1000}]},now};
 const rows=taskActivity(input);assert.equal(rows.length,1);assert.equal(rows[0].expiresAt,now+6500);assert.equal(rows[0].terminal,true);
 assert.equal(taskActivity({...input,seen:new Set(['agent#logical'])}).length,0,'dismissing the logical result must not reveal duplicate executor receipts');
 assert.equal(taskActivity({...input,now:now+8000}).length,0);
});
test('attention is visible first and ongoing tasks cannot be dismissed by a stale seen key',()=>{
 const tasks=[publicTask(monitor('Alice')),publicTask(monitor('Permission',{status:'waiting_permission'}))];
 const rows=taskActivity({agent:{tasks},seen:new Set(['agent#Alice','agent#Permission']),now});
 assert.equal(rows.length,2);assert.equal(rows[0].taskId,'Permission');assert.match(rows[0].text,/需要开启/u);assert.equal(rows[0].record.presentation.guidance.primaryLabel,'打开授权指引');
});
test('a selected finished task stays readable until collapse; closing removes the stopped row',()=>{
 const task=publicTask(monitor('selected',{status:'stopped',updatedAt:now-20000}));
 const input={agent:{tasks:[task]},now};assert.equal(taskActivity(input).length,0);const rows=taskActivity({...input,selectedKey:'agent#selected'});assert.equal(rows.length,1);assert.equal(rows[0].action,null);assert.equal(rows[0].expiresAt,undefined);
});
test('continuous monitoring and actual work phases share a small status presentation',()=>{
 assert.equal(taskPresentation(monitor('Alice')).statusLabel,'持续监看');
 assert.equal(taskPresentation(monitor('Alice',{inbox:[{}]})).statusLabel,'处理新动态');
 assert.equal(taskPresentation(monitor('Alice',{state:{}})).statusLabel,'建立观察位置');
 assert.equal(taskPresentation({skill:'work.delegate',status:'waiting',state:{workPhase:'verifying',job:{}}}).statusLabel,'回收成果');
 assert.equal(taskPresentation({skill:'work.delegate',status:'waiting',state:{result:{},delivery:{status:'sending'}}}).statusLabel,'正在交付');
 assert.equal(taskPresentation({goal:'请处理 /private/tmp/record.csv 的统计',status:'running',state:{}}).title,'处理 record.csv 的统计');
});
test('only completed tasks get a checkmark; active rows target a real stop and queued tasks stay in the panel',()=>{
 const tasks=[publicTask(monitor('active')),publicTask(monitor('waiting-to-start',{status:'queued'})),publicTask(monitor('done',{status:'completed',updatedAt:now-100}))];
 const rows=taskActivity({agent:{tasks},work:{tasks:[{sessionId:'manual',taskId:7,status:'running',name:'手工工作'},{sessionId:'failure',taskId:8,status:'failed',endedAt:now-100}]},now});
 assert(!rows.some(r=>r.taskId==='waiting-to-start'));assert.equal(rows.find(r=>r.taskId==='active').action,'stop');assert.equal(rows.find(r=>r.taskId==='done').action,'dismiss');
 assert.deepEqual(rows.find(r=>r.key==='manual#7').ref,{source:'workbuddy',sessionId:'manual',taskId:7});assert.equal(rows.find(r=>r.key==='failure#8').action,null);
});
