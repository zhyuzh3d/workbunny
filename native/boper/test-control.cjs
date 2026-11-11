'use strict';
// Loading the real addon in a standalone Node process must never confer the
// packaged Bunny host's ability to authorize workers or reset virtual devices.
const assert=require('node:assert/strict');
const path=require('node:path');
const control=require(path.resolve(process.argv[2]||path.join(__dirname,'../../build/native/boper-control.node')));
(async()=>{
  const status=await control.status();
  assert.equal(status.ready,false);assert.equal(status.hostContextTrusted,false);
  assert.equal(status.installationMode,'local-admin-launchdaemon');
  assert.equal(typeof status.helperRequirement,'string');
  assert.match(status.helperRequirement,/identifier "cn\.haminn\.workbunny\.boper-hid" and certificate leaf = H"[0-9a-f]{40}"/i);
  assert.equal(typeof status.updateRequired,'boolean');
  assert.equal(typeof status.bundledHelperCDHash,'string');
  assert.equal(typeof status.installedHelperCDHash,'string');
  await assert.rejects(control.authorizeRuntime({pid:process.pid,inputSessionId:'standalone-denied',leaseMs:1500}),{code:'E_HOST_CONTEXT'});
  await assert.rejects(control.recover(),{code:'E_HOST_CONTEXT'});
  console.log(JSON.stringify({ok:true,selfTest:'standalone-addon-authority-and-recovery-rejection',inputDispatched:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
