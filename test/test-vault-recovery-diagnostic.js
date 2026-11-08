'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VaultDB,vaultErrorDiagnostic}=require('../src/main/vault-db');
const {AgentService}=require('../src/main/agent-service');
test('a rejected native response retains only the finite error code and host operation',()=>{
 const db=new VaultDB({bin:'/unused-fixture',file:'/unused-fixture'});let failure;
 db.pending.set(1,{op:'write',timer:setTimeout(()=>{},1000),resolve:()=>assert.fail('must reject'),reject:error=>{failure=error;}});
 db._onData(Buffer.from(JSON.stringify({id:1,ok:false,error:'invalid_source',privateText:'private-canary@example.invalid'})+'\n'));
 assert.equal(failure.code,'invalid_source');assert.deepEqual(vaultErrorDiagnostic(failure),{nativeCode:'invalid_source',operation:'write',requestId:1});
 const logs=[];AgentService.prototype.recoveryDiagnostic.call({log:(...args)=>logs.push(args)},'restore-experience-policy',{id:'fixture-task'},{error:failure});
 assert.equal(logs[0][1].code,'E_VAULT_REQUEST_FAILED');assert.deepEqual(logs[0][1].vault,{nativeCode:'invalid_source',operation:'write',requestId:1});assert(!JSON.stringify(logs).includes('canary'));assert(!JSON.stringify(logs).includes('Vault request failed'));
});
test('unknown codes and request text are never copied into diagnostics',()=>{
 const error=Object.assign(Error('private-canary@example.invalid /private/file'),{code:'private-canary',vaultOperation:'private-canary',requestId:4});
 assert.deepEqual(vaultErrorDiagnostic(error),{requestId:4});const logs=[];
 AgentService.prototype.recoveryDiagnostic.call({log:(...args)=>logs.push(args)},'restore-runtime',null,{error});
 assert.equal(logs[0][1].code,'E_RECOVERY_EXCEPTION');assert(!JSON.stringify(logs).includes('canary'));assert(!JSON.stringify(logs).includes('/private/'));
});
