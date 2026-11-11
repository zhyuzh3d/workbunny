'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ensureDriver}=require('../src/main/boper-installer');
const {AuthorizationService}=require('../src/main/authorization-service');
function commands(){const seen=[];return {seen,execute:async(file,args)=>{seen.push([file,args]);return {stdout:'',stderr:args[0]==='-dv'?'TeamIdentifier=G43BCU2T37\n':''};}};}
test('reuse verified installed driver without installer, restarts or removing shared resources',async()=>{
 const mock=commands();const result=await ensureDriver({exists:()=>true,execute:mock.execute});assert.equal(result.installed,false);assert.equal(mock.seen.length,5);assert(mock.seen.at(-1)[1].includes('activate'));assert(!mock.seen.some(([f])=>/osascript|installer|launchctl|kill|rm/u.test(f)));
});
test('partial upstream installation is preserved and rejected before commands run',async()=>{
 const mock=commands();await assert.rejects(ensureDriver({exists:p=>p.startsWith('/Applications'),execute:mock.execute}),/不完整/);assert.equal(mock.seen.length,0);
});
test('mismatched component signer cannot be activated',async()=>{
 const seen=[];await assert.rejects(ensureDriver({exists:()=>true,execute:async(file,args)=>{seen.push(args);return {stdout:'',stderr:'TeamIdentifier=OTHER\n'};}}),/签名身份/);assert(!seen.some(args=>args.includes('activate')));
});
test('a failed upstream activation is reported instead of claiming ready',async()=>{
 const mock=commands();await assert.rejects(ensureDriver({exists:()=>true,execute:async(file,args)=>{if(args.includes('activate'))throw Error('activation needs approval');return mock.execute(file,args);}}),/needs approval/);
});
test('VirtualHID readiness satisfies input without inventing CGEvent permission',async()=>{
 const flags={screenCaptureAllowed:true,postEventAllowed:false};const auth=new AuthorizationService({permissions:async()=>flags,inputStatus:()=>({enabled:true,backend:'virtual-hid',state:'ready'})});assert.deepEqual(await auth.inspect({name:'screen.action'}),[]);assert.equal(flags.postEventAllowed,false);
});
test('enabled virtual mode in fault cannot borrow an existing CGEvent grant',async()=>{
 const auth=new AuthorizationService({permissions:async()=>({screenCaptureAllowed:true,postEventAllowed:true}),inputStatus:()=>({enabled:true,backend:'virtual-hid',state:'fault'})});assert.deepEqual(await auth.inspect({name:'screen.action'}),['boperReady']);
});
