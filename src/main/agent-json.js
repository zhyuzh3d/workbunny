'use strict';
const {parseStrictJson,stringEnd}=require('./strict-json');
const {requestVerification}=require('./verification-transport');
function modelJSON(text){
  let body=String(text||'').trim();
  const fenced=/^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(body);
  if(fenced)body=fenced[1].trim();
  return parseStrictJson(body);
}
function structuredJSON(text){
  try{return {value:modelJSON(text),discardedChars:0};}catch(original){
    // Model narration is not executable data. Accept one complete structured
    // value only; scan strings and nesting rather than slicing first/last braces.
    // Any second value, mismatched delimiter or truncated candidate is ambiguous.
    const source=String(text||'').trim(),ranges=[];let start=-1;const stack=[];
    for(let i=0;i<source.length;i++){
      const c=source[i];
      if(c==='"'){const end=stringEnd(source,i);if(end<0)throw original;i=end-1;continue;}
      if(c==='{'||c==='['){if(!stack.length)start=i;stack.push(c);}
      else if(c==='}'||c===']'){
        if(stack.pop()!==(c==='}'?'{':'['))throw original;
        if(!stack.length){ranges.push([start,i+1]);if(ranges.length>1)throw original;}
      }
    }
    if(stack.length||ranges.length!==1)throw original;
    const [from,to]=ranges[0],candidate=source.slice(from,to);
    return {value:parseStrictJson(candidate),discardedChars:source.length-candidate.length};
  }
}
async function checkedJSON(options,validate,{request=requestVerification,onRequestDiagnostic,repairInstructions}={}){
  options=require('./self-repair').applyProfile(options,options.repairProfile);
  let error,retryOptions,recoveryReason;const messages=options.messages.map(m=>({...m}));const system=messages.find(m=>m.role==='system'&&typeof m.content==='string');if(system){if(!system.content.includes('# Bunny'))system.content=require('./bunny-principles')+'\n'+system.content;}else messages.unshift({role:'system',content:require('./bunny-principles')});
  messages.find(m=>m.role==='system'&&typeof m.content==='string').content+='\n结构化响应协议：仅输出本轮要求的一个完整严格 JSON 值，不添加代码围栏、前言、解释、安全提示或其它 JSON 外文字；需要说明的内容只能写入协议允许的字段。';
  for(let attempt=0;attempt<2;attempt++){
    if(options.signal?.aborted)throw new Error('任务已取消');
    const requestOptions={...(retryOptions||options),messages,singleAttempt:true,...(recoveryReason?{recoveryReason}:{})};
    const began=Date.now(),report=(phase,completion,errorCode,budget,transport,schemaAudit,discardedChars)=>{try{onRequestDiagnostic?.({attempt:attempt+1,phase,elapsedMs:Date.now()-began,...(Number.isSafeInteger(discardedChars)&&discardedChars>0?{normalized:true,discardedChars}:{}),...(Number.isSafeInteger(requestOptions.maxTokens)?{requestedMaxOutputTokens:requestOptions.maxTokens}:{}),...(Number.isSafeInteger(requestOptions.inputBudgetTokens)?{requestedInputBudgetTokens:requestOptions.inputBudgetTokens}:{}),...(completion?{completion}:{}),...(budget?{budget}:{}),...(transport?{transport}:{}),...(schemaAudit?{schemaAudit}:{}),...(/^E_[A-Z0-9_]{1,60}$/u.test(errorCode||'')?{errorCode}:{})});}catch{}};
    report('started');
    let checked;
    try{
      checked=await request(requestOptions);
      const response=checked.response||{};
      const diagnostic=require('./self-repair').diagnostic({budget:response.contextBudget,completion:{model:response.model||checked.model,maxOutputTokens:response.contextBudget?.output,finishReason:response.finishReason,usage:response.usage}});
      report('completed',diagnostic?.completion,undefined,diagnostic?.budget);
    }catch(e){
      const diagnostic=require('./self-repair').diagnostic({...e.diagnostic,...(error?.schemaAudit?{schemaAudit:error.schemaAudit}:{}),completion:{...e.diagnostic?.completion,...(e.finishReason?{finishReason:e.finishReason}:{}),...(e.usage?{usage:e.usage}:{}),...(typeof e.hasReasoning==='boolean'?{hasReasoning:e.hasReasoning}:{})}});
      if(diagnostic)e.diagnostic=diagnostic;
      report('failed',diagnostic?.completion,e.code,diagnostic?.budget,diagnostic?.transport,diagnostic?.schemaAudit);
      const transient=require('./workbuddy').isTransientConnectionError?.(e)||/timeout|超时|network|连接|fetch failed|ECONNRESET|ETIMEDOUT/iu.test(e.message||'');
      const repaired=require('./self-repair').responseRecovery(requestOptions,e);
      if(!(transient||repaired)||attempt>0||options.signal?.aborted)throw e;
      retryOptions=repaired||requestOptions;recoveryReason=e.code;
      if(repaired){const reminder='上次回答'+(e.code==='E_PAYLOAD_TOO_LARGE'?'超过转发字节限制，本次缩减输出和推理预算':'达到token额度上限，本次提高输出额度')+'。保留同一份证据与目标，仅返回所需完整JSON；依据写简短结论，不复述输入、不展开推理过程，不添加其它内容。';if(system)system.content+='\n'+reminder;else messages.unshift({role:'system',content:reminder});}
      await new Promise(r=>setTimeout(r,500));continue;
    }
    try{const parsed=structuredJSON(checked.response.text),value=await validate(parsed.value);report('validated',undefined,undefined,undefined,undefined,undefined,parsed.discardedChars);return {value,model:checked.model,attempts:attempt+1};}
    catch(e){
      error=e;
      const schemaAudit=require('./self-repair').diagnostic({schemaAudit:e.schemaAudit||{protocol:'structured-json',field:'response',expected:'valid-json',actualType:typeof checked.response?.text}})?.schemaAudit;
      if(schemaAudit)e.schemaAudit=schemaAudit;
      report('validation-failed',undefined,'E_MODEL_SCHEMA',undefined,undefined,schemaAudit);
      if(attempt===0){
        // Repair the actual rejected answer instead of asking the model to
        // independently repeat the same expensive visual inference.
        const prior=checked.response?.text;
        if(typeof prior==='string'&&prior.length<=32768)messages.push({role:'assistant',content:prior});
        messages.push({role:'user',content:'上次输出格式无效：'+e.message+'。'+(schemaAudit?'字段 '+schemaAudit.field+' 要求 '+schemaAudit.expected+'。':'')+'请修正上次结果，保留同一份证据与目标，仅输出完整严格JSON对象；小数必须带前导0，不要思考标签、代码围栏或额外正文。'+(repairInstructions?'\n严格遵守以下同一协议：\n'+repairInstructions:'')});
      }
    }
  }const failure=new Error('模型结果格式无效：'+error.message,{cause:error});failure.code='E_MODEL_SCHEMA';failure.diagnostic=require('./self-repair').diagnostic({schemaAudit:error.schemaAudit});throw failure;
}
module.exports={modelJSON,checkedJSON};
