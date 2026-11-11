'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { JsonLines, MAX_NATIVE_LINE_BYTES } = require('./json-lines');
const diagnostics=require('./operation-diagnostics');
const {randomUUID}=require('node:crypto');
const displayBridges=new Map();
const DISPLAY_OPS=new Set(['displayCapture','capture','visualSample','visualCommit','visualForget']);
const INPUT_OPS=new Set(['displayInput','click','move','scroll','key','type','pasteFile','workbuddyFill','workbuddySend']);

function defaultBinary() {
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'bin', 'desktop')
    : path.join(__dirname, '..', '..', 'bin', 'desktop');
}

/** Persistent client for the bounded native desktop JSONL bridge. */
class DesktopNative extends EventEmitter {
  constructor(binaryPath = defaultBinary(), options = {}) {
    super();
    this.binaryPath = binaryPath;
    this.spawnProcess = options.spawn || spawn;
    this.shareDisplay=options.sharedDisplay??!options.spawn;
    this.displayBridge=null;
    this.maxResponseLineBytes = options.maxResponseLineBytes || MAX_NATIVE_LINE_BYTES;
    this.proc = null;
    this.responses = new JsonLines(this.maxResponseLineBytes);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.terminal = false;
    this.stopPromise = null;
    this.recoveryGeneration = 0;
    this.diagnosticId=randomUUID();
    this.sharedPixelControllers=new Set();
    this.boper=options.boper||require('./boper-service').getBoperService();
    this.inputContext=options.inputContext||null;
    this.inputOwners=new Set();
  }

  setInputContext(provider){if(typeof provider!=='function')throw new TypeError('输入授权提供者必须为函数');this.inputContext=provider;}

