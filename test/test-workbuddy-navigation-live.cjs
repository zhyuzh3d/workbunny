'use strict';
const path=require('path'),{DesktopNative}=require('../src/main/desktop-native');
const native=new DesktopNative(path.resolve('bin/desktop'));
(async()=>{if(process.argv.includes('--operate'))await native.request('activate',{bundleId:'com.tencent.workbuddy.mac'},8000);await new Promise(r=>setTimeout(r,700));const front=await native.request('frontmost'),window=front.windows.find(w=>w.bundleId==='com.tencent.workbuddy.mac'&&w.layer===0&&w.rect.width>300);if(front.application.bundleId!=='com.tencent.workbuddy.mac'||!window)throw Error('WorkBuddy must be foreground for this explicit test');
 const scope={bundleId:window.bundleId,pid:window.pid,windowId:window.windowId};
 const state=await native.request('workbuddyNavigate',{expected:front.application,windowId:window.windowId,operation:'inspect'},8000);console.log(JSON.stringify(state));
 if(process.argv.includes('--operate'))console.log(JSON.stringify(await require('../src/main/workbuddy-route').prepareWorkBuddyRoute(native,scope,process.argv.find(a=>a.startsWith('--workspace='))?{workspace:process.argv.find(a=>a.startsWith('--workspace=')).slice(12)}:{mode:'none'})));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>native.close());
