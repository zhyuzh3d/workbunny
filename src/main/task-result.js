'use strict';
function workResult(physical,verification={}){
 const summary=String(verification.report||physical.report||physical.monitorSummary||'工作已完成，结果已保存。').trim();
 return {schema:'bunny.result/v1',revision:1,summary,text:String(physical.monitorSummary||physical.report||summary),
  source:{jobId:physical.id,sessionId:physical.monitorSessionId,messageKey:physical.monitorMessageKey},
  artifacts:(verification.artifactManifest?.files||physical.artifactManifest?.files||[]).filter(f=>f.role!=='evidence'||physical.deliverEvidenceFiles===true),collectedAt:Date.now()};
}
function deliveryText(result){
 return String(result.summary||'成果已整理。').slice(0,3000);
}
module.exports={workResult,deliveryText};
