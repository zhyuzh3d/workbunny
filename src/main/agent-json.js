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
  let error;const messages=[...options.messages];
  for(let attempt=0;attempt<2;attempt++){
    if(options.signal?.aborted)throw new Error('任务已取消');
    const checked=await request({...options,messages});
    try{return {value:validate(modelJSON(checked.response.text)),model:checked.model,attempts:attempt+1};}
    catch(e){error=e;if(attempt===0)messages.push({role:'user',content:'上次输出格式无效：'+e.message+'。请重新检查同一份数据，仅输出完整严格JSON对象；小数必须带前导0，不要思考标签、代码围栏或额外正文。'});}
  }throw new Error('模型结果格式无效：'+error.message,{cause:error});
}
module.exports={modelJSON,checkedJSON};
