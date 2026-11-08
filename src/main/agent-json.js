'use strict';
const {parseStrictJson}=require('./strict-json');
const {requestVerification}=require('./verification-transport');
function modelJSON(text){
  let body=String(text||'').trim();
  const fenced=/^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(body);
  if(fenced)body=fenced[1].trim();
  return parseStrictJson(body);
}
async function checkedJSON(options,validate,{request=requestVerification,onRequestDiagnostic,repairInstructions}={}){
  options=require('./self-repair').applyProfile(options,options.repairProfile);
  let error,retryOptions,recoveryReason;const messages=options.messages.map(m=>({...m}));const system=messages.find(m=>m.role==='system'&&typeof m.content==='string');if(system){if(!system.content.includes('# Bunny'))system.content=require('./bunny-principles')+'\n'+system.content;}else messages.unshift({role:'system',content:require('./bunny-principles')});
  for(let attempt=0;attempt<2;attempt++){
    if(options.signal?.aborted)throw new Error('任务已取消');
    const requestOptions={...(retryOptions||options),messages,singleAttempt:true,...(recoveryReason?{recoveryReason}:{})};
    const began=Date.now(),report=(phase,completion,errorCode,budget,transport,schemaAudit)=>{try{onRequestDiagnostic?.({attempt:attempt+1,phase,elapsedMs:Date.now()-began,...(Number.isSafeInteger(requestOptions.maxTokens)?{requestedMaxOutputTokens:requestOptions.maxTokens}:{}),...(Number.isSafeInteger(requestOptions.inputBudgetTokens)?{requestedInputBudgetTokens:requestOptions.inputBudgetTokens}:{}),...(completion?{completion}:{}),...(budget?{budget}:{}),...(transport?{transport}:{}),...(schemaAudit?{schemaAudit}:{}),...(/^E_[A-Z0-9_]{1,60}$/u.test(errorCode||'')?{errorCode}:{})});}catch{}};
    report('started');
    let checked;
    try{
      checked=await request(requestOptions);
      const response=checked.response||{};
      const diagnostic=require('./self-repair').diagnostic({budget:response.contextBudget,completion:{model:response.model||checked.model,maxOutputTokens:response.contextBudget?.output,finishReason:response.finishReason,usage:response.usage}});
      report('completed',diagnostic?.completion,undefined,diagnostic?.budget);
    }catch(e){
      const diagnostic=require('./self-repair').diagnostic({...e.diagnostic,completion:{...e.diagnostic?.completion,...(e.finishReason?{finishReason:e.finishReason}:{}),...(e.usage?{usage:e.usage}:{}),...(typeof e.hasReasoning==='boolean'?{hasReasoning:e.hasReasoning}:{})}});
      if(diagnostic)e.diagnostic=diagnostic;
      report('failed',diagnostic?.completion,e.code,diagnostic?.budget,diagnostic?.transport);
      const transient=require('./workbuddy').isTransientConnectionError?.(e)||/timeout|超时|network|连接|fetch failed|ECONNRESET|ETIMEDOUT/iu.test(e.message||'');
      const repaired=require('./self-repair').responseRecovery(requestOptions,e);
      if(!(transient||repaired)||attempt>0||options.signal?.aborted)throw e;
      retryOptions=repaired||requestOptions;recoveryReason=e.code;
      if(repaired){const reminder='上次回答'+(e.code==='E_PAYLOAD_TOO_LARGE'?'超过转发字节限制，本次缩减输出和推理预算':'达到token额度上限，本次提高输出额度')+'。保留同一份证据与目标，仅返回所需完整JSON；依据写简短结论，不复述输入、不展开推理过程，不添加其它内容。';if(system)system.content+='\n'+reminder;else messages.unshift({role:'system',content:reminder});}
      await new Promise(r=>setTimeout(r,500));continue;
    }
    try{const value=await validate(modelJSON(checked.response.text));report('validated');return {value,model:checked.model,attempts:attempt+1};}
    catch(e){
      error=e;
      const schemaAudit=require('./self-repair').diagnostic({schemaAudit:e.schemaAudit||{protocol:'structured-json',field:'response',expected:'valid-json',actualType:typeof checked.response?.text}})?.schemaAudit;
      if(schemaAudit)e.schemaAudit=schemaAudit;
      report('validation-failed',undefined,'E_MODEL_SCHEMA',undefined,undefined,schemaAudit);
      if(attempt===0)messages.push({role:'user',content:'上次输出格式无效：'+e.message+'。'+(schemaAudit?'字段 '+schemaAudit.field+' 要求 '+schemaAudit.expected+'。':'')+'请重新检查同一份数据，仅输出完整严格JSON对象；小数必须带前导0，不要思考标签、代码围栏或额外正文。'+(repairInstructions?'\n严格遵守以下同一协议：\n'+repairInstructions:'')});
    }
  }const failure=new Error('模型结果格式无效：'+error.message,{cause:error});failure.code='E_MODEL_SCHEMA';failure.diagnostic=require('./self-repair').diagnostic({schemaAudit:error.schemaAudit});throw failure;
}
module.exports={modelJSON,checkedJSON};
