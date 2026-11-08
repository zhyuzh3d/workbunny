'use strict';
const { resultLinkCandidates, normalizeResultLinks, resultLinks } = require('./result-links');
function workResult(physical,verification={}){
 const summary=String(verification.report||physical.report||physical.monitorSummary||'工作已完成，结果已保存。').trim();
 return {schema:'bunny.result/v1',revision:1,summary,text:String(physical.monitorSummary||physical.report||summary),
  links:Object.hasOwn(verification,'links')?normalizeResultLinks(verification.links):normalizeResultLinks(resultLinkCandidates(physical.monitorLinks,physical.monitorSummary)),
  source:{jobId:physical.id,sessionId:physical.monitorSessionId,messageKey:physical.monitorMessageKey},
  artifacts:(verification.artifactManifest?.files||physical.artifactManifest?.files||[]).filter(f=>f.role!=='evidence'||physical.deliverEvidenceFiles===true),collectedAt:Date.now()};
}
function deliveryText(result,{maxLength=3000}={}){
 const summary=String(result.summary||'成果已整理。'),links=resultLinks(result);
 const body=[summary,...links.filter(link=>!summary.includes(link.url)).map(link=>(link.label?link.label+'：\n':'')+link.url)].join('\n\n');
 if(body.length>maxLength)throw Object.assign(new Error(`成果文字和完整链接超过${maxLength}字，未截断或发送；请精简摘要或分开交付。`),{code:'E_RESULT_DELIVERY_SIZE'});
 return body;
}
module.exports={workResult,deliveryText};
