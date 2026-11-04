'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createGuiAdmission}=require('../src/main/gui-admission');
const {GuiLease}=require('../src/main/gui-lease');

test('GUI admission requires five quiet seconds, a free lease and current readiness',async()=>{
 const lease=new GuiLease();let ready=true,idle=4999,reads=0,afterRead=()=>{};
 const native={request:async()=>{reads++;afterRead();return {hidIdleMs:idle};}};
 const admit=createGuiAdmission({native,lease,ready:()=>ready});
 assert.equal(await admit(),false);idle=5000;assert.equal(await admit(),true);
 await lease.acquire('another-action');assert.equal(await admit(),false);assert.equal(reads,2);lease.release('another-action');
 ready=false;assert.equal(await admit(),false);assert.equal(reads,2);ready=true;
 afterRead=()=>{ready=false;};assert.equal(await admit(),false,'readiness changed during native request');
 ready=true;afterRead=()=>{void lease.acquire('another-action');};assert.equal(await admit(),false,'another action acquired GUI during native request');lease.release('another-action');
 afterRead=()=>{};for(const value of [null,undefined,NaN,Infinity,-1]){idle=value;assert.equal(await admit(),false);}
});
