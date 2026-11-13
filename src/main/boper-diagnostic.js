'use strict';
// Controlled receiver belonging to Bunny; never reads or targets another app.
const path=require('node:path'),{randomUUID}=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runLocalTest({BrowserWindow,boper,lease,screen,parent,getScene}){
 if(typeof getScene!=='function'||getScene()!=='life')throw Error('本地调试测试仅允许在生活场景进行，请先切换到生活场景');
 if(boper.status().backend!=='virtual-hid'||boper.status().state!=='ready')throw Error('请先启用并核对 VirtualHID 就绪，再测试');
 const ownerId='boper-test-'+randomUUID(),scopeId=randomUUID(),abort=new AbortController();
 if(!lease?.isFree())throw Error('当前有任务使用键鼠，请先暂停后测试');
 await lease.acquire(ownerId,abort.signal);
 let win,native;const evidence={backend:'virtual-hid',startedAt:new Date().toISOString(),steps:[]};
 try{
  win=new BrowserWindow({width:660,height:460,title:'BOPER 本地键鼠验收',parent,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
  win.on('closed',()=>{abort.abort();void boper.cancelOwner(ownerId,'test-window-closed').catch(()=>{});});
  await win.loadFile(path.join(__dirname,'../renderer/boper-test.html'));win.show();win.focus();
  await delay(1200);
  const bounds=screen.getDisplayMatching(win.getBounds()).bounds,rect=win.getContentBounds(),point={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  const context={ownerId,application:'boper-local-receiver',requiredInputBackend:'virtual-hid',displayBounds:[bounds],signal:abort.signal,validate:()=>getScene()==='life'&&!win.isDestroyed()&&win.isFocused()&&!abort.signal.aborted&&lease.owner===ownerId};
  const execute=async(action,params)=>{const result=await boper.execute({action,params},context,{scopeId,operationId:randomUUID(),timeoutMs:12000});evidence.steps.push({action,...result});return result;};
  native=new(require('./desktop-native').DesktopNative)(undefined,{boper,inputContext:()=>context});
  const captureEvidence=async(frameId=randomUUID())=>{
   const frame=await native.request('displayCapture',{output:'base64',region:rect},12000);
   if(frame.backend!=='CGDisplayStream')throw Error('本地测试未取得规定的显示像素');
   return {frameId,capturedAt:frame.capturedAt,displayRect:bounds,region:rect};
  };
  const visual=async(action,params)=>{
   const proof=await captureEvidence();
   const result=await native.request('displayInput',{action,...params,visualEvidence:proof},12000,
    {...(['click','scroll'].includes(action)?{refreshVisualEvidence:()=>captureEvidence(proof.frameId)}:{})});
   evidence.steps.push({action,via:'desktop-native/displayInput',captureBackend:'CGDisplayStream',...result});return result;
  };
  // The starting pointer may be across a large display. Move first, then take
  // a fresh receiver-only frame before committing the click; retain the same
  // production evidence lifetime instead of extending it for diagnostics.
  const permissionFrame=await native.request('displayCapture',{output:'base64',region:rect},12000);
  if(permissionFrame.backend!=='CGDisplayStream')throw Error('本地测试未取得规定的显示像素');
  await execute('move',point);await boper.endScope(ownerId,scopeId);await delay(1100);
  await visual('click',{...point,button:'left'});await delay(1100);
  const text='BOPER 中文粘贴验收：Alice，讲座反馈。\n第二行 2026-11-11 / ABC 123';
  await visual('type',{text,lineBreak:'shiftEnter'});await delay(1100);
  const observed=await win.webContents.executeJavaScript('({text:document.querySelector("textarea").value,paste:window.pasteEvents,keys:window.keyEvents})');
  evidence.textExact=observed.text===text;evidence.pasteEvents=observed.paste;evidence.keyEvents=observed.keys;
  if(!evidence.textExact||observed.paste<1||!observed.keys.some(e=>e.key.toLowerCase()==='v'&&e.meta))throw Error('本地接收窗口未确认精确正文和 Cmd+V，已停发');
  await visual('key',{key:'a',modifiers:['command']});await delay(1100);
  evidence.selectAllExact=await win.webContents.executeJavaScript('(()=>{const t=document.querySelector("textarea");return t.selectionStart===0&&t.selectionEnd===t.value.length})()');
  if(!evidence.selectAllExact)throw Error('本地接收窗口未确认 Cmd+A');
  await visual('key',{key:'right'});await delay(1100);
  const scrollStart=await win.webContents.executeJavaScript('(()=>{const t=document.querySelector("textarea");t.value=Array.from({length:100},(_,i)=>"Synthetic scroll row "+i).join("\\n");t.scrollTop=1000;return t.scrollTop})()');
  await visual('scroll',{...point,deltaY:-120});await delay(1100);
  const scrollEnd=await win.webContents.executeJavaScript('({top:document.querySelector("textarea").scrollTop,deltas:window.wheelDeltas})');
  evidence.scrollDirection={requestedDeltaY:-120,startTop:scrollStart,endTop:scrollEnd.top,observed:scrollEnd.top>scrollStart?'down':scrollEnd.top<scrollStart?'up':'none',wheelDeltas:scrollEnd.deltas};
  evidence.wheelEvents=await win.webContents.executeJavaScript('window.wheelEvents');
  if(evidence.wheelEvents<1)throw Error('本地接收窗口未收到虚拟滚轮');
  if(evidence.scrollDirection.observed!=='down')throw Error('本地接收窗口滚轮方向与负数向下的工具契约不符');
  const reverseStart=await win.webContents.executeJavaScript('(()=>{const t=document.querySelector("textarea");t.scrollTop=1000;window.wheelDeltas=[];return t.scrollTop})()');
  await visual('scroll',{...point,deltaY:120});await delay(1100);
  const reverseEnd=await win.webContents.executeJavaScript('({top:document.querySelector("textarea").scrollTop,deltas:window.wheelDeltas})');
  evidence.scrollReverseDirection={requestedDeltaY:120,startTop:reverseStart,endTop:reverseEnd.top,observed:reverseEnd.top>reverseStart?'down':reverseEnd.top<reverseStart?'up':'none',wheelDeltas:reverseEnd.deltas};
  if(evidence.scrollReverseDirection.observed!=='up')throw Error('本地接收窗口滚轮方向与正数向上的工具契约不符');
  await execute('drag',{fromX:point.x-100,fromY:point.y,toX:point.x+80,toY:point.y,button:'left'});await delay(1100);
  const drag=await win.webContents.executeJavaScript('({dragMoves:window.dragMoves,buttons:window.lastButtons,x:window.lastPointer?.x,y:window.lastPointer?.y})');
  evidence.dragMoves=drag.dragMoves;evidence.dragEndError=Math.hypot(drag.x-point.x-80,drag.y-point.y);
  if(drag.dragMoves<1||drag.buttons!==0||!Number.isFinite(evidence.dragEndError)||evidence.dragEndError>4)throw Error('本地拖动未确认移动、落点和按钮释放');
  // Keep the initialized session: cancelling authorization would not exercise
  // stopping actual movement. The endpoint stays inside this receiver.
  await delay(1100);
  const moving=boper.execute({action:'move',params:{x:rect.x+35,y:rect.y+95}},context,{scopeId,operationId:randomUUID(),timeoutMs:12000});
  let stopped;const cancelTimer=setTimeout(()=>{stopped=boper.cancelOwner(ownerId,'local-cancel-test');void stopped.catch(()=>{});},60);
  try{await moving;evidence.cancelOutcome='operation-completed-before-stop';}catch(error){evidence.cancelOutcome=error.code||'interrupted';evidence.cancelEffects=error.inputOutcome;}
  finally{clearTimeout(cancelTimer);evidence.stopReceipt=await (stopped||boper.cancelOwner(ownerId,'local-test-end'));}
  if(evidence.stopReceipt?.releaseConfirmed!==true)throw Error('本地停止测试未确认自身键鼠释放');
  evidence.finishedAt=new Date().toISOString();evidence.status='text-and-paste-confirmed';
  if(!win.isDestroyed())await win.webContents.executeJavaScript('document.querySelector("p").textContent='+JSON.stringify('已确认：桌面桥经 VirtualHID 完成点击、中文及换行粘贴、快捷键、滚轮和拖动。停止结果：'+evidence.cancelOutcome));
  return evidence;
 }catch(error){
  evidence.finishedAt=new Date().toISOString();evidence.status='failed';evidence.error={code:error.code||'E_BOPER_LOCAL_TEST',message:error.message,...(error.inputOutcome?{inputOutcome:error.inputOutcome}:{})};evidence.failureContext={scene:getScene(),receiverOpen:!!win&&!win.isDestroyed(),receiverFocused:!!win&&!win.isDestroyed()&&win.isFocused(),cancelled:abort.signal.aborted};error.boperEvidence=evidence;throw error;
 }finally{
  if(evidence.status==='failed'&&win&&!win.isDestroyed())win.close();
  abort.abort();try{await boper.cancelOwner(ownerId,'local-test-finally');}finally{try{await native?.close();}finally{lease.release(ownerId);}}
 }
}
module.exports={runLocalTest};
