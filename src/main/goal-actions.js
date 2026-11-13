'use strict';
const crypto=require('node:crypto');
const {checkedJSON}=require('./agent-json');
const {clone}=require('./agent-contract');
const {deliverResult}=require('./result-delivery');
const SCHEMA='bunny.goal-actions/v1';
const readOnly=tool=>tool?.effect==='read'&&!tool.capabilities?.includes('screen.input');
function nextReadOnly(run,tools){
 const next=run.operations?.[run.operationIndex||0]||run.execution?.pendingDecision||run.execution?.pendingSteps?.[0];
 return !next||readOnly(tools.get(next.tool));
}
const terminal=run=>['completed','cancelled'].includes(run.status);
const actionId=(task,key)=>crypto.createHash('sha256').update(task.id+'\0goal-action\0'+(task.state.goalRevision||0)+'\0'+key).digest('hex');
const text=(v,name,max=1800)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(name+'不合法');return v.trim();};
const fail=message=>Object.assign(Error(message),{code:'E_ACTION_PLAN',dispatched:false});
function uncertain(op){return require('./operation-ledger').hasUncertainEffect?.(op)??(op.effect==='write'&&op.status==='intent');}
function pathValue(value,path){
 if(typeof path!=='string'||path.length>240||!path||path.split('.').some(k=>!/^([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)$/.test(k)||['__proto__','prototype','constructor'].includes(k)))throw fail('结果路径不合法');
 return path.split('.').reduce((v,k)=>v!=null&&Object.hasOwn(v,k)?v[k]:undefined,value);
}
function resolveArgs(value,results){
 if(Array.isArray(value))return value.map(v=>resolveArgs(v,results));
 if(value&&typeof value==='object'){
  if(Object.keys(value).length===1&&Object.hasOwn(value,'$result')){
   const ref=text(value.$result,'结果引用',300),dot=ref.indexOf('.'),key=dot<0?ref:ref.slice(0,dot);
   if(!Object.hasOwn(results,key))throw fail('引用的Operation尚无实际结果');
   const found=dot<0?results[key]:pathValue(results[key],ref.slice(dot+1));if(found===undefined)throw fail('结果引用不存在');return clone(found);
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>{if(['__proto__','prototype','constructor'].includes(k))throw fail('参数字段不合法');return [k,resolveArgs(v,results)];}));
 }
 return value;
}
function recordResult(task,result,application){
 const image=result?.preview?result:result?.observation?.preview?result.observation:null;
 if(image)task.state.latestImage={preview:image.preview,application,frameId:image.frameId,width:image.width,height:image.height,at:image.at};
 const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['preview','pngBase64'].includes(k)).map(([k,v])=>[k,strip(v)])):value;
 return strip(result);
}
function operations(value,catalog,validateCall){
 if(!Array.isArray(value)||value.length>20)throw fail('Action只接受至多20个连续Operation');const keys=new Set();
 return value.map((op,i)=>{
  if(!op||Object.keys(op).some(k=>!['key','tool','args'].includes(k)))throw fail('Operation字段不合法');
  const key=op.key||'step-'+i;text(key,'Operation标识',100);if(keys.has(key))throw fail('Operation标识重复');keys.add(key);
  if(!catalog.some(t=>t.name===op.tool)||!op.args||typeof op.args!=='object'||Array.isArray(op.args))throw fail(['result.deliver','result.attach'].includes(op.tool)?'成果交付尚未就绪；工作完成、只差Task.delivery最终交付时输出done:true和summary，由宿主回收成果并自动交付':'Operation必须使用当前获准工具');
  if(!JSON.stringify(op.args).includes('"$result"'))validateCall?.(op.tool,op.args);
  return {key,tool:op.tool,args:clone(op.args)};
 });
}
function planState(task){
 const state=task.state.goalPlan;
 if(!state||state.schema!==SCHEMA||state.goalRevision!==(task.state.goalRevision||0))return null;
 return state;
}
function condition(task,run){
 if(!run.after)return true;
 const source=Object.values(task.actionRuns).find(r=>r.goalAction&&r.goalRevision===run.goalRevision&&r.key===run.after.actionKey);
 if(!source||!source.resultRevision||source.resultRevision<=(run.consumedRevision||0))return false;
 const result=run.after.operationKey?source.results?.[run.after.operationKey]:source.results;
 return JSON.stringify(pathValue(result,run.after.path))===JSON.stringify(run.after.equals);
}
function selected(task,now=Date.now()){
 const plan=planState(task);
 if(!plan||plan.needsPlanning||plan.legacy)return {phase:'goal.plan:'+(task.state.goalRevision||0)};
 const runs=Object.values(task.actionRuns).filter(r=>r.goalAction&&r.goalRevision===plan.goalRevision&&!terminal(r)&&!Object.values(task.operations).some(op=>op.actionId===r.id&&uncertain(op)));
 const eligible=runs.filter(r=>!['needs_attention','waiting_permission','paused','running'].includes(r.status)&&!(r.schedule?.at>now)&&!(r.resourceWait?.nextAt>now)&&condition(task,r)&&!r.recoveryState?.mainReview?.hold);
 // Event replies still enter through the same Runtime and precede goal work.
 const run=eligible.sort((a,b)=>(a.schedule?.at||0)-(b.schedule?.at||0)||a.createdAt-b.createdAt)[0];
 if(run)return {phase:'goal.action:'+run.key,id:run.id,scope:run.scope||null};
 if(!runs.length)return {phase:'goal.plan:'+(task.state.goalRevision||0)};
 return {phase:null};
}
function nextWake(task,now=Date.now()){
 const plan=planState(task);if(!plan||plan.needsPlanning)return now;
 let next=Infinity;
 for(const run of Object.values(task.actionRuns))if(run.goalAction&&run.goalRevision===plan.goalRevision&&!terminal(run)&&!['needs_attention','waiting_permission','paused','running'].includes(run.status)&&!Object.values(task.operations).some(op=>op.actionId===run.id&&uncertain(op))&&condition(task,run))next=Math.min(next,Math.max(run.schedule?.at||now,run.resourceWait?.nextAt||0));
 return next;
}
function actionSummary(run){return {id:run.id,key:run.key,goal:run.goal,criteria:run.criteria,strategy:run.strategy,status:run.status,schedule:run.schedule,after:run.after,cycle:run.cycle,results:run.results,resultRevision:run.resultRevision,lastFailure:run.lastFailure,operations:run.operations,resourceWait:run.resourceWait,trigger:run.trigger,summary:run.summary,execution:run.execution};}
function validatePlan(value,ctx){
 if(!value||typeof value!=='object'||typeof value.done!=='boolean')throw fail('缺少Task规划结论');
 if(value.selfSuspension){if(value.done||!require('./main-review').assessment(value.selfSuspension)?.assessmentSummary||!require('./main-review').assessment(value.selfSuspension)?.requestedHelp)throw fail('自我挂起需要明确判断和主脑求助');return value;}
 if(value.reassemble){const change=require('./context-assembler').contextAdjustment(value.reassemble);if(!['knowledge','budget'].includes(change.fragment))throw fail('Task规划仅可调整可选经验或请求预算');return value;}
 if(!value.done&&value.tool&&value.actions===undefined){operations([{key:'step',tool:value.tool,args:value.args}],ctx.availableTools,ctx.validateCall);return {...value,legacyDecision:true};}
 if(value.done){text(value.summary,'完成结论',600);return value;}
 if(!Array.isArray(value.actions)||!value.actions.length||value.actions.length>12)throw fail('规划须包含1至12个有目标的Action');const keys=new Set();
 value.actions=value.actions.map(a=>{
  if(!a||Object.keys(a).some(k=>!['key','goal','criteria','strategy','operations','schedule','after','scope'].includes(k)))throw fail('Action字段不合法');
  const key=text(a.key,'Action标识',100);if(!/^[a-zA-Z0-9_.:-]+$/.test(key)||keys.has(key))throw fail('Action标识无效或重复');keys.add(key);
  const result={key,goal:text(a.goal,'Action目标'),criteria:text(a.criteria,'Action验收条件'),strategy:text(a.strategy||'依据最新结果自主推进','Action策略'),operations:operations(a.operations||[],ctx.availableTools,ctx.validateCall)};
  if(a.scope!==undefined)result.scope=text(a.scope,'Action范围',200);
  if(a.schedule){
   if(Object.keys(a.schedule).some(k=>!['at','intervalSeconds'].includes(k))||!Number.isFinite(a.schedule.at)||a.schedule.at<0)throw fail('Action时间无效');
   result.schedule={at:a.schedule.at};
   if(a.schedule.intervalSeconds!==undefined){if(!Number.isFinite(a.schedule.intervalSeconds)||a.schedule.intervalSeconds<1||a.schedule.intervalSeconds>86400)throw fail('重复间隔无效');result.schedule.intervalSeconds=a.schedule.intervalSeconds;
    if(!result.operations.length||result.operations.some(op=>!readOnly(ctx.availableTools.find(t=>t.name===op.tool))))throw fail('重复Operation必须是明确的只读检查，输入/导航不可定时重放');}
  }
  if(a.after){if(Object.keys(a.after).some(k=>!['actionKey','operationKey','path','equals'].includes(k))||!Object.hasOwn(a.after,'equals')||a.after.equals!==null&&!['string','number','boolean'].includes(typeof a.after.equals))throw fail('结果条件仅接受实际字段与标量等值');result.after={actionKey:text(a.after.actionKey,'前序Action',100),path:text(a.after.path,'实际结果字段',240),equals:a.after.equals,...(a.after.operationKey?{operationKey:text(a.after.operationKey,'前序Operation',100)}:{})};pathValue({},result.after.path);}
  return result;
 });
 if(value.cancelActions!==undefined&&(!Array.isArray(value.cancelActions)||value.cancelActions.length>12||value.cancelActions.some(k=>typeof k!=='string'||!k||k.length>100)))throw fail('取消Action列表无效');
 const all=new Set([...value.actions.map(a=>a.key),...Object.values(ctx.task.actionRuns).filter(r=>r.goalAction).map(r=>r.key)]);
 for(const a of value.actions)if(a.after&&(!all.has(a.after.actionKey)||a.after.actionKey===a.key))throw fail('结果条件须引用其它已声明Action');
 const edges=new Map(value.actions.filter(a=>a.after).map(a=>[a.key,a.after.actionKey]));
 for(const key of edges.keys()){const seen=new Set();let cursor=key;while(edges.has(cursor)){if(seen.has(cursor))throw fail('Action结果条件不能循环依赖');seen.add(cursor);cursor=edges.get(cursor);}}
 return value;
}
async function completeTask(ctx,decision){
 const {task}=ctx;
 // Completion is Bunny's assessment; an unresolved effect still cannot be
 // silently turned into a delivered success or replay permission.
 require('./operation-ledger').reconcileNavigationOnCompletion(task,{at:ctx.clock(),basis:decision.summary});
 if(Object.values(task.operations).some(op=>require('./operation-ledger').hasBlockingEffect(task,op)))throw Object.assign(Error('原操作效果仍待明确评估；先观察或登记可控续行，不重放旧key'),{code:'E_SUBMISSION_UNCERTAIN',dispatched:false});
 const known=[...(task.state.knownArtifacts||[]),...(task.state.attempts||[]).flatMap(a=>a.result?.result?.artifacts||a.result?.artifactManifest?.files||[])];
 const artifacts=(decision.artifacts||[]).map(f=>known.find(k=>k.path===f.path&&k.sha256===f.sha256)).filter(Boolean);
 task.state.result={schema:'bunny.result/v1',revision:1,summary:decision.summary,text:decision.summary,artifacts,collectedAt:ctx.clock()};
 await ctx.checkpoint();await deliverResult(ctx);return {status:'completed',note:decision.summary,state:task.state};
}
async function plan(ctx,{request,initialObservation,baseRun}={}){
 const {task,checkpoint,signal}=ctx;
 if(task.state.result){await deliverResult(ctx);return {status:'completed',note:task.state.result.summary,state:task.state};}
 if((task.state.stepSequence||0)-(task.state.explorationStart||0)>=64){task.state.explorationReview={from:task.state.explorationStart||0,to:task.state.stepSequence,instruction:'检查近期步骤是否推进原目标，结合真实结果修订策略'};task.state.explorationStart=task.state.stepSequence;}
 task.state.goalPlan??={schema:SCHEMA,goalRevision:task.state.goalRevision||0,revision:0};
 if(!planState(task))task.state.goalPlan={schema:SCHEMA,goalRevision:task.state.goalRevision||0,revision:0};
 const state=task.state.goalPlan;
 if(!state.observed&&initialObservation){
  await initialObservation({...ctx,call:async operation=>{
   const result=await ctx.call(operation),entry=Object.values(task.operations).filter(op=>op.key===operation.key&&op.tool===operation.tool).at(-1);
   const observation={tool:operation.tool,target:{application:operation.args?.application,...(operation.args?.recipient?{recipient:operation.args.recipient}:{})},operationId:entry?.id,at:ctx.clock(),result:recordResult(task,result,operation.args?.application)};
   state.observations=[...(state.observations||[]),observation].slice(-8);return result;
  }});state.observed=true;await checkpoint();
 }
 const assembler=require('./context-assembler');
 const assembled=await assembler.assembleContext({purpose:'task.actions',signal,configuration:task.state.contextTuning,fragments:[
  {id:'core',required:true,load:async()=>({taskTiming:require('./operation-evidence').taskTiming(task,ctx.clock()),observationSources:require('./operation-evidence').conversationSources(task),taskId:task.id,goal:task.workRequest?.goal||task.goal,criteria:task.workRequest?.criteria||task.criteria,ownerRequest:task.state.ownerRequest,context:task.context,resultContracts:ctx.resultContracts||[],policy:task.policy,parameters:task.parameters,subjects:task.subjects,completion:task.completion,delivery:task.delivery,now:ctx.clock(),interactionChannels:require('./interaction-policy').context(task),conversations:task.state.conversations,observations:state.observations||[],explorationReview:task.state.explorationReview,attempts:task.state.attempts||[],pendingObservation:task.state.pendingObservation,currentFrame:task.state.latestImage?{application:task.state.latestImage.application,frameId:task.state.latestImage.frameId,width:task.state.latestImage.width,height:task.state.latestImage.height,at:task.state.latestImage.at}:null,goalRevision:task.state.goalRevision||0,actions:Object.values(task.actionRuns).filter(r=>r.goalAction).slice(-24).map(actionSummary),operations:Object.values(task.operations).slice(-16),effectFacts:require('./operation-evidence').effectFacts(task.operations),recovery:ctx.recovery||task.state.recoveryGuidance,recoveryGuidance:ctx.recovery||task.state.recoveryGuidance,lastFailure:task.state.lastFailure})},
  {id:'tools',required:true,load:async()=>ctx.availableTools},
  {id:'knowledge',parameters:{limit:5,maxTokens:4500},load:async p=>assembler.experienceContext(task,{mode:'full',maxTokens:p.maxTokens,maxItems:p.limit})}
 ]});
 const response=await require('./task-model-trace').scope({knowledgeRefs:(assembled.values.knowledge||[]).map(k=>({sourceId:k.sourceId,packageId:k.packageId,revision:k.revision,version:k.version}))},()=>checkedJSON({signal,timeoutMs:90000,maxTokens:8192,repairProfile:task.state.selfRepair?.profile,inputBudgetTokens:assembled.metadata.inputBudgetTokens,messages:[{role:'system',content:require('./action-progress').GUIDANCE+'你是Bunny的任务脑。Task保存主人的持续目标；需要主脑整体评估时可输出{done:false,selfSuspension:{assessmentSummary:当前卡点,basisRefs:[],attemptedPaths:[],remainingUncertainty:未知处,requestedHelp:具体求助}}，保存原目标与实际效果；预算耗尽不能冒充业务失败。Action是可独立推进和验收的小目标，每个Action可多轮思考和多个Operation，不能把每次点击当Action。结合完整目标、真实回执和经验规划/修订多个Action；策略须落实为不同的真实工具和参数，不能只是改措辞。授权仅来自原Task。若有在途或未知效果，先依据新观察判断；effect.reconcile可整理已完成导航，可信工具允许时可明确接受可控重复影响后选新策略/新key继续。保留原unknown，不重放旧Operation；资金/破坏性/凭据风险不适用。先看当前观察，不强制打开已经可见的界面。不同职责可独立安排，不因一个GUI操作等待而停止感知。输出严格JSON {"done":false,"actions":[{"key":"稳定标识","goal":"小目标","criteria":"由你根据实际结果判断的验收条件","strategy":"下一策略","operations":[{"key":"稳定步骤","tool":"当前工具","args":{}}]}]}。Action可先只有goal/criteria，唤醒后按最新结果再规划Operations；未来画面未知时不要预填坐标/正文。一次规划可安排多个确定Operation，引用同Action前面实际结果用唯一字段对象{"$result":"步骤key.frameId"}；不写程序。可选schedule:{at:绝对毫秒时间,intervalSeconds:1至86400}，定时像素观察使用screen.observe的稳定sampleId，随后screen.commit带同sampleId提交基线；条件的operationKey引用observe而非commit。定时重复仅用于已明确的只读检查，不积压错过的tick；静止复用Operation无需模型，每次结果路由到after:{actionKey:"来源",operationKey:"来源步骤",path:"changed",equals:true}唤醒另一Action做语义判断。条件仅路由实际结果，不是业务验收。可用cancelActions:[旧key]撤下已不适用的Action，不能抹去任何旧效果，也不能撤下未知输入来绕过核验。不要循环依赖。你对完整Task目标和行为结果负责，自主安排观察、评估与纠偏；完成依据已有上下文、实际回执和适用反馈，不为凑工具次数额外操作。可以小步尝试并结合结果调整；输入回执本身不等于业务成功。持续监看Action可保留定时；delivery是宿主在Task done后交付summary和实际成果的渠道，不是另一个conversation.send目标。问询、制作等工作已完成、只差Task.delivery指定的最终交付时，就输出done:true和summary；宿主先保存Task.state.result，再按原delivery自动交付，交付完成后才进入Task完成审查。不要另建交付Action，不为交付对象扩大subjects，也不要在summary提前声称已交付。工作目标已满足时依据实际结果输出{"done":true,"summary":"实际结论"}。可输出{done:false,reassemble:{fragment:knowledge,detail:full,limit:5,maxTokens:4500}}调整可选经验，或fragment:budget与inputBudgetTokens调整下一轮请求额度；不得修改必需目标、授权、已确认结果。不要重新创建Task，不覆盖主人的目标/权限。'},{role:'user',content:[{type:'text',text:JSON.stringify({...assembled.values.core,tools:assembled.values.tools,knowledge:assembled.values.knowledge,contextAssembly:assembled.metadata})},...(task.state.latestImage?.preview?[{type:'image_url',image_url:{url:task.state.latestImage.preview}}]:[])]}]},v=>validatePlan(v,ctx),request?{request}:{}));
 if(signal?.aborted||!ctx.isLive())throw Object.assign(Error('Task规划已取消'),{code:'ABORT_ERR',dispatched:false});
 assembler.consumeInputBudget(task,assembled.metadata.inputBudgetTokens);
 const decision=response.value;
 if(decision.selfSuspension)return {status:'paused',selfSuspension:decision.selfSuspension,assessment:decision.assessment,consumeEvent:false,state:task.state};
 if(decision.reassemble){require('./context-assembler').applyContextAdjustment(task,decision.reassemble);await checkpoint();return {status:'waiting',note:'已调整上下文，继续原目标',nextCheckAt:ctx.clock(),state:task.state};}
 if(decision.legacyDecision&&baseRun){state.legacy=true;task.state.pendingDecision=decision;return baseRun(ctx);}
 if(decision.done)return completeTask(ctx,decision);
 const revision=state.revision+1;
 for(const key of decision.cancelActions||[]){const existing=task.actionRuns[actionId(task,key)];if(existing&&existing.status!=='running'&&!Object.values(task.operations).some(op=>op.actionId===existing.id&&uncertain(op))){existing.status='cancelled';existing.cancelledAt=ctx.clock();existing.cancellationReason='task-replanned';}}
 for(const definition of decision.actions){
  const id=actionId(task,definition.key),existing=task.actionRuns[id];
  if(existing?.status==='completed')continue;
  if(existing&&Object.values(task.operations).some(op=>op.actionId===id&&uncertain(op)))continue;
  if(existing&&!terminal(existing)&&existing.execution?.pendingDecision)delete existing.execution.pendingDecision;
  // Completed effects remain history; an explicitly revised Action advances a
  // new execution round, never overwrites or reuses an earlier effect key.
  task.actionRuns[id]={...existing,...clone(definition),id,goalAction:true,goalRevision:task.state.goalRevision||0,planRevision:revision,status:'waiting',createdAt:existing?.createdAt||ctx.clock(),attempts:existing?.attempts||0,cycle:existing?.cycle||0,round:(existing?.round||0)+1,operationIndex:0,results:existing?.results||{},strategyHistory:[...(existing?.strategyHistory||[]),...(existing?[{goal:existing.goal,criteria:existing.criteria,strategy:existing.strategy,planRevision:existing.planRevision,at:ctx.clock()}]:[])].slice(-8),execution:{},updatedAt:ctx.clock()};
 }
 state.history=[...(state.history||[]),{revision,at:ctx.clock(),actionKeys:decision.actions.map(a=>a.key),cancelActions:decision.cancelActions||[]}].slice(-12);
 Object.assign(state,{revision,needsPlanning:false,plannedAt:ctx.clock()});await checkpoint();
 return {status:'waiting',note:'已保存持续目标与Action安排',nextCheckAt:nextWake(task,ctx.clock()),state:task.state};
}
async function execute(ctx,baseRun,options){
 const {task,action,checkpoint}=ctx;
 if(!action?.goalAction){if(task.state.goalPlan?.legacy)return baseRun(ctx);if(selected(task,ctx.clock()).phase===null)return {status:'waiting',note:'等待已安排的Action或实际结果条件',nextCheckAt:nextWake(task,ctx.clock()),state:task.state};return plan(ctx,{...options,baseRun});}
 action.results??={};action.operationIndex??=0;
 if(ctx.recovery&&['reobserve','change_method'].includes(ctx.recovery.action)&&!Object.values(task.operations).some(op=>op.actionId===action.id&&uncertain(op))){
  const pending=action.operations?.[action.operationIndex],prior=pending&&Object.values(task.operations).find(op=>op.actionId===action.id&&op.key==='goal:'+action.id+':'+action.cycle+':'+pending.key);
  if(prior?.status==='not_dispatched'){action.operations=[];action.operationIndex=0;action.execution={};action.strategy=ctx.recovery.nextStep||ctx.recovery.action;}
 }
 if(action.after&&!action.trigger){const source=Object.values(task.actionRuns).find(r=>r.goalAction&&r.key===action.after.actionKey&&r.goalRevision===action.goalRevision);action.trigger={actionKey:source.key,resultRevision:source.resultRevision,results:clone(source.results)};await checkpoint();}
 while(action.operationIndex<(action.operations||[]).length){
  const op=action.operations[action.operationIndex],args=resolveArgs(op.args,action.results);
  ctx.validateCall(op.tool,args);
  const result=await ctx.call({tool:op.tool,key:'goal:'+action.id+':'+action.cycle+':'+op.key,...(op.tool==='conversation.send'?{eventKey:'goal:'+action.id}:{}),args});
  if(!ctx.isLive())throw Object.assign(Error('Action已取消'),{code:'ABORT_ERR',dispatched:false});
  action.results[op.key]=recordResult(task,result,args.application);action.operationIndex++;
  task.state.attempts=[...(task.state.attempts||[]),{step:task.state.stepSequence||0,actionId:action.id,tool:op.tool,args,result:clone(action.results[op.key])}].slice(-12);task.state.stepSequence=(task.state.stepSequence||0)+1;await options.onResult?.(ctx,op,result);await checkpoint();
 }
 if(action.operations?.length&&action.evaluatedRound!==action.round+':'+action.cycle){
  action.resultRevision=(action.resultRevision||0)+1;action.resultAt=ctx.clock();action.evaluatedRound=action.round+':'+action.cycle;
  if(action.after){const source=Object.values(task.actionRuns).find(r=>r.goalAction&&r.key===action.after.actionKey&&r.goalRevision===action.goalRevision);action.consumedRevision=action.trigger?.resultRevision||source?.resultRevision||action.consumedRevision;}
  if(action.schedule?.intervalSeconds){
   if(Object.values(task.operations).some(op=>op.actionId===action.id&&uncertain(op)))throw Object.assign(Error('重复检查存在未确认输入，停止重放'),{code:'E_SUBMISSION_UNCERTAIN',dispatched:false});
   action.cycle++;action.operationIndex=0;action.schedule.at=ctx.clock()+action.schedule.intervalSeconds*1000;await checkpoint();return {status:'waiting',note:'已完成只读定时检查，等待变化或下次检查',waitReason:'timer',nextCheckAt:nextWake(task,ctx.clock()),state:task.state};
  }
 }
 return baseRun({...ctx,action,onTaskReplan:async reason=>{task.state.goalPlan.needsPlanning=true;delete task.state.goalPlan.legacy;action.execution={};action.replanReason=reason;await checkpoint();return {status:'waiting',note:'保留Action与实际效果，重新安排原Task',nextCheckAt:ctx.clock(),state:task.state};},onOperationResult:(op,result)=>options.onResult?.(ctx,op,result),onActionDone:async(summary,decision)=>{
  if(decision?.taskDone===true){const result=await completeTask(ctx,decision);action.status='completed';action.summary=summary;action.completedAt=ctx.clock();return {...result,actionComplete:true};}
  action.status='completed';action.summary=summary;action.completedAt=ctx.clock();
  if(action.after){const source=Object.values(task.actionRuns).find(r=>r.goalAction&&r.key===action.after.actionKey&&r.goalRevision===action.goalRevision);action.consumedRevision=action.trigger?.resultRevision||source?.resultRevision||action.consumedRevision;action.status='waiting';action.operations=[];action.operationIndex=0;action.cycle++;action.execution={};delete action.trigger;}
  if(decision?.reviewTask||!Object.values(task.actionRuns).some(r=>r.goalAction&&r.goalRevision===action.goalRevision&&!terminal(r)))task.state.goalPlan.needsPlanning=true;
  await checkpoint();return {status:'waiting',actionComplete:action.status==='completed',note:summary,nextCheckAt:nextWake(task,ctx.clock()),state:task.state};
 }});
}
function withGoalActions(skill,options={}){
 const base=skill.run;
 return {...skill,goalDirected:true,actionSelection:(task,now)=>selected(task,now),actionNextWake:nextWake,run:ctx=>execute(ctx,base,options)};
}
function returnedCompletion(task){return task.state?.completionProposal?.status==='returned'&&task.state.recoveryGuidance?.reviewedResult?.proposalId===task.state.completionProposal.id;}
function remediationSkill(skill,{request}={}){
 const adaptive=require('./adaptive-task').adaptiveSkill({...skill,request,goalActions:false});
 const goal=withGoalActions({...skill,run:adaptive.run},{request});
 return {...goal,run:ctx=>{
  const used=new Set(Object.values(ctx.task.operations).map(op=>op.tool));
  const resultContracts=ctx.availableTools.filter(tool=>used.has(tool.name)&&tool.resultContract).map(({name,description,resultContract})=>({name,description,resultContract:clone(resultContract)}));
  // A Skill can declare that its completed business effect consumes its one
  // authorization. Other goals (e.g. correcting a document) retain their
  // existing allowed writes; remediation never grants capabilities.
  const blocked=new Set(skill.repeatConfirmedEffects===false?Object.values(ctx.task.operations).filter(op=>op.effect==='write'&&op.status==='confirmed'&&skill.tools.includes(op.tool)).map(op=>op.tool):[]);
  const check=name=>{if(blocked.has(name))throw Object.assign(Error('本次单次写入已确认；整改不得换key重复该业务效果'),{code:'E_CONFIRMED_EFFECT',dispatched:false});};
  return goal.run({...ctx,resultContracts,availableTools:ctx.availableTools.filter(tool=>!blocked.has(tool.name)),validateCall:(name,args)=>{check(name);return ctx.validateCall(name,args);},call:operation=>{check(operation.tool);return ctx.call(operation);}});
 }};
}
function registerGoalTools(tools,{reconcile}){
 tools.register({name:'effect.reconcile',description:'依据本Task输入后60秒内confirmed纯只读观察显式核对原Operation。导航可登记applied/not_applied；可信工具声明的可控业务效果可按新观察判断applied，仍保留旧原生unknown历史。没有实际成功依据时业务未知保留unresolved。工具声明支持受控续行时，可附continuation:{goalNotMet:true,acceptPossibleDuplicate:true,duplicateImpact:"可能重复的具体可控影响",strategy:"实际换路",next:{tool:"获准工具",key:"不同于原key的新key",args:{}}}申请一次新Operation；原unknown及回执保留，旧key永不重放。原权限/正文/对象不变；资金、破坏性、凭据、隐私或未知重大影响不得套用。参数operationId/outcome/evidenceOperationIds/basis，只读核对不需等待上级审批。',effect:'read',capabilities:[],
  validate:v=>{if(!v||Object.keys(v).some(k=>!['operationId','outcome','evidenceOperationIds','basis','continuation'].includes(k))||!['applied','not_applied','unresolved'].includes(v.outcome)||!Array.isArray(v.evidenceOperationIds)||v.evidenceOperationIds.length>8||v.continuation&&v.outcome!=='unresolved')throw fail('效果核对参数无效');return {operationId:text(v.operationId,'原Operation',150),outcome:v.outcome,evidenceOperationIds:v.evidenceOperationIds.map(id=>text(id,'观察Operation',150)),basis:text(v.basis,'核对依据',1200),...(v.continuation?{continuation:clone(v.continuation)}:{})};},
  execute:(args,{task,signal})=>reconcile(task.id,args,{signal})});
}
function upgrade(task,now=Date.now()){
 const supported=['software.execute','system.operate'].includes(task.skill)||task.skill==='conversation.manage'&&task.parameters.behavior==='inquiry';if(!supported)throw fail('本任务未使用目标Action执行器');
 const previous=task.state.goalPlan;delete task.state.pendingDecision;task.state.goalPlan={schema:SCHEMA,goalRevision:task.state.goalRevision||0,revision:previous?.revision||0,needsPlanning:true,migratedAt:now};
 // The Task goal, cursor, all receipts and unknown effects are deliberately kept.
 for(const run of Object.values(task.actionRuns))if(!run.goalAction&&!terminal(run)&&!Object.values(task.operations).some(op=>op.actionId===run.id&&uncertain(op))){run.status='cancelled';run.migrationReason='goal-actions';}
 return {ok:true,id:task.id,goalMode:true,unknownEffects:Object.values(task.operations).filter(uncertain).length};
}
module.exports={registerGoalTools,recordResult,readOnly,nextReadOnly,plan,SCHEMA,actionId,selected,nextWake,withGoalActions,returnedCompletion,remediationSkill,upgrade,resolveArgs,validatePlan,actionSummary};
