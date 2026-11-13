'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {ensureHelper}=require('../src/main/boper-installer');
const exec=promisify(execFile),requirement='identifier "cn.haminn.workbunny.boper-hid" and certificate leaf = H"'+'a'.repeat(40)+'"';
const job=JSON.parse(require('node:child_process').execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(__dirname,'../native/boper/cn.haminn.workbunny.boper-hid.root.plist')],{encoding:'utf8'}));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boper-helper-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const resources={helper:path.join(dir,"helper ' $(touch exploit-marker)"),plist:path.join(dir,'job.plist'),script:path.join(dir,'installer.sh')};
 fs.writeFileSync(resources.helper,'fixture');fs.writeFileSync(resources.plist,'fixture plist');fs.writeFileSync(resources.script,'#!/bin/bash\nprintf \'%s\\n\' "$@" > "$BOPER_TEST_ARGS"\n');
 const events=[],control={status:async()=>({helperRequirement:requirement,installed:false,updateRequired:true}),unregisterLegacyService:async()=>{events.push('legacy-complete');}};
 const execute=async(file,args)=>{events.push(path.basename(file));if(file==='/usr/bin/codesign')assert.equal(args[3],'='+requirement);if(file==='/usr/bin/plutil')return {stdout:JSON.stringify(job),stderr:''};if(file==='/usr/bin/osascript'){
  const literal=args[1].slice('do shell script '.length,-' with administrator privileges'.length);
  const command=JSON.parse(literal.replace(/\n/g,'\\n'));
  await exec('/bin/sh',['-c',command],{cwd:dir,env:{...process.env,BOPER_TEST_ARGS:path.join(dir,'args')}});
 }return {stdout:'',stderr:''};};
 return {dir,resources,control,execute,events,exists:()=>false};
}
test('verified current connected helper is reused without another administrator prompt',async()=>{
 const status={helperRequirement:requirement,installed:true,updateRequired:false,helperConnected:true};
 const result=await ensureHelper({control:{status:async()=>status,unregisterLegacyService:async()=>assert.fail()},execute:async()=>assert.fail()});assert.equal(result.reused,true);
});
test('administrator install waits for legacy removal and shell-encodes resource names as literal arguments',async t=>{
 const f=fixture(t),result=await ensureHelper(f);assert.equal(result.installed,true);assert(f.events.indexOf('legacy-complete')<f.events.indexOf('osascript'));
 const args=fs.readFileSync(path.join(f.dir,'args'),'utf8').trimEnd().split('\n');assert.equal(args[0],f.resources.helper);assert.equal(args[4],requirement);assert(!fs.existsSync(path.join(f.dir,'exploit-marker')));
});
test('legacy removal uncertainty prevents privileged installation and loaded root jobs skip SM migration',async t=>{
 const f=fixture(t);f.control.unregisterLegacyService=async()=>{throw Error('unregister result unknown');};await assert.rejects(ensureHelper(f),/unknown/);assert(!f.events.includes('osascript'));
 f.exists=()=>true;await ensureHelper(f);assert(f.events.includes('osascript'));
});
test('unexpected launchd capabilities are rejected before administrator execution',async t=>{
 const f=fixture(t),execute=f.execute;f.execute=async(file,args)=>file==='/usr/bin/plutil'?{stdout:JSON.stringify({...job,ProgramArguments:['/bin/sh']})}:execute(file,args);
 await assert.rejects(ensureHelper(f),/清单不匹配/);assert(!f.events.includes('osascript'));
});
test('an ordinary development caller can install verified components with administrator authorization',async t=>{
 const f=fixture(t);f.control.status=async()=>({helperRequirement:requirement,installed:false,updateRequired:true});
 assert.equal((await ensureHelper(f)).installed,true);assert(f.events.includes('osascript'));
});
test('helper copy resources cannot be symlinks even when they resolve to a regular file',async t=>{
 const f=fixture(t);fs.unlinkSync(f.resources.helper);fs.symlinkSync(f.resources.plist,f.resources.helper);
 await assert.rejects(ensureHelper(f),/常规文件/);assert(!f.events.includes('osascript'));
});
