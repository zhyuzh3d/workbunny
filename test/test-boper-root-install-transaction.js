'use strict';
// Execute the actual transaction against a disposable filesystem and fake OS
// endpoints. The production script has no alternate destination/test switch.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t,{previous=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boper-install-transaction-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const helpers=path.join(dir,'Library/PrivilegedHelperTools'),jobs=path.join(dir,'Library/LaunchDaemons'),bin=path.join(dir,'bin');for(const p of [helpers,jobs,bin])fs.mkdirSync(p,{recursive:true});
 const helper=path.join(helpers,'cn.haminn.workbunny.boper-hid'),job=path.join(jobs,'cn.haminn.workbunny.boper-hid.plist');
 const put=(name,text)=>{const file=path.join(bin,name);fs.writeFileSync(file,'#!/bin/bash\n'+text,{mode:0o755});return file;};
 const replacements={
  '/usr/bin/id':put('id','echo 0\n'),
  '/usr/bin/stat':put('stat','if [[ "$2" = %u ]]; then echo 0; else /usr/bin/stat "$@"; fi\n'),
  '/usr/bin/codesign':put('codesign','exit 0\n'),
  '/usr/bin/install':put('install','args=();while [[ "$#" -gt 0 ]]; do case "$1" in -o|-g) shift 2;; *) args+=("$1");shift;; esac;done\nexec /usr/bin/install "${args[@]}"\n'),
  '/bin/launchctl':put('launchctl','echo "$1" >> "$BOPER_FIXTURE_DIR/events"\ncase "$1" in\nprint) test -f "$BOPER_FIXTURE_DIR/loaded";;\nbootout) rm -f "$BOPER_FIXTURE_DIR/loaded";;\nbootstrap) if [[ "${BOPER_FAIL_NEW:-0}" = 1 ]] && grep -q new-helper "$BOPER_FIXTURE_DIR/Library/PrivilegedHelperTools/cn.haminn.workbunny.boper-hid"; then exit 5; fi;touch "$BOPER_FIXTURE_DIR/loaded";;\nesac\n'),
 };
 let script=fs.readFileSync(path.join(root,'resources/boper/install-helper.sh'),'utf8');
 script=script.replaceAll('/Library/PrivilegedHelperTools',helpers).replaceAll('/Library/LaunchDaemons',jobs);
 for(const [from,to]of Object.entries(replacements))script=script.replaceAll(from,to);
 const source=path.join(dir,'source-helper'),sourceJob=path.join(dir,'source-job');
 fs.writeFileSync(source,'new-helper');const jobText=fs.readFileSync(path.join(root,'native/boper/cn.haminn.workbunny.boper-hid.root.plist'),'utf8').replaceAll('/Library/PrivilegedHelperTools',helpers);fs.writeFileSync(sourceJob,jobText);
 if(previous){fs.writeFileSync(helper,'old-helper',{mode:0o755});fs.writeFileSync(job,jobText,{mode:0o644});fs.writeFileSync(path.join(dir,'loaded'),'');}
 const hashes=[digest(source),digest(sourceJob)];
 const run=(env={})=>spawnSync('/bin/bash',['-c',script,'fixture',source,sourceJob,...hashes,'identifier "cn.haminn.workbunny.boper-hid" and certificate leaf = H"'+'a'.repeat(40)+'"'],{encoding:'utf8',env:{...process.env,BOPER_FIXTURE_DIR:dir,...env}});
 return {dir,helper,job,source,jobText,run};
}
test('administrator transaction installs only the pinned own files and cleans its staging directory',t=>{
 const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(f.helper,'utf8'),'new-helper');assert(fs.existsSync(path.join(f.dir,'loaded')));assert(!fs.readdirSync(path.dirname(f.helper)).some(name=>name.startsWith('.boper-install-')));
});
test('bootstrap failure restores the previous helper, plist and loaded service',t=>{
 const f=fixture(t,{previous:true}),result=f.run({BOPER_FAIL_NEW:'1'});assert.equal(result.status,5,result.stderr);assert.equal(fs.readFileSync(f.helper,'utf8'),'old-helper');assert.equal(fs.readFileSync(f.job,'utf8'),f.jobText);assert(fs.existsSync(path.join(f.dir,'loaded')));
});
test('source replacement before privileged copying is rejected without unloading the existing service',t=>{
 const f=fixture(t,{previous:true});fs.writeFileSync(f.source,'unexpected replacement');const result=f.run();assert.equal(result.status,65,result.stderr);assert.equal(fs.readFileSync(f.helper,'utf8'),'old-helper');assert(fs.existsSync(path.join(f.dir,'loaded')));assert(!fs.existsSync(path.join(f.dir,'events')));
});
