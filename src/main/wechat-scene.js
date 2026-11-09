'use strict';
const {WeChatObserver}=require('./wechat-observer');
const {randomUUID}=require('node:crypto');
const {DesktopNative}=require('./desktop-native');
const {wechatAuthReason}=require('./wechat-auth-state');
const {visualAccount}=require('./visual-session');
const normalized=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'').toLowerCase();
// One shared visual scene serves all conversation tasks. No WeChat interface,
// message store or accessibility elements are queried here.
class WeChatScene{
  constructor({native=new DesktopNative(),imageResize,imageCrop,bitmap,subjects=()=>[],clock=Date.now,onCircuit=async()=>{}}={}){
    Object.assign(this,{native,bitmap,subjects,clock,onCircuit});this.observer=new WeChatObserver({native,imageResize,imageCrop,bitmap});
    this.visual=this.observer.visual;this.binding={id:'agent-wechat-scene'};this.last=null;this.lastAt=0;this.knownIdentity=null;this.circuit=null;this.inflight=null;
    this.metrics={samples:0,recognitions:0,modelInspections:0,quietSamples:0,lastPixelArea:0};
  }
  async trip(reason,kind='unclear'){if(!this.circuit){this.circuit={reason,kind,at:this.clock()};await this.onCircuit(this.circuit);}return {unavailable:true,reason:this.circuit.reason};}
  async classifyFailure(error){
    const state=error.diagnostic?.visualState;
    if(error.code==='E_APP_CIRCUIT'||state?.requiresOwner===true){await this.trip(error.message,state?.kind||'unclear');error.code='E_APP_CIRCUIT';error.dispatched=false;}
    return error;
  }
  async assertHealthy({signal}={}){
    if(this.circuit)throw Object.assign(Error('微信操作已停止：'+this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false,diagnostic:{visualState:{kind:this.circuit.kind,requiresOwner:true}}});
    try{await this.visual.observe({signal,allowInactive:true});this.knownIdentity=this.visual.identity();return this.knownIdentity;}
    catch(error){throw await this.classifyFailure(error);}
  }
  async assertTaskIdentity(task,options){
    const identity=await this.assertHealthy(options),old=task.state.sceneIdentity?.wechat;
    if(old&&visualAccount(old)!==visualAccount(identity)){
      await this.trip('原任务的视觉身份已失效，需主人核对身份后重新视觉定位；不继承旧窗口或进程身份','identity');
      throw Object.assign(Error(this.circuit.reason),{code:'E_APP_CIRCUIT',dispatched:false,diagnostic:{visualState:{kind:'identity',requiresOwner:true}}});
    }
    task.state.sceneIdentity??={};task.state.sceneIdentity.wechat=identity;
  }
  unreadFor(name,rows){return rows.some(row=>normalized(row.text)===normalized(name)&&row.badge==='notification');}
  async capture(force=false,repairProfile,referenceMessages){
    if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
    if(!force&&this.last&&this.clock()-this.lastAt<500)return this.last;
    if(this.inflight)return this.inflight;
    this.inflight=this.captureOwned(force,repairProfile,referenceMessages).finally(()=>{this.inflight=null;});return this.inflight;
  }
  async captureOwned(force,repairProfile,referenceMessages){
    try{
      if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
      const observedAt=this.clock();
      const frame=await this.observer.sample(this.binding,{reset:force||!this.last});this.metrics.samples++;this.knownIdentity=this.visual.identity();
      if(frame.unstable)return {...this.last,unstable:true,changed:false};
      this.metrics.lastPixelArea=(frame.width||0)*(frame.height||0);
      if(!frame.changed&&!frame.baseline&&!frame.geometryChanged&&this.last){
        this.metrics.quietSamples++;this.lastAt=this.clock();this.last={...this.last,changed:false};return this.last;
      }
      if(!frame.pngBase64)throw new Error('变化画面没有像素证据');
      const ocr=frame.texts||[];this.metrics.recognitions++;
      const authReason=wechatAuthReason(ocr);if(authReason)return this.trip(authReason,'login');
      const allowed=[...new Set(this.subjects().filter(s=>s.application==='wechat').map(s=>s.recipient))];
      const header=allowed.find(name=>ocr.some(r=>r.confidence>=.6&&r.x>.3&&r.y<.15&&normalized(r.text)===normalized(name)));
      const unread={};for(const name of allowed)unread[name]=this.unreadFor(name,ocr,frame.pngBase64);
      let view={headerMatched:false,messages:[],draft:''};
      if(header){view=await this.observer.inspect({recipient:header,identity:this.knownIdentity,...(referenceMessages?.recipient===header?{referenceMessages:referenceMessages.messages}:{})},{...frame,ocr},undefined,repairProfile);this.metrics.modelInspections++;}
      await this.observer.commit(this.binding);
      this.lastAt=this.clock();this.last={...view,messages:(view.messages||[]).map(message=>({...message,observedAt})),header,unread,latestPending:view.latestPending===true||ocr.some(r=>r.x>.65&&r.y>.55&&/(?:条新消息|new messages?)/iu.test(r.text)),changed:true,revision:randomUUID(),at:this.lastAt};return this.last;
    }catch(error){
      if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
      const classified=await this.classifyFailure(error);
      if(this.circuit)return {unavailable:true,reason:this.circuit.reason};
      // Uncertain pixels, focus and transient capture/model failures belong to
      // the bounded Action recovery; they do not imply an account failure.
      throw classified;
    }
  }
  async observe(subject,{force=false,relocate=false,repairProfile,referenceMessages}={}){
    if(relocate)this.invalidate();
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
      visualAccount(frame.identity)!==visualAccount(this.knownIdentity))return null;
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
    const prior=this.circuit;this.circuit=null;this.knownIdentity=null;this.visual.reset();this.invalidate();
    try{const result=await this.capture(true);if(result.unavailable)throw new Error(result.reason);return {ok:true};}
    catch(error){this.circuit=this.circuit||prior||{reason:error.message,at:this.clock()};return {ok:false,error:this.circuit.reason};}
  }
  async close(){await this.observer.close();}
}
module.exports={WeChatScene};
