'use strict';

// Recovery budgets belong to the logical Action, not an error string, a model
// request or a particular application. These are scheduling defaults; Bunny
// still chooses the observations and methods within the existing authority.
const DEFAULTS=Object.freeze({attempts:3,totalAttempts:6,delayMs:3000,maxDelayMs:3600000});
const ACTIONS=new Set(['reobserve','change_method','wait','ask_owner']);
const evidenceOf=progress=>[...(progress?.state?.evidence||[])].sort();
function begin(owner,{progress,now,code='E_STEP',policy=DEFAULTS,operations=[]}={}){
 const evidence=evidenceOf(progress),previous=owner.recoveryState;
 const fresh=!previous||evidence.some(key=>!previous.evidence.includes(key));
 const state=fresh?{...previous,version:1,attempts:0,totalAttempts:previous?.episodeId?previous?.totalAttempts||0:['progressed','rearmed'].includes(previous?.status)?0:previous?.totalAttempts||previous?.attempts||0,startedAt:previous?.startedAt??now,evidence,history:previous?.history||[]}:previous;
 owner.recoveryState=state;
 // Keep all evidence seen in this bounded episode, so alternating old views or
 // changing error wording cannot renew the allowance.
 state.evidence=[...new Set([...state.evidence,...evidence])].slice(-32);
 state.code=/^E_[A-Z0-9_]{1,64}$/u.test(code)?code:'E_STEP';
 state.observations=operations.slice(-8).map(op=>({operationId:op.id,tool:op.tool,status:op.status}));
 state.limit=state.window?.attempts||Math.max(2,Math.min(6,Number(policy.attempts)||DEFAULTS.attempts));
 state.totalLimit=state.window?.totalLimit||Math.max(state.limit,Math.min(12,Number(policy.totalAttempts)||DEFAULTS.totalAttempts));
 state.exhausted=state.attempts>=state.limit||(state.totalAttempts||0)>=state.totalLimit;
 if(!state.exhausted){state.attempts++;state.totalAttempts=(state.totalAttempts||0)+1;state.status='diagnosing';}
 return state;
}
function decide(state,advice={}, {now,policy=DEFAULTS,requestAction}={}){
 advice??={};
 if(state.exhausted){state.status='exhausted';state.exhaustionReason='recovery-budget';delete state.nextAt;return {action:'ask_owner',exhausted:true,obstacleConfirmed:false,exhaustionReason:state.exhaustionReason};}
 const fallback=state.attempts===1?'reobserve':state.attempts===2?'change_method':'wait';
 let action=ACTIONS.has(advice.action)?advice.action:fallback;
 // One opinion is not proof of a permanent obstacle. An actual authority,
 // authentication or unknown-effect boundary is handled before this module.
 if(action==='ask_owner')action=fallback;
 const delayed=state.attempts>=state.limit||state.totalAttempts%state.limit===0||action==='wait';
 if(delayed)action='wait';
 const waitMs=delayed?Math.max(policy.delayMs||DEFAULTS.delayMs,Math.min(policy.maxDelayMs||DEFAULTS.maxDelayMs,Number(advice.waitMs)||policy.delayMs||DEFAULTS.delayMs)):1000;
 const nextStep=advice.action!=='ask_owner'&&typeof advice.nextStep==='string'&&advice.nextStep.trim()?advice.nextStep.slice(0,1000):{
  reobserve:'从当前事实重新核对最关键的缺口，不把一次错误当作永久阻塞。',
  change_method:'反思此前失败原因，换一个获准的观察角度、参数或方法，避免重复相同的无效检查。',
  wait:'已安排有界延时复试；到期重新观察实际条件，保留原目标和回执，不重放已确认或未知副作用。'
 }[action];
 const guidance={action,at:now,source:advice.source==='llm'?'llm':'local',nextStep,
  observations:state.observations,history:state.history.slice(-3),reflectionRequired:true,
  attempt:state.attempts,limit:state.limit,...(requestAction?{requestAction}:{}),
  ...(delayed?{waitFor:String(advice.waitFor||'等待外部条件变化后重新核对').slice(0,300),waitMs}:{} )};
 state.status=delayed?'delayed':'scheduled';state.nextAt=now+waitMs;
 state.history.push({action,requestAction:requestAction||undefined,code:state.code,source:guidance.source,at:now});state.history=state.history.slice(-6);
 state.guidance=guidance;
 return {...guidance,nextCheckAt:state.nextAt,delayed};
}
function resumed(owner,progress,now){
 const state=owner.recoveryState;if(!state)return;
 if(evidenceOf(progress).some(key=>!state.evidence.includes(key))){state.status='progressed';state.progressedAt=now;delete state.nextAt;}
}
const deferred=(owner,now)=>owner?.recoveryState?.status==='delayed'&&owner.recoveryState.nextAt>now;
const held=owner=>!!owner?.recoveryState&&(!!owner.recoveryState.selfSuspension||owner.recoveryState.mainReview?.status==='decided'||['requested','running'].includes(owner.recoveryState.mainReview?.status)&&owner.recoveryState.mainReview.hold===true||owner.recoveryState.mainReview?.status==='applied'&&owner.recoveryState.mainReview?.decision?.type==='wait');
// A new strategy grants a bounded window in the SAME episode. Cumulative
// attempts, elapsed time, previous guidance and operation identities survive.
function grantWindow(state,guidanceId,{now,attempts=3,totalLimit=12}={}){
 if(state.window?.guidanceId===guidanceId)return true;
 const remaining=Math.max(0,Math.min(12,totalLimit)-(state.totalAttempts||0));
 if(!remaining)return false;
 state.window={guidanceId,startedAt:now,attempts:Math.min(attempts,remaining),totalLimit:Math.min(12,totalLimit),fromTotal:state.totalAttempts||0};
 state.localAttempts=(state.localAttempts||0)+(state.attempts||0);state.attempts=0;state.limit=state.window.attempts;
 state.totalLimit=state.window.totalLimit;state.exhausted=false;state.status='scheduled';delete state.nextAt;return true;
}
// Explicit owner continuation starts a new resource cycle, unlike internal
// guidance. Preserve the episode history/effects and cumulative cost while
// making the newly authorized attempt actually runnable.
function ownerResumed(state,{now,key,attempts=3}={}){
 state.resourceHistory=[...(state.resourceHistory||[]),{cycle:state.resourceCycle||0,totalAttempts:state.totalAttempts||0,reviewCalls:state.reviewCalls||0,at:now}].slice(-6);
 state.lifetimeAttempts=(state.lifetimeAttempts||0)+(state.totalAttempts||0);state.lifetimeReviewCalls=(state.lifetimeReviewCalls||0)+(state.reviewCalls||0);
 state.resourceCycle=(state.resourceCycle||0)+1;state.totalAttempts=0;state.attempts=0;state.reviewCalls=0;state.mainReviewCount=0;
 delete state.selfSuspension;delete state.nextAt;delete state.reviewBudgetReached;delete state.exhaustionReason;
 if(state.mainReview){state.mainReview.status='cancelled';state.mainReview.rejectionReason='owner-resume';}
 delete state.window;return grantWindow(state,key,{now,attempts,totalLimit:12});
}
function due(task,now){return [task.state,...Object.values(task.actionRuns||{})].some(owner=>owner.recoveryState?.status==='delayed'&&owner.recoveryState.nextAt<=now&&(!owner.id||owner.status==='waiting'));}
function checking(owner,now){const state=owner?.recoveryState;if(state?.status==='delayed'&&state.nextAt<=now){state.status='checking';state.lastCheckAt=now;delete state.nextAt;}}
module.exports={DEFAULTS,begin,decide,resumed,deferred,due,checking,held,grantWindow,ownerResumed};