  _start() {
    if (this.terminal) throw new Error('桌面原生客户端已关闭');
    if (this.stopPromise) throw new Error('桌面原生模块正在停止');
    if (this.proc && this.closed) throw new Error('桌面原生模块正在退出');
    if (this.proc && !this.closed) return;
    this.closed = false;
    this.responses.reset();
    let child;
    try { child = this.spawnProcess(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { throw new Error(`桌面原生模块启动失败：${error.message}`); }
    this.proc = child;
    const inputLines=new JsonLines(256*1024);
    child.stdio?.[3]?.on('data',chunk=>{try{inputLines.push(chunk,message=>{this._onInput(child,message).catch(error=>this._break(child,error));});}catch(error){this._break(child,error);}});
    child.stdio?.[3]?.on('error',error=>this._break(child,error));
    child.stdio?.[4]?.on('error',error=>this._break(child,error));
    const processTrace=diagnostics.bind({nativeClientId:this.diagnosticId},{inherit:false});
    child.stdout.on('data', chunk => { if (this.proc === child && !this.closed) this._onData(chunk); });
    child.stdout.on('error', error => this._break(child, new Error(`桌面原生 stdout 错误：${error.message}`)));
    child.stderr.on('data', chunk => this.emit('stderr', String(chunk).trim()));
    child.stderr.on('error', error => this.emit('stderrError', error));
    child.stdin.on('error', error => this._break(child, new Error(`桌面原生 stdin 错误：${error.message}`)));
    child.on('error', error => this._break(child, new Error(`桌面原生模块启动失败：${error.message}`)));
    child.on('close', (code, signal) => {
      if (this.proc === child) {
        this.proc = null;
        this.closed = true;
        this.responses.reset();
        this._failAll(new Error(`桌面原生模块已退出（code=${code}, signal=${signal || ''}）`));
      }
      this.emit('close', { code, signal });
      processTrace.record('native-exit',{status:'closed'});
    });
  }

  _onData(chunk) {
    try {
      this.responses.push(chunk, response => {
        if (!Number.isSafeInteger(response.id) || typeof response.ok !== 'boolean') throw new Error('Invalid desktop response');
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if(response.inputOutcome?.clipboardChanged===true){pending.inputOutcome.seen=true;pending.inputOutcome.clipboardChanged=true;pending.recordInputOutcome({clipboardChanged:true});}
        pending.trace.record(response.ok?'native-receipt':'native-error',{ok:response.ok,status:response.ok?'acknowledged':response.dispatched===false?'not-dispatched':'uncertain',nativeAcknowledged:response.result?.performed===true,dispatched:response.dispatched,code:response.code});
        const settle=async()=>{let cleanup;try{cleanup=await this.boper.endScope(pending.inputContext?.ownerId,pending.scopeId);}catch(error){cleanup={releaseConfirmed:false};pending.inputOutcome.releaseConfirmed=false;}finally{this.inputOwners.delete(pending.inputContext?.ownerId);}if(pending.inputStarted)pending.recordInputOutcome(cleanup);
        if (response.ok) pending.resolve(pending.inputOutcome.seen?{...response.result,inputOutcome:{...pending.inputOutcome,...cleanup}}:response.result);
        else {
          const error = new Error(response.error || '桌面原生请求失败');
          if (typeof response.code === 'string') error.code = response.code;
          if (typeof response.dispatched === 'boolean') error.dispatched = response.dispatched;
          if(pending.inputOutcome.seen){error.inputOutcome={...pending.inputOutcome,...cleanup};if(pending.inputOutcome.dispatched)error.dispatched=true;}
          if (response.diagnostic && typeof response.diagnostic === 'object') {
            const d=response.diagnostic;
            const guardChecks=require('./self-repair').diagnostic({guardChecks:d.guardChecks})?.guardChecks;
            error.diagnostic={...(typeof d.operation==='string'&&/^[a-zA-Z]{1,48}$/u.test(d.operation)?{operation:d.operation}:{}),
              ...(Number.isSafeInteger(d.candidateCount)&&d.candidateCount>=0?{candidateCount:d.candidateCount}:{}),
              ...(['background-ax','foreground-ax'].includes(d.method)?{method:d.method}:{}),...(guardChecks?{guardChecks}:{})};
          }
          pending.reject(error);
        }
        };settle().catch(pending.reject);
      });
    } catch (error) {
      this._break(this.proc, new Error(error.code === 'E_JSON_LINE_LIMIT'
        ? '桌面原生模块响应行超过 64 MiB' : '桌面原生模块返回无效响应'));
    }
  }

  _break(child, error) {
    if (this.proc !== child || this.closed) return;
    this.closed = true;
    this._cancelInputOwners('native-break').catch(()=>{});
    this.responses.reset();
    this._failAll(error);
    try { child.kill('SIGKILL'); } catch {}
  }

  _failAll(error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.trace.record('native-error',{status:'uncertain'});
      if(item.inputStarted)item.recordInputOutcome({completion:'unknown'});const scoped=Object.assign(new Error(error.message),{code:error.code,...(item.inputOutcome.seen?{inputOutcome:{...item.inputOutcome},dispatched:item.inputOutcome.dispatched||undefined}:{})});item.reject(scoped);
    }
    this.pending.clear();
  }

  async request(op, payload = {}, timeoutMs = 12000, inputContext = {}) {
    if(op==='permissions'&&payload.inputBackend===undefined)payload={...payload,inputBackend:this.boper.status().enabled?'virtual-hid':'cg-event'};
    const pixelSource=process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE;
    if(pixelSource&&DISPLAY_OPS.has(op)){
      if(this.terminal)throw new Error('桌面原生客户端已关闭');
      if(op!=='displayCapture')throw Object.assign(Error('共享显示像素模式不允许旧窗口采集或独立显示流；请使用通用视觉观察'),{code:'E_PIXEL_SOURCE_MODE',dispatched:false});
      const controller=new AbortController(),generation=this.recoveryGeneration;this.sharedPixelControllers.add(controller);
      const trace=diagnostics.bind({nativeClientId:this.diagnosticId,nativeRequestId:randomUUID(),nativeOperation:op});trace.record('native-dispatch',{status:'requested',timeoutMs:Math.min(1500,timeoutMs)});
      try{const frame=await require('./shared-display-pixels').readDisplayPixels({manifest:pixelSource,payload,timeoutMs:Math.min(1500,timeoutMs),signal:controller.signal});if(this.terminal||generation!==this.recoveryGeneration)throw Object.assign(Error('共享像素请求已取消'),{code:'E_ABORTED',dispatched:false});trace.record('native-receipt',{status:'acknowledged',ok:true});return frame;}
      catch(error){trace.record('native-error',{status:'not-dispatched',code:error.code});throw error;}finally{this.sharedPixelControllers.delete(controller);}
    }
    if(this.shareDisplay&&DISPLAY_OPS.has(op)){
      if(this.terminal)throw new Error('桌面原生客户端已关闭');
      if(!this.displayBridge){
        const key=path.resolve(this.binaryPath);let bridge=displayBridges.get(key);
        if (bridge?.closing) {
          const generation = this.recoveryGeneration;
          await bridge.closing;
          if (generation !== this.recoveryGeneration) throw new Error('截图请求已取消');
          return this.request(op, payload, timeoutMs);
        }
        if(!bridge){bridge={native:new DesktopNative(this.binaryPath,{sharedDisplay:false,spawn:this.spawnProcess,maxResponseLineBytes:this.maxResponseLineBytes}),clients:new Set(),tail:Promise.resolve(),key};displayBridges.set(key,bridge);}
        bridge.clients.add(this);this.displayBridge=bridge;
      }
      const bridge=this.displayBridge,generation=this.recoveryGeneration;
      // A single system display connection owns all capture state. In this macOS
      // session, a second live helper's CGDisplayStream initializer hangs. GUI
      // clients keep independent input bridges; stopping one cannot kill capture
      // or replay another client's input.
      const execute=()=>{if(this.terminal||generation!==this.recoveryGeneration)throw new Error('截图请求已取消');return bridge.native.request(op,payload,timeoutMs);};
      const result=bridge.tail.then(execute);bridge.tail=result.catch(()=>{});
      const value=await result;if(this.terminal||generation!==this.recoveryGeneration)throw new Error('截图请求已取消');return value;
    }
    const generation = this.recoveryGeneration;
    for (let attempt = 0; ; attempt++) {
      try { return await this._requestOnce(op, payload, timeoutMs,inputContext); }
      catch (error) {
        const captureTimeout = (op === 'displayCapture' || op === 'capture' || op === 'visualSample') &&
          (/^截图请求超时/.test(error.message) || error.message === `桌面原生请求超时：${op}`);
        if (!captureTimeout || generation !== this.recoveryGeneration || this.terminal) throw error;
        diagnostics.record('native-recovery',{nativeOperation:op,attempt:attempt+1,status:'started'});
        // A stuck CG display call can outlive its response; reap the whole bridge before
        // accepting another capture. In-flight writes are rejected, never replayed.
        await this._stop('截图超时恢复');
        if (!['displayCapture','capture'].includes(op) || attempt !== 0 || generation !== this.recoveryGeneration || this.terminal) throw error;
      }
    }
  }

  _requestOnce(op, payload = {}, timeoutMs = 12000, explicitContext={}) {
    if (typeof op !== 'string' || !op || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return Promise.reject(new TypeError('op 和对象 payload 为必填项'));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new RangeError('timeoutMs 须为 1 至 30000 毫秒'));
    }
    try { this._start(); } catch (error) { return Promise.reject(error); }
    const id = this.nextId++;
    const trace=diagnostics.bind({nativeClientId:this.diagnosticId,nativeRequestId:this.diagnosticId+':'+id,nativeOperation:op,operation:payload.action});
    const message = { ...payload, id, op, timeoutMs, sentAtMs: Date.now() };
    let inputContext;try{const owned=this.inputContext?.(op,payload)||{};inputContext={...owned,...explicitContext,ownerId:owned.ownerId,validate:owned.validate,signal:explicitContext.signal||owned.signal};}catch(error){return Promise.reject(error);}
    if(INPUT_OPS.has(op)&&inputContext.validate){try{this.boper.assertAvailable({...inputContext,...(payload.background&&op==='workbuddyFill'?{background:true,targetPid:payload.expected?.pid}:{background:false})});}catch(error){return Promise.reject(error);}}
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending=this.pending.get(id);
        this.pending.delete(id);
        trace.record('native-error',{code:'E_NATIVE_TIMEOUT',status:'uncertain',timeoutMs});
        // A timeout is not permission to keep emitting after the caller releases
        // its GUI lease. Stop this exact scope before settling the request.
        this.boper.endScope(inputContext.ownerId,this.diagnosticId+':'+id).catch(()=>{}).finally(()=>{if(pending?.inputStarted)pending.recordInputOutcome({completion:'unknown'});this.inputOwners.delete(inputContext.ownerId);reject(Object.assign(new Error(`桌面原生请求超时：${op}`),{code:'E_NATIVE_TIMEOUT',...(pending?.inputStarted?{dispatched:pending.inputOutcome.dispatched||undefined,inputOutcome:{...pending.inputOutcome,completion:'unknown'}}:{})}));});
      }, timeoutMs + 500);
      this.pending.set(id, { resolve, reject, timer,trace,inputContext,scopeId:this.diagnosticId+':'+id,operationId:require('./boper-outcome').operationId()||this.diagnosticId+':'+id,payload,op,recordInputOutcome:require('./boper-outcome').recorder(),inputOutcome:{seen:false,dispatched:false,reportsSubmitted:0,clipboardChanged:false} });
      try {
        trace.record('native-dispatch',{status:'requested',timeoutMs,chars:typeof payload.text==='string'?payload.text.length:undefined,key:payload.key,modifiers:payload.modifiers,x:payload.x,y:payload.y});
        this.proc.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          trace.record('native-error',{status:'uncertain'});
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        trace.record('native-error',{status:'not-dispatched'});
        reject(error);
      }
    });
  }

  async _stop(reason) {
    if (this.stopPromise) return this.stopPromise;
    const inputStop=this._cancelInputOwners(reason);
    const child = this.proc;
    this.closed = true;
    this._failAll(new Error(`桌面原生请求已取消：${reason}`));
    if (!child) return inputStop;
    this.stopPromise = (async () => {
      let onClose, didExit = false;
      const exited = new Promise(resolve => { onClose = resolve; child.once('close', resolve); });
      let killTimer, exitTimer;
      try {
        let cleanupError;try{await inputStop;}catch(error){cleanupError=error;}
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          if (this.proc === child) { try { child.kill('SIGKILL'); } catch {} }
        }, 500);
        const exitTimeout = new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('桌面原生模块未能退出')), 3000); });
        await Promise.race([exited, exitTimeout]);
        didExit = true;
        if(cleanupError)throw cleanupError;
      } finally {
        if (killTimer) clearTimeout(killTimer);
        if (exitTimer) clearTimeout(exitTimer);
        child.removeListener('close', onClose);
        if (this.proc === child && didExit) this.proc = null;
        this.closed = true;
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  async _onInput(child,message){
    if(this.proc!==child||this.closed)return;
    const pending=this.pending.get(message.requestId);let response={id:message.id,ok:false,error:'输入请求已失效',code:'E_BOPER_CONTEXT',dispatched:false};
    if(pending&&Number.isSafeInteger(message.id)&&message.operation&&typeof message.operation==='object'){
      try{
        const operation=message.operation,context={...pending.inputContext};
        if(!context.displayBounds?.length)context.displayBounds=message.displayBounds;
        if(operation.params?.clipboardChanged===true){pending.inputOutcome.seen=true;pending.inputOutcome.clipboardChanged=true;pending.recordInputOutcome({clipboardChanged:true});}
        if(operation.params?.targetPid){if(pending.payload.background!==true||operation.params.targetPid!==pending.payload.expected?.pid||pending.op==='displayInput')throw Object.assign(Error('定向输入与本次已授权目标不一致'),{code:'E_BOPER_TARGET',dispatched:false});context.targetPid=operation.params.targetPid;context.background=true;}
        if(pending.op==='displayInput'){context.visual=true;context.displayBounds=[pending.payload.visualEvidence.displayRect];operation.params={...operation.params,visualEvidence:pending.payload.visualEvidence};}
        this.inputOwners.add(context.ownerId);
        pending.inputStarted=true;
        const result=await this.boper.execute(operation,context,{scopeId:pending.scopeId,operationId:pending.operationId,timeoutMs:Math.min(30000,Math.max(3000,message.timeoutMs||12000))});
        pending.recordInputOutcome(result);
        pending.inputOutcome.seen=true;pending.inputOutcome.dispatched||=result.dispatched===true;pending.inputOutcome.reportsSubmitted+=result.reportsSubmitted||0;pending.inputOutcome.clipboardChanged||=result.clipboardChanged===true;pending.inputOutcome.moved||=result.moved===true;pending.inputOutcome.completion=result.completion;if(result.clipboardChangeCount!==undefined)pending.inputOutcome.clipboardChangeCount=result.clipboardChangeCount;
        response={id:message.id,ok:true,result};
      }catch(error){const result=error.inputOutcome||{};pending.recordInputOutcome({...result,...(error.dispatched===true?{dispatched:true}:{}),completion:result.completion||(error.dispatched===false?'not-dispatched':'unknown')});pending.inputOutcome.seen=true;pending.inputOutcome.dispatched||=error.dispatched===true||result.dispatched===true;pending.inputOutcome.clipboardChanged||=result.clipboardChanged===true;pending.inputOutcome.moved||=result.moved===true;pending.inputOutcome.completion=result.completion||(error.dispatched===false?'not-dispatched':'unknown');pending.inputOutcome.reportsSubmitted+=result.reportsSubmitted||0;response={id:message.id,ok:false,error:error.message,code:error.code==='E_UNSUPPORTED_TARGET_PID'?'E_BACKGROUND_UNSUPPORTED':error.code||'E_BOPER_INPUT',dispatched:pending.inputOutcome.dispatched,result};}
    }
    if(this.proc===child&&!this.closed)child.stdio[4].write(JSON.stringify(response)+'\n');
  }

  async _cancelInputOwners(reason){const owners=new Set([...this.inputOwners,...[...this.pending.values()].map(p=>p.inputContext?.ownerId)].filter(Boolean));await Promise.all([...owners].map(owner=>this.boper.cancelOwner(owner,reason)));}

  async close() {
    for(const controller of this.sharedPixelControllers)controller.abort();this.sharedPixelControllers.clear();
    this.recoveryGeneration++;
    this.terminal = true;
    try {
      await this._stop('close');
    } finally {
      const bridge = this.displayBridge;
      if (bridge) {
        this.displayBridge = null;
        bridge.clients.delete(this);
        if (!bridge.clients.size) {
          const remove = () => { if (displayBridges.get(bridge.key) === bridge) displayBridges.delete(bridge.key); };
          // Leave the closing bridge registered until its display lease has
          // actually been released by process exit.
          bridge.closing = bridge.native.close().finally(() => {
            if (!bridge.native.proc) remove();
            else bridge.native.once('close', remove);
          });
          await bridge.closing;
        }
      }
    }
  }

  cancel() {
    for(const controller of this.sharedPixelControllers)controller.abort();this.sharedPixelControllers.clear();
    this.recoveryGeneration++;
    return this._stop('cancel');
  }
}

module.exports = { DesktopNative, defaultBinary };
