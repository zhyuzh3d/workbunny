'use strict';
// Only installs a pinned upstream package when its fixed components are absent.
// Existing shared drivers and daemons are never removed or restarted here.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const MANAGER='/Applications/.Karabiner-VirtualHIDDevice-Manager.app';
const DAEMON='/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app';
const run=(file,args,timeout=15000)=>new Promise((resolve,reject)=>execFile(file,args,{timeout,maxBuffer:256*1024},(error,stdout,stderr)=>{if(error){error.message='BOPER 组件操作未完成：'+String(stderr||error.message).slice(0,1800);reject(error);}else resolve({stdout,stderr});}));
const shellQuote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
const appleQuote=s=>'"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
async function verifyVendor(bundle,execute){
 await execute('/usr/bin/codesign',['--verify','--strict',bundle]);
 const {stderr,stdout}=await execute('/usr/bin/codesign',['-dv','--verbose=4',bundle]);
 if(!/(?:^|\n)TeamIdentifier=G43BCU2T37(?:\n|$)/u.test(stderr+'\n'+stdout))throw Error('现有虚拟 HID 组件签名身份不匹配，已停止；未覆盖现有驱动');
}
function resourceRoot(){return require('./packaged-resources')()?path.join(process.resourcesPath,'boper'):path.resolve(__dirname,'../../resources/boper');}
async function ensureDriver({root=resourceRoot(),execute=run,exists=fs.existsSync}={}){
 const managerExists=exists(MANAGER),daemonExists=exists(DAEMON);
 if(managerExists!==daemonExists)throw Error('发现不完整的共享虚拟 HID 安装，请先修复；不会覆盖或删除现有组件');
 let installed=false;
 if(!managerExists){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.package!=='Karabiner-DriverKit-VirtualHIDDevice-8.8.0.pkg'||manifest.sha256!=='2b6e323bf690fde05b24ca2648536916a274d01496e3826dc8b050b63f8b9842')throw Error('BOPER 分发组件清单不匹配');
  const pkg=path.join(root,manifest.package),stat=fs.lstatSync(pkg);
  if(!stat.isFile()||stat.isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex')!==manifest.sha256)throw Error('BOPER 驱动包校验失败');
  const signature=await execute('/usr/sbin/pkgutil',['--check-signature',pkg]);
  if(!/(?:trusted|受信任|信任)/iu.test(signature.stdout+signature.stderr)||!(signature.stdout+signature.stderr).includes('G43BCU2T37'))throw Error('BOPER 驱动安装包签名校验失败');
  const command='/usr/sbin/installer -pkg '+shellQuote(pkg)+' -target /';
  // System-owned admin prompt; no target-application scripting or arbitrary command.
  await execute('/usr/bin/osascript',['-e','do shell script '+appleQuote(command)+' with administrator privileges'],600000);
  installed=true;
 }
 await verifyVendor(MANAGER,execute);await verifyVendor(DAEMON,execute);
 const job='org.pqrs.service.daemon.Karabiner-VirtualHIDDevice-Daemon',destination='/Library/LaunchDaemons/'+job+'.plist';
 if(!exists(destination)){
  const source=path.join(root,job+'.plist');
  const plist=fs.readFileSync(source,'utf8');
  if(!plist.includes('<string>'+job+'</string>')||!plist.includes(path.join(DAEMON,'Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon')))throw Error('BOPER 驱动服务清单不匹配');
  const command='/usr/bin/install -o root -g wheel -m 644 '+shellQuote(source)+' '+shellQuote(destination)+' && /bin/launchctl bootstrap system '+shellQuote(destination);
  await execute('/usr/bin/osascript',['-e','do shell script '+appleQuote(command)+' with administrator privileges'],600000);
 }
 await execute(path.join(MANAGER,'Contents/MacOS/Karabiner-VirtualHIDDevice-Manager'),['activate'],30000);
 return {installed,activationRequested:true,note:'请完成 macOS 的驱动扩展与后台服务批准。设备就绪前不会发送键鼠输入。'};
}
const HELPER_LABEL='cn.haminn.workbunny.boper-hid';
const ROOT_PLIST='/Library/LaunchDaemons/'+HELPER_LABEL+'.plist';
function helperResources(){return {
 helper:require('./packaged-resources')()?path.join(process.resourcesPath,'../Library/LaunchServices/boper-hid-helper'):path.resolve(__dirname,'../../build/native/boper-hid-helper'),
 plist:require('./packaged-resources')()?path.join(resourceRoot(),HELPER_LABEL+'.root.plist'):path.resolve(__dirname,'../../native/boper/'+HELPER_LABEL+'.root.plist'),
 script:path.join(resourceRoot(),'install-helper.sh'),
};}
async function ensureHelper({control,execute=run,exists=fs.existsSync,resources=helperResources()}={}){
 if(!control?.status||!control?.unregisterLegacyService)throw Error('缺少 BOPER 私有服务控制器');
 const status=await control.status();
 const requirement=status.helperRequirement;
 if(typeof requirement!=='string'||!/^identifier "cn\.haminn\.workbunny\.boper-hid" and certificate leaf = H"[a-fA-F0-9]{40}"$/u.test(requirement))throw Error('BOPER 后台服务身份策略不合法');
 if(status.installed===true&&status.updateRequired===false&&status.helperConnected===true&&!status.error)return {installed:false,reused:true,installationMode:'local-admin-launchdaemon'};
 for(const file of Object.values(resources)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('BOPER 安装资源不是常规文件');}
 await execute('/usr/bin/codesign',['--verify','--strict','-R','='+requirement,resources.helper]);
 const converted=await execute('/usr/bin/plutil',['-convert','json','-o','-',resources.plist]);
 const job=JSON.parse(converted.stdout),allowed=new Set(['Label','Program','UserName','GroupName','MachServices','ProcessType']);
 if(Object.keys(job).some(key=>!allowed.has(key))||job.Label!==HELPER_LABEL||job.Program!=='/Library/PrivilegedHelperTools/'+HELPER_LABEL||job.UserName!=='root'||job.GroupName!=='wheel'||job.ProcessType!=='Interactive'||JSON.stringify(Object.keys(job.MachServices||{}).sort())!==JSON.stringify([HELPER_LABEL+'.control',HELPER_LABEL+'.input'])||Object.values(job.MachServices).some(value=>value!==true))throw Error('BOPER 后台服务清单不匹配');
 const helperHash=crypto.createHash('sha256').update(fs.readFileSync(resources.helper)).digest('hex');
 const plistHash=crypto.createHash('sha256').update(fs.readFileSync(resources.plist)).digest('hex');
 // Await old SM-managed job removal before installing the independent,
 // root-owned job. A late old callback must not unload the new service.
 if(!exists(ROOT_PLIST))await control.unregisterLegacyService();
 const script=fs.readFileSync(resources.script,'utf8');
 const command='/bin/bash -c '+shellQuote(script)+' boper-installer '+[resources.helper,resources.plist,helperHash,plistHash,requirement].map(shellQuote).join(' ');
 await execute('/usr/bin/osascript',['-e','do shell script '+appleQuote(command)+' with administrator privileges'],600000);
 return {installed:true,installationMode:'local-admin-launchdaemon',note:'后台服务已由本机管理员授权安装；虚拟设备就绪状态另行核对。'};
}
module.exports={ensureDriver,ensureHelper,resourceRoot,helperResources};
