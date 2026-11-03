'use strict';
const {parseStrictJson}=require('./strict-json');
const {requestVerification}=require('./verification-transport');
function modelJSON(text){
  let body=String(text||'').trim();
  const fenced=/^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(body);
  if(fenced)body=fenced[1].trim();
  return parseStrictJson(body);
}
async function checkedJSON(options,validate,{request=requestVerification}={}){
  options=require('./self-repair').applyProfile(options,options.repairProfile);
  let error,retryOutputLimit=false;const messages=[...options.messages];
  for(let attempt=0;attempt<2;attempt++){
    if(options.signal?.aborted)throw new Error('任务已取消');
    let checked;try{checked=await request({...options,messages,...(retryOutputLimit?{maxTokens:Math.max(4096,Number(options.maxTokens)||0)}:{})});}catch(e){const transient=require('./workbuddy').isTransientConnectionError?.(e)||/timeout|超时|network|连接|fetch failed|ECONNRESET|ETIMEDOUT/iu.test(e.message||'');const outputLimit=e.code==='E_OUTPUT_LIMIT';if(!(transient||outputLimit)||attempt>0||options.signal?.aborted)throw e;retryOutputLimit=outputLimit;await new Promise(r=>setTimeout(r,500));continue;}
    try{return {value:await validate(modelJSON(checked.response.text)),model:checked.model,attempts:attempt+1};}
    catch(e){error=e;if(attempt===0)messages.push({role:'user',content:'上次输出格式无效：'+e.message+'。请重新检查同一份数据，仅输出完整严格JSON对象；小数必须带前导0，不要思考标签、代码围栏或额外正文。'});}
  }const failure=new Error('模型结果格式无效：'+error.message,{cause:error});failure.code='E_MODEL_SCHEMA';throw failure;
}
module.exports={modelJSON,checkedJSON};
