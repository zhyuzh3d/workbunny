'use strict';
const {createHash}=require('node:crypto');
const {readRecords}=require('./memory-evidence');
const {canRead}=require('./memory-scope');
const INDEX='innate:index',hash=value=>createHash('sha256').update(value).digest('hex');
const isInnate=row=>String(row?.id||row).startsWith('innate:')||row?.value?.migratedToInnate===true||row?.value?.origin==='bundled'&&String(row.value.provenance?.packId||'').startsWith('org.workbunny.');
class InnateExperienceRepository{
 constructor({memory,clock=Date.now}={}){Object.assign(this,{memory,clock});}
 enabled(){return this.memory.getSettings().useInnateExperience!==false;}
 async install(packages){
  const contentHash=hash(JSON.stringify(packages)),existing=(await readRecords(this.memory,[INDEX]))[0];
  if(existing?.value.contentHash===contentHash)return {changed:false};
  const records=[],ids=[];
  for(const p of packages){
   const packHash=hash(JSON.stringify(p)),packId='innate:pack:'+packHash;
   records.push({id:packId,kind:'state',ts:0,domain:'work',visibilityFloor:0,value:{schema:'bunny.innate/v1',type:'pack',origin:'innate',title:p.id+' 随包经验',version:p.version,hash:packHash,sources:[]}});
   for(const instructions of p.instructions.split(/(?=^##\s)/mu).filter(s=>s.trim())){
    const id='innate:entry:'+hash(packId+'\0'+instructions);ids.push(id);
    records.push({id,kind:'state',ts:0,domain:'work',visibilityFloor:0,value:{schema:'bunny.innate/v1',type:'experience',origin:'innate',status:'bundled',revision:p.version,
     title:instructions.split('\n')[0].replace(/^#+\s*/u,''),instructions:instructions.trim(),tags:p.id==='common'?['general:computer']:['software:'+p.application],appliesTo:{platform:'macOS'},toolRefs:[],sources:[packId]}});
   }
  }
  records.push({id:INDEX,kind:'state',ts:0,domain:'work',visibilityFloor:0,value:{schema:'bunny.innate-index/v1',contentHash,entries:ids,sources:[]}});
  await this.memory.serial(async()=>{
   // Earlier releases put built-ins into the learnable pool. Retire those
   // heads while retaining immutable task provenance and all user lessons.
   let cursor={};for(;;){
    const heads=await this.memory.query('state',80,{scene:null,requiredMarkers:['bunny_experience_head_experience'],...cursor});
    const bodies=await readRecords(this.memory,heads.map(h=>h.value.currentId).filter(Boolean)),byId=new Map(bodies.map(r=>[r.id,r]));
    for(const h of heads)if(isInnate(byId.get(h.value.currentId)))records.push({...h,value:{...h.value,status:'superseded',dirty:false,migratedToInnate:true}});
    if(heads.length<80)break;const tail=heads.at(-1);cursor={before:tail.ts,beforeId:tail.id};
   }
   await this.restoreSnapshot(records);
  });
  return {changed:true,entries:ids.length};
 }
 async restoreSnapshot(records){
  for(const group of [records.filter(r=>r.value.type==='pack'),records.filter(r=>r.value.type==='experience'),records.filter(r=>!['pack','experience'].includes(r.value.type))])if(group.length)await this.memory.write(group,this.memory.epoch,{notify:false});
 }
 async rows({scene='life',includeDisabled=false}={}){
  if(!includeDisabled&&!this.enabled())return [];
  const index=(await readRecords(this.memory,[INDEX]))[0];if(!index)return [];
  const rows=[];for(let i=0;i<index.value.entries.length;i+=80)rows.push(...await readRecords(this.memory,index.value.entries.slice(i,i+80)));
  return rows.filter(r=>r.state==='active'&&canRead(scene,r));
 }
 async search({scene='life',query='',limit=12}={}){
  const words=String(query).normalize('NFKC').toLowerCase().split(/[\s，。；：、]+/u).filter(w=>w.length>1);
  return (await this.rows({scene})).map(row=>({row,score:words.reduce((n,w)=>n+(row.value.tags.some(t=>w.includes(t))?20:row.value.instructions.toLowerCase().includes(w)?1:0),0)}))
   .filter(x=>!words.length||x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.row);
 }
 async list({scene='life',query=''}={}){
  const rows=await this.rows({scene,includeDisabled:true});return rows.filter(r=>!query||[r.value.instructions,...r.value.tags].join(' ').toLowerCase().includes(query.toLowerCase())).map(r=>({id:r.id,kind:'state',ts:0,domain:r.domain,visibilityFloor:0,knowledgeType:'experience',label:'先天经验',origin:'innate',readOnly:true,status:'bundled',tags:r.value.tags,content:r.value.instructions,sources:r.value.sources,revision:r.value.revision}));
 }
 async snapshot(){
  const index=(await readRecords(this.memory,[INDEX]))[0];if(!index)return [];
  const entries=await this.rows({scene:'private',includeDisabled:true}),packs=await readRecords(this.memory,[...new Set(entries.flatMap(r=>r.value.sources))]);
  return [...packs,...entries,index];
 }
}
module.exports={InnateExperienceRepository,isInnate,INDEX};
