'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./support/experience-fixture.cjs'),{MemoryMaintenance}=require('../src/main/memory-maintenance');
test('ongoing dialogue Dream cannot starve the experience lane',async t=>{
 const {memory,repo}=await fixture(t),order=[];memory.agentLearning={memory};const m=new MemoryMaintenance({memory,extract:async()=>({memories:[]}),setTimer:()=>1,clearTimer:()=>{}});t.after(()=>m.close());
 m.runExtract=async()=>{order.push('dialogue');return 'continue';};repo.maintain=async()=>{order.push('experience');return 'continue';};
 await m.runKnowledge('dream',new AbortController().signal);await m.runKnowledge('dream',new AbortController().signal);assert.deepEqual(order,['dialogue','experience']);
});
test('manual pack absorption still runs with automatic extraction disabled, without forcing dialogue or private history',async t=>{
 const {memory,repo}=await fixture(t),m=new MemoryMaintenance({memory,extract:async()=>{throw Error('unrelated messages must not be forced');},allowAutomatic:()=>false,setTimer:()=>1,clearTimer:()=>{}});t.after(()=>m.close());let absorbed=0;
 repo.maintain=async()=>{absorbed++;return 'done';};m.requestExperience();await m.tick();assert.equal(absorbed,1);assert.equal(m.status().status,'idle');
 m.requestExperience({automatic:true});await m.tick();assert.equal(absorbed,1);assert.equal(m.status().status,'paused','automatic feedback keeps the existing automatic-maintenance preference');
});
