'use strict';
const {createHash}=require('node:crypto');
const VOLATILE=new Set(['at','ts','createdAt','updatedAt','checkedAt','verifiedAt','submittedAt','capturedAt','operationId','physicalId','frameId','revision','sampleId','preview','pngBase64','screenshot','durationMs','elapsedMs','note','reason','metrics','counters']);
const GUIDANCE='术语：Task（任务）大于Action（动作），Action大于Operation（单次计算机操作）；一个Action可包含多次模型判断和多个Operation。Task和Action在完成时都必须由你自主收集适用信息、核查并确认完成；Operation不必逐次核查，由你按保证质量、效率优先的原则自由安排是否检查及何时检查。自主行动与效率原则：你负责完整目标，自主选择方法、连续推进、检查实际结果，遇到偏差主动补证、重新定位或换办法，不等待主人逐步指挥。经验是参考，不是固定操作脚本。时刻判断耗时是否合理，主动思考怎样更快、更好地完成任务；简单操作不要反复规划、重复核查或盲目等待。行动前在当前规划中顺带粗估计算机、网络或异步过程的合理完成耗时，据此自主安排检查时点、间隔与超时；有把握的连续Operations可以整体估时，不额外发起一次模型调度。留足客观过程所需时间，结合真实进展再判断是否超时或失败；提前完成立即继续，出现明确错误及时调整，不必机械等到上限。timing是宿主累计时间，重试不清零；结合elapsedMs、stageElapsedMs、withoutProgressMs和spent判断时间花在模型、工具还是等待。复用已确认事实与回执；时间戳、提示语和重复截图不代表目标有进展。已有充分依据就立即执行下一步；对结果可预期、位置已知的步骤优先连续执行，不机械要求每次输入或点击前后都截图核查，例如输入正文后短等约1秒直接发送，再核查最终效果。普通识别小偏差可以综合情景判断，不追求每步绝对完美。没有新证据时改变方法，只补最关键的缺口。明确等待异步结果时说明所等条件，并判断何时应重新检查或改用其他方法，不能以笼统等待续期。视觉与键鼠是微信唯一操作方式，也是其他软件在专用工具不适用时的兜底。耗时只触发决策，不能据此编造成功、丢弃已触发动作或重发未知写入；权限、接收对象和真实副作用仍须核实。';
function stable(value,depth=0){
 if(depth>6)return null;
 if(typeof value==='string'){const text=value.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu,'[clock]');return text.length>500?{digest:createHash('sha256').update(text).digest('hex'),length:text.length}:text;}
 if(Array.isArray(value))return value.slice(-16).map(v=>stable(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!VOLATILE.has(k)).slice(0,40).map(k=>[k,stable(value[k],depth+1)]));
 return value;
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))??'null').digest('hex').slice(0,24);
const remainingWaitMs=(requestedMs,observedAt,now=Date.now())=>Math.max(0,observedAt+requestedMs-now);
function pauseFor(ms,signal){
 if(signal?.aborted)return Promise.reject(Object.assign(Error('动作已停止'),{code:'E_ABORTED'}));
 return new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',aborted);resolve();}function aborted(){clearTimeout(timer);signal?.removeEventListener('abort',aborted);reject(Object.assign(Error('动作已停止'),{code:'E_ABORTED'}));}signal?.addEventListener('abort',aborted,{once:true});});
}
class ActionProgress{
 constructor(state={},clock=Date.now){
  this.state=state;this.clock=clock;const now=clock();
  if(state.version!==1)Object.assign(state,{version:1,startedAt:Number.isFinite(state.startedAt)?state.startedAt:now,lastProgressAt:now,stage:'prepare',stageStartedAt:now,evidence:[],repeats:0,reviews:0,spent:{}});
 }
 stage(name){if(this.state.stage!==name){this.state.stage=name;this.state.stageStartedAt=this.clock();}return this;}
 async measure(category,run){const start=this.clock();try{return await run();}finally{this.state.spent[category]=(this.state.spent[category]||0)+Math.max(0,this.clock()-start);}}
 observe(method,evidence,{waiting}={}){
  const s=this.state,key=fingerprint(evidence);s.lastMethod=String(method).slice(0,100);this.wait(waiting||null);
  const facts=evidence?.result||evidence||{};
  s.facts=Object.fromEntries(['ok','verified','status','headerMatched','available','unavailable','latestPending','draftInserted','submitted','matched'].filter(k=>typeof facts[k]==='boolean'||k==='status'&&typeof facts[k]==='string').map(k=>[k,typeof facts[k]==='string'?facts[k].slice(0,50):facts[k]]));
  if(typeof facts.draft==='string')s.facts.draftPresent=!!facts.draft;
  if(/^E_[A-Z_]+$/u.test(String(facts.error||'')))s.facts.errorCode=facts.error;
  // A new opinion about the same facts is not new external evidence.
  if(evidence?.result?.trust==='interpretation-not-authorization'||evidence?.error||evidence?.result?.ok===false){s.repeats++;return false;}
  if(!s.evidence.includes(key)){
   if(s.waitSince!=null){s.waitMs=(s.waitMs||0)+Math.max(0,this.clock()-s.waitSince);s.waitSince=this.clock();}
   s.evidence=[...s.evidence.slice(-7),key];s.lastProgressAt=this.clock();s.repeats=0;s.reviews=0;delete s.lastReviewAt;delete s.blockedReportedAt;
   return true;
  }
  s.repeats++;return false;
 }
 wait(reason){const s=this.state;if(s.waitReason===reason)return this;const now=this.clock();if(s.waitSince!=null){const elapsed=Math.max(0,now-s.waitSince);s.waitMs=(s.waitMs||0)+elapsed;s.lastProgressAt+=elapsed;delete s.waitSince;}s.waitReason=reason;if(reason)s.waitSince=now;return this;}
 snapshot(){const s=this.state,now=this.clock(),waiting=s.waitSince!=null?Math.max(0,now-s.waitSince):0;return {elapsedMs:Math.max(0,now-s.startedAt),withoutProgressMs:Math.max(0,now-s.lastProgressAt-waiting),waitingMs:(s.waitMs||0)+waiting,stage:s.stage,stageElapsedMs:Math.max(0,now-s.stageStartedAt),repeatedEvidence:s.repeats,reviews:s.reviews,lastMethod:s.lastMethod,waitReason:s.waitReason,facts:s.facts,...{spent:{...s.spent}}};}
 reviewDue(){const s=this.state,t=this.snapshot();return !s.waitReason&&s.repeats>=2&&t.withoutProgressMs>=15000&&(!s.lastReviewAt||this.clock()-s.lastReviewAt>=15000);}
 reviewed(){this.state.reviews++;this.state.lastReviewAt=this.clock();return this.snapshot();}
 exhausted(){return this.reviewDue()&&this.state.reviews>=2;}
 blocked(){const t=this.snapshot(),stage={navigate:'定位目标','verify-draft':'核对草稿','verify-result':'核对执行结果',tool:'执行工具',plan:'安排下一步',prepare:'准备动作'}[t.stage]||'推进动作';return Object.assign(Error(`动作已耗时${Math.ceil(t.elapsedMs/1000)}秒，在${stage}时连续核查未取得新证据；已尝试恢复${t.reviews}次，保留目标与实际回执，需要新的有效证据后继续`),{code:'E_NO_PROGRESS',progress:t});}
}
module.exports={ActionProgress,fingerprint,GUIDANCE,remainingWaitMs,pauseFor};
