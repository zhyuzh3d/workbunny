'use strict';
// Standalone programs may query the same local service. Invalid KEY requests
// must reject before any authorization, release, recovery or live input.
const assert=require('node:assert/strict');
const path=require('node:path');
const control=require(path.resolve(process.argv[2]||path.join(__dirname,'../../build/native/boper-control.node')));
(async()=>{
  const status=await control.status();
  assert.equal(typeof status.ready,'boolean');
  assert.equal(typeof status.sessionActive,'boolean');
  assert.equal(status.groupActive,false);
  assert.equal('hostContextTrusted' in status,false);
  assert.equal(status.installationMode,'local-admin-launchdaemon');
  assert.equal(typeof status.helperRequirement,'string');
  assert.match(status.helperRequirement,/identifier "cn\.haminn\.workbunny\.boper-hid" and certificate leaf = H"[0-9a-f]{40}"/i);
  assert.equal(typeof status.updateRequired,'boolean');
  assert.equal(typeof status.bundledHelperCDHash,'string');
  assert.equal(typeof status.installedHelperCDHash,'string');
  for(const key of [undefined,null,'','a'.repeat(23),'a'.repeat(25),'a'.repeat(23)+'+','a'.repeat(23)+'中',42]){
    for(const action of ['authorizeRuntime','renewSession','revokeSession','recover']){
      await assert.rejects(control[action]({key,pid:process.pid,inputSessionId:'synthetic-invalid-key',leaseMs:1500}),{code:'E_KEY_INVALID'});
    }
    if(key!==undefined)await assert.rejects(control.status({key}),{code:'E_KEY_INVALID'});
  }
  assert.equal('key' in status,false);assert.equal('delegationToken' in status,false);
  console.log(JSON.stringify({ok:true,selfTest:'standalone-addon-status-and-invalid-key-rejection',inputDispatched:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
