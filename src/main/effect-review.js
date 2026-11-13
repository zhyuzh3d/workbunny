'use strict';
// One canonical record for Bunny's effect assessment. This is neither an
// executor nor an approval queue; authority still comes from the original Task.
const {AsyncLocalStorage}=require('node:async_hooks'),{createHash,randomUUID}=require('node:crypto');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const context=new AsyncLocalStorage(),hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const visualContexts=new WeakSet();
const fail=message=>Object.assign(Error(message),{code:'E_EFFECT_REVIEW',dispatched:false});
const statement=(v,name)=>{if(typeof v!=='string'||!v.trim()||v.length>1600)throw fail(name+'需要简短明确说明');return v.trim();};
const version=task=>hash([task.id,task.privacyEpoch,task.state?.goalRevision||0,task.state?.controlRevision||0,task.state?.sceneIdentity,Object.entries(task.state?.screenAnchors||{}).map(([application,anchor])=>[application,anchor.sessionId]),task.authority,task.capabilities,task.subjects,task.goal,task.criteria,task.policy,task.context,task.message,task.outboundText,task.recipient,task.channelAuthorization,task.executionAuthorization]);
function boundedPolicy(task,input={}){
 const source=JSON.stringify([task.goal,task.workRequest?.goal,input.message,input.text,input.label]);
 const ownerLimits=typeof task.state?.ownerRequest==='string'?task.state.ownerRequest:task.policy||'';
 if(task.state?.sensitiveContext||task.sensitiveAttachment||task.attachment||task.scene==='private'||task.visibilityFloor>1||/(?:不得重复|禁止重复|绝不重复|严格幂等|exactly.once|never.retry)/iu.test(ownerLimits)||require('./conversation-input').containsSecret(source)||require('./sensitive-policy').hasProtectedContent(source)||/(?:转账|付款|支付|汇款|交易|下单|买入|卖出|删除|清空|覆盖|销毁|卸载|凭据|密码|密钥|验证码|银行|账号授权|\b(?:payment|transfer|purchase|trade|delete|erase|overwrite|credential|password|secret|token|bank)\b)/iu.test(source))return null;
 return {maxContinuations:2,impact:'bounded',kind:'ordinary-ui'};
}
// Host-created execution context, never a model-supplied risk claim. This is
// only permission to treat perception differences as feedback, not a replay
// permit or an extension of the original Task's input authority.
function visualContext(task,input={}, {policy=boundedPolicy,isCurrent=()=>true,signal}={}){
 if(typeof policy!=='function'||policy(task,input)?.impact!=='bounded')return null;
 const revision=version(task),value=Object.freeze({assertCurrent(){
  if(signal?.aborted||!isCurrent()||version(task)!==revision||task.state?.stopRequest||['stopped','stopping','expired','completed','failed','cancelled'].includes(task.status)||policy(task,input)?.impact!=='bounded')throw fail('原视觉动作的目标、权限或任务状态已变化');
 }});visualContexts.add(value);return value;
}
function checkVisualContext(value){if(!value||!visualContexts.has(value))return false;value.assertCurrent();return true;}
function activeVisualContext(){const value=active();if(!value?.task?.authority?.verified)return null;return visualContext(value.task,value.input,{policy:value.tool?.continuationPolicy||boundedPolicy,isCurrent:value.isCurrent,signal:value.signal});}
function evidenceFor(task,operation,ids,at){
 if(!Array.isArray(ids)||!ids.length||ids.length>8)throw fail('需要原输入之后的新鲜只读观察');
 const observations=ids.map(id=>task.operations?.[id]);
 if(observations.some(op=>!op||op===operation||op.effect!=='read'||op.kind==='model'||op.status!=='confirmed'||require('./boper-outcome').hasEffects(op.inputOutcome)||!(op.observation?.frameId||op.observation?.observationId||op.result?.frameId||op.result?.observationId)||!Number.isFinite(op.finishedAt)||op.finishedAt<=(operation.at||0)||op.finishedAt>at||at-op.finishedAt>60000))throw fail('核对依据必须是本Task原输入后的60秒内纯只读实际观察');
 return ids.slice();
}
function assess(task,operation,{outcome='unresolved',basis,evidenceOperationIds,continuation}={}, {policy,at=Date.now(),hostEvidence}={}){
 if(!operation||!['applied','not_applied','unresolved'].includes(outcome))throw fail('原Operation或效果判断无效');
 const evidence=hostEvidence?hostEvidence:evidenceFor(task,operation,evidenceOperationIds,at);
 if(hostEvidence&&(!hostEvidence.frameId||!Number.isFinite(hostEvidence.at)||hostEvidence.at<(operation.at||0)||hostEvidence.at>at||at-hostEvidence.at>60000))throw fail('宿主画面已过期');
 basis=statement(basis,'效果判断');
 const profile=typeof policy==='function'?policy():policy;if(!profile||profile.impact!=='bounded')throw fail('此工具或原任务不允许接受重复风险继续');
 if(operation.inputOutcome?.releaseConfirmed===false)throw fail('原生按键或鼠标释放尚未确认，先处理输入设备状态');
 const review={id:randomUUID(),operationId:operation.id,outcome,basis,evidence:structuredClone(evidence),at,version:version(task),trust:'bunny-assessment',possibleDuplicate:outcome!=='applied'};
 if(continuation){
  if(continuation.goalNotMet!==true||continuation.acceptPossibleDuplicate!==true)throw fail('续行必须明确目标未达到并接受可能重复的可控影响');
  const next=continuation.next;if(!next||typeof next.key!=='string'||!next.key||next.key===operation.key||next.key.length>200||!next.tool||!next.args)throw fail('续行需要不同于旧key的新Operation及实际参数');
  const count=Object.values(task.operations||{}).flatMap(op=>op.effectReviews||[]).filter(r=>r.version===review.version&&r.continuation).length;
  if(count>=Math.min(2,profile.maxContinuations||1))throw fail('本轮可控续行次数已到，请继续观察或改变整体策略');
  review.continuation={next:structuredClone(next),hash:hash(next),strategy:statement(continuation.strategy,'新策略'),duplicateImpact:statement(continuation.duplicateImpact,'可能重复的影响'),status:'issued',expiresAt:at+60000};
 }
 operation.effectReviews=[...(operation.effectReviews||[]),review].slice(-8);operation.effectReview=review;return review;
}
function current(task,review){return review?.version===version(task)&&!task.state?.stopRequest&&!['stopped','expired','stopping'].includes(task.status);}
function permits(task,operation,call,at=Date.now()){
 const review=operation.effectReview,c=review?.continuation;
 return current(task,review)&&c?.status==='issued'&&c.expiresAt>=at&&c.hash===hash(call);
}
function accepted(task,operation){
 const review=operation.effectReview;if(!current(task,review))return false;
 if(review.outcome==='applied')return true;
 const c=review.continuation,next=c?.operationId&&task.operations?.[c.operationId];
 return c?.status==='consumed'&&next?.status==='confirmed';
}
function consume(task,operation,call,nextId,at=Date.now()){
 if(!permits(task,operation,call,at))throw fail('续行记录已消费、过期或目标权限已变化');
 Object.assign(operation.effectReview.continuation,{status:'consumed',operationId:nextId,consumedAt:at});
 return operation.effectReview.id;
}
function scope(fields,invoke){return context.run(fields,invoke);}
function active(){return context.getStore();}
module.exports={assess,accepted,permits,consume,evidenceFor,boundedPolicy,visualContext,checkVisualContext,activeVisualContext,version,current,scope,active,hash};
