#!/usr/bin/env node
'use strict';
// Explicit live helper test. Opens idle sessions only; sends no keyboard/mouse report.
// Run with Node 22 after prepare-dev-boper and administrator helper update.
const assert=require('node:assert/strict'),path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {JsonLines}=require('../src/main/json-lines');
const {createKey}=require('../src/main/boper-key');
const {defaultRuntime,defaultControl,defaultHelper}=require('../src/main/boper-service');
const addon=require(defaultControl()),key=createKey(),other=createKey();
const params={key,helperPath:defaultHelper()};
async function observer(group,action){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.resolve(__dirname,'../tools/boperctl.cjs')],{stdio:['pipe','pipe','pipe']});let output='',error='';
  child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>error+=v);child.on('error',reject);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('observer timeout'));},5000);
  child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{reject(Error(error||output));}});
  child.stdin.end(JSON.stringify({key:group,action}));
 });
}
async function main(){
 const status=await addon.status(params);assert.equal(status.ready,true,JSON.stringify(status));
 let worker;
 const pending=new Map(),lines=new JsonLines(256*1024);let next=0,lease;
 const request=(action,payload={})=>new Promise((resolve,reject)=>{
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('runtime timeout'));},4000);pending.set(id,{resolve,reject,timer});worker.stdin.write(JSON.stringify({id,action,...payload})+'\n');
 });
 const startWorker=()=>{
  lines.reset();worker=spawn(defaultRuntime(),[],{stdio:['pipe','pipe','pipe','pipe']});
  worker.stdout.on('data',chunk=>lines.push(chunk,v=>{const p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);v.ok?p.resolve(v.result):p.reject(Object.assign(Error(v.error.message),{code:v.error.code}));}));
  worker.stderr.on('data',()=>{});
 };
 startWorker();
 let session=randomUUID();
 const open=async()=>{
  const delegation=await addon.authorizeRuntime({...params,pid:worker.pid,inputSessionId:session,leaseMs:3000});
  await request('beginSession',{backend:'virtual-hid',inputSessionId:session,leaseMs:3000,displayBounds:[{x:0,y:0,width:1,height:1}],...delegation});
  lease=setInterval(()=>{void addon.renewSession({...params,inputSessionId:session,leaseMs:3000}).catch(()=>{});void request('renewSession',{inputSessionId:session,leaseMs:3000}).catch(()=>{});},500);lease.unref();
 };
 try{
  await open();
  assert.equal((await observer(key,'status')).result.groupActive,true);
  assert.equal((await observer(other,'status')).result.groupActive,false);
  const denied=await observer(other,'stop');assert.equal(denied.ok,false);assert.equal(denied.error.code,'E_SESSION_MISMATCH');
  assert.equal((await observer(key,'status')).result.groupActive,true);
  const stopped=await observer(key,'stop');assert.equal(stopped.ok,true);assert.equal(stopped.result.releaseConfirmed,true);
  const repeated=await observer(key,'stop');assert.equal(repeated.result.alreadyReleased,true);
  assert.equal((await request('stop',{inputSessionId:session})).releaseConfirmed,true);
  clearInterval(lease);await new Promise(resolve=>{worker.once('close',resolve);worker.kill('SIGKILL');});startWorker();
  const old=session;session=randomUUID();await open();
  await assert.rejects(addon.revokeSession({...params,inputSessionId:old}),{code:'E_SESSION_MISMATCH'});
  assert.equal((await observer(key,'status')).result.groupActive,true);
  await addon.revokeSession({...params,inputSessionId:session});
  console.log(JSON.stringify({passed:true,independentNodeCallers:true,sameKeyQueryAndStop:true,differentKeyRejected:true,staleSessionRejected:true,idempotentCleanup:true,inputDispatched:false}));
 }finally{
  clearInterval(lease);await addon.revokeSession({...params,inputSessionId:session}).catch(()=>{});worker.kill('SIGKILL');
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
