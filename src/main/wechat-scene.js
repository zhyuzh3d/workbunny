'use strict';
const {WeChatObserver}=require('./wechat-observer');
const {randomUUID}=require('node:crypto');
const {DesktopNative}=require('./desktop-native');
const {wechatAuthReason}=require('./wechat-auth-state');
const BUNDLE='com.tencent.xinWeChat';
const normalized=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'').toLowerCase();
// One shared visual scene serves all conversation tasks. No WeChat interface,
// message store or accessibility elements are queried here.
class WeChatScene{
  constructor({native=new DesktopNative(),imageResize,imageCrop,bitmap,subjects=()=>[],clock=Date.now,onCircuit=async()=>{}}={}){
    Object.assign(this,{native,bitmap,subjects,clock,onCircuit});this.observer=new WeChatObserver({native,imageResize,imageCrop,bitmap});
    this.binding={id:'agent-wechat-scene'};this.last=null;this.lastAt=0;this.knownWindow=null;this.circuit=null;this.inflight=null;
    this.metrics={samples:0,recognitions:0,modelInspections:0,quietSamples:0,lastPixelArea:0};
  }
  async trip(reason){if(!this.circuit){this.circuit={reason,at:this.clock()};await this.onCircuit(this.circuit);}return {unavailable:true,reason:this.circuit.reason};}
  async assertHealthy(){
    if(this.circuit)throw Object.assign(new Error('微信操作已熔断：'+this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false});
    const front=await this.native.request('frontmost');
    const windows=front.windows.filter(w=>w.bundleId===BUNDLE&&w.layer===0&&w.rect.width>300&&w.rect.height>250);
    const window=windows.find(w=>w.windowId===this.knownWindow?.windowId)||windows.sort((a,b)=>b.rect.width*b.rect.height-a.rect.width*a.rect.height)[0];
    if(!window){
      // Missing OS metadata is not enough to conclude that screenshot capture
      // failed. Try the external whole display once, without touching the app.
      let detail='全屏核对未能取得可操作的窗口定位';
      try{
        const frame=await this.native.request('capture',{captureMode:'displayStream'},12000);
        if(!frame.pngBase64)throw Error('全屏截图没有图像');
        const ocr=(await this.native.request('recognize',{pngBase64:frame.pngBase64},10000)).texts||[];
        detail=wechatAuthReason(ocr)||'已取得全屏画面，但系统仍未提供可操作的微信窗口定位';
      }catch(error){detail='全屏回退也未完成：'+error.message;}
      await this.trip('微信主窗口暂不可见；'+detail+'。未尝试重开微信');throw Object.assign(new Error(this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false});
    }
    if(this.knownWindow&&(window.pid!==this.knownWindow.pid||window.windowId!==this.knownWindow.windowId)){
      await this.trip('微信窗口或进程身份改变，停止自动操作等待核对');throw Object.assign(new Error(this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false});
    }
    this.knownWindow=window;return window;
  }
  async assertTaskIdentity(task){
    const window=await this.assertHealthy(),old=task.state.sceneIdentity?.wechat;
    if(old&&(old.pid!==window.pid||old.windowId!==window.windowId)){
      await this.trip('这项任务记录的微信身份已变化，停止旧任务；请在本机重新核对交办');
      throw Object.assign(new Error(this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false});
    }
    task.state.sceneIdentity??={};task.state.sceneIdentity.wechat={pid:window.pid,windowId:window.windowId};
  }
  unreadFor(name,ocr,image){
    if(!this.bitmap||!image)return false;
    const rows=ocr.filter(r=>r.x<.3&&r.y>.05&&normalized(r.text)===normalized(name));
    if(!rows.length)return false;
    const {data,width,height}=this.bitmap(Buffer.from(image,'base64'));
    for(const row of rows){
      const x0=Math.max(0,Math.floor((row.x-.04)*width)),x1=Math.min(width,Math.ceil(row.x*width));
      const y0=Math.max(0,Math.floor((row.y-.025)*height)),y1=Math.min(height,Math.ceil((row.y+.012)*height));let red=0;
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*width+x)*4,b=data[i],g=data[i+1],r=data[i+2];if(r>170&&r>g*1.5&&r>b*1.5)red++;}
      if(red>=4)return true;
    }return false;
  }
  async capture(force=false,repairProfile,referenceMessages){
    if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
    if(!force&&this.last&&this.clock()-this.lastAt<500)return this.last;
    if(this.inflight)return this.inflight;
    this.inflight=this.captureOwned(force,repairProfile,referenceMessages).finally(()=>{this.inflight=null;});return this.inflight;
  }
  async captureOwned(force,repairProfile,referenceMessages){
    try{
      await this.assertHealthy();
      const frame=await this.observer.sample(this.binding,{reset:force||!this.last});this.metrics.samples++;
      if(frame.unstable)return {...this.last,unstable:true,changed:false};
      this.metrics.lastPixelArea=(frame.width||0)*(frame.height||0);
      if(!frame.changed&&!frame.baseline&&!frame.geometryChanged&&this.last){
        this.metrics.quietSamples++;this.lastAt=this.clock();this.last={...this.last,changed:false};return this.last;
      }
      if(!frame.pngBase64)throw new Error('变化画面没有像素证据');
      const ocr=(await this.native.request('recognize',{pngBase64:frame.pngBase64})).texts||[];this.metrics.recognitions++;
      const authReason=wechatAuthReason(ocr);if(authReason)return this.trip(authReason);
      const allowed=[...new Set(this.subjects().filter(s=>s.application==='wechat').map(s=>s.recipient))];
      const header=allowed.find(name=>ocr.some(r=>r.confidence>=.6&&r.x>.3&&r.y<.15&&normalized(r.text)===normalized(name)));
      const unread={};for(const name of allowed)unread[name]=this.unreadFor(name,ocr,frame.pngBase64);
      let view={headerMatched:false,messages:[],draft:''};
      if(header){view=await this.observer.inspect({recipient:header,identity:this.knownWindow,...(referenceMessages?.recipient===header?{referenceMessages:referenceMessages.messages}:{})},{...frame,ocr},undefined,repairProfile);this.metrics.modelInspections++;}
      await this.observer.commit(this.binding);
      this.lastAt=this.clock();this.last={...view,header,unread,latestPending:view.latestPending===true||ocr.some(r=>r.x>.65&&r.y>.55&&/(?:条新消息|new messages?)/iu.test(r.text)),changed:true,revision:randomUUID(),at:this.lastAt};return this.last;
    }catch(error){
      if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
      if(/微信主窗口不可见|窗口或进程身份改变|没有屏幕录制|缺少屏幕录制|截图.*超时|请求超时.*(?:capture|visualSample)/u.test(error.message))return this.trip(error.message);
      // Parsing failures remain read-only and are retried on a later poll.
      throw error;
    }
  }
  async observe(subject,{force=false,relocate=false,repairProfile,referenceMessages}={}){
    if(relocate){this.binding.windowId=undefined;this.invalidate();}
    const scene=await this.capture(force,repairProfile,referenceMessages);
    if(scene.unavailable)return scene;
    if(scene.unstable)return {headerMatched:false,unstable:true,changed:false,unread:!!scene.unread?.[subject.recipient]};
    return {headerMatched:scene.header===subject.recipient&&scene.headerMatched,unread:!!scene.unread?.[subject.recipient],
      changed:scene.changed,revision:scene.revision,latestPending:!!scene.latestPending,messages:scene.header===subject.recipient?scene.messages:[],draft:scene.header===subject.recipient?scene.draft:'',at:scene.at};
  }
  verifyLiteralInput(message,options){return this.observer.verifyLiteralInput(message,options);}
  readLiteralInput(message,options){return this.observer.readLiteralInput(message,options);}
  reuseObservation(subject,shot){
    const last=this.last,frame=this.observer.frames.get(last?.observationId);
    if(!last?.headerMatched||last.header!==subject.recipient||last.latestPending||last.unstable||!frame?.preview||!shot?.preview||
      frame.identity?.pid!==this.knownWindow?.pid||frame.identity?.windowId!==this.knownWindow?.windowId)return null;
    const image=s=>({pngBase64:s.split(',')[1]||''});
    // Compare the complete conversation and heading, excluding the composer.
    // Reuse the actual prior interpretation only when no relevant pixel moved;
    // do not await an unrelated in-flight interpretation of a changed draft.
    const bottom=last.conversationBottom;if(!Number.isFinite(bottom)||bottom<=.1||bottom>.9)return null;
    if(frame.preview!==shot.preview&&!require('./screen-evidence').sameTargetRegion(this.bitmap,image(frame.preview),image(shot.preview),{x:.32,y:.02,width:.67,height:bottom-.02},.000001))return null;
    return {headerMatched:true,messages:last.messages||[],latestPending:false,revision:last.revision,at:shot.at};
  }
  invalidate(){this.last=null;this.lastAt=0;}
  async reconnect(){
    const prior=this.circuit;this.circuit=null;this.knownWindow=null;this.binding.windowId=undefined;this.invalidate();
    try{const result=await this.capture(true);if(result.unavailable)throw new Error(result.reason);return {ok:true};}
    catch(error){this.circuit=this.circuit||prior||{reason:error.message,at:this.clock()};return {ok:false,error:this.circuit.reason};}
  }
  async close(){await this.observer.close();}
}
module.exports={WeChatScene};
