'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ExperienceRepository}=require('../src/main/experience-repository');
const row=(id,sources=[],extra={})=>({id,kind:'state',state:'active',domain:'life',visibilityFloor:1,value:{sources,instructions:'synthetic '+id},...extra});
function fake(rows,roots,{failure=false,change=false}={}){
 const records=new Map(rows.map(r=>[r.id,structuredClone(r)])),calls=[];
 const memory={dir:'/tmp/offline-lineage',generation:1,sceneEpoch:1,ready:true,decode:r=>structuredClone(r),db:{request:async(op,args)=>{
  assert.equal(op,'get');assert.equal(args.scene,'life');assert(args.ids.length<=200);calls.push(args.ids.slice());if(failure)throw Error('private error must not escape');if(change)memory.sceneEpoch++;
  return {rows:args.ids.flatMap(id=>records.has(id)?[records.get(id)]:[])};
 }}};
 const repo=new ExperienceRepository({memory,clock:()=>100});repo.heads=async()=>roots.map(id=>({id}));repo.resolve=async head=>structuredClone(records.get(head.id));
 return {repo,records,calls};
}
test('all candidates share batched ancestor reads and exclude an arbitrary-depth path to the owner Task',async()=>{
 const nodes=[row('T'),row('proof',['T']),row('A',['proof']),row('B',['A']),row('safe'),row('other',['safe'])];
 const h=fake(nodes,['B','other']),before=structuredClone([...h.records]);const result=await h.repo.searchWithAvailability({excludeTaskId:'T'});
 assert.deepEqual(result.rows.map(r=>r.id),['other']);assert.equal(result.availability.status,'complete');assert(result.availability.reasonCodes.includes('excluded-task-ancestor'));assert.deepEqual([...h.records],before);
 assert(h.calls.flat().every((id,index,all)=>all.indexOf(id)===index),'shared ancestors are never read twice');
 const legacy=await h.repo.search({excludeTaskId:'T'});assert.equal(legacy.availability.status,'complete');assert.equal(Object.keys(legacy).includes('availability'),false);
});
test('missing, hidden, expired, cyclic or unreadable ancestors fail closed with explicit availability',async()=>{
 for(const [name,nodes,options]of [
  ['missing',[row('root',['absent'])],{}],['private',[row('root',['private']),row('private',[],{visibilityFloor:2,domain:'private'})],{}],
  ['expired',[row('root',['old']),row('old',[],{expiresAt:50})],{}],['cycle',[row('root',['a']),row('a',['b']),row('b',['a'])],{}],
  ['read',[row('root',['a']),row('a')],{failure:true}],['scope-change',[row('root',['a']),row('a')],{change:true}]]){
  const h=fake(nodes,['root'],options),result=await h.repo.searchWithAvailability({excludeTaskId:'T'});
  assert.equal(result.rows.length,0,name);assert.notEqual(result.availability.status,'complete',name);assert(result.availability.reasonCodes.length,name);assert(!JSON.stringify(result.availability).includes('private error'));
 }
});
test('record, edge and read budgets are bounded and do not suppress independently proven safe rows',async()=>{
 const nodes=[row('safe'),row('root',['a','b']),row('a',['c']),row('b',['c']),row('c')];
 for(const lineageBudget of [{maxRecords:3},{maxEdges:1},{maxBatches:1}]){
  const h=fake(nodes,['safe','root']),result=await h.repo.searchWithAvailability({excludeTaskId:'T',lineageBudget});
  assert.deepEqual(result.rows.map(r=>r.id),['safe']);assert.equal(result.availability.status,'partial');assert(h.calls.length<=result.availability.limits.maxBatches);
 }
});
test('many candidates with one shared lineage inspect each ancestor once',async()=>{
 const roots=Array.from({length:60},(_,i)=>'root-'+i),nodes=[...roots.map(id=>row(id,['shared'])),row('shared',['leaf']),row('leaf')],h=fake(nodes,roots);
 const result=await h.repo.searchWithAvailability({excludeTaskId:'T',limit:60});assert.equal(result.rows.length,60);assert.equal(h.calls.length,2);assert.deepEqual(h.calls,[['shared'],['leaf']]);assert.equal(result.availability.status,'complete');
});
test('a transitive uncommitted pack cannot enter safe references through an intermediate source',async()=>{
 const pack=row('pack',[],{value:{sources:[],type:'pack',status:'preparing'}}),h=fake([row('candidate',['bridge']),row('bridge',['pack']),pack],['candidate']);
 const result=await h.repo.searchWithAvailability({excludeTaskId:'T'});
 assert.deepEqual(result.rows,[]);assert.equal(result.availability.status,'partial');assert(result.availability.reasonCodes.includes('lineage-source-unavailable'));
 assert.equal(h.records.get('pack').value.status,'preparing');assert.deepEqual(h.records.get('candidate').value.sources,['bridge']);
});
test('existing proof validation applies through intermediate ancestors for both supported proof origins',async()=>{
 for(const origin of ['task-experience-v1','verified-tool-v1']){
  const proof=row('proof',[],{value:{sources:[],origin}}),h=fake([row('candidate',['bridge']),row('bridge',['proof']),proof],['candidate']);let checks=0;
  h.repo.memory.experiences={validateRecord:async()=>{checks++;return false;}};
  const result=await h.repo.searchWithAvailability({excludeTaskId:'T'});assert.deepEqual(result.rows,[]);assert.equal(result.availability.status,'partial');assert.equal(checks,1);assert(result.availability.reasonCodes.includes('lineage-proof-invalid'));
 }
});
test('direct resolution and shared transitive ancestors reuse the same proof validation once',async()=>{
 const proof=row('proof',[],{value:{sources:[],origin:'task-experience-v1'}}),roots=['direct','deep'],h=fake([row('direct',['proof']),row('deep',['bridge']),row('bridge',['proof']),proof],roots);let checks=0;
 h.repo.memory.experiences={validateRecord:async()=>{checks++;return true;}};h.repo.resolve=ExperienceRepository.prototype.resolve.bind(h.repo);
 h.repo.heads=async()=>roots.map(id=>row('head-'+id,[],{value:{currentId:id,status:'candidate',sources:[]}}));
 const result=await h.repo.searchWithAvailability({excludeTaskId:'T'});assert.equal(result.rows.length,2);assert.equal(result.availability.status,'complete');assert.equal(result.availability.proofChecks,1);assert.equal(checks,1);
});
test('throwing and hung proof validators fail closed within a real-time cumulative deadline',async()=>{
 for(const mode of ['throw','hang']){
  const proof=row('proof',[],{value:{sources:[],origin:'verified-tool-v1'}}),h=fake([row('candidate',['bridge']),row('bridge',['proof']),proof],['candidate']);
  h.repo.memory.experiences={validateRecord:()=>mode==='throw'?Promise.reject(Error('private validation detail')):new Promise(()=>{})};
  const start=Date.now(),result=await h.repo.searchWithAvailability({excludeTaskId:'T',lineageBudget:{proofTimeoutMs:20}});
  assert.equal(result.rows.length,0);assert.notEqual(result.availability.status,'complete');assert(Date.now()-start<1000);assert(!JSON.stringify(result.availability).includes('private validation detail'));
  assert(result.availability.reasonCodes.includes(mode==='throw'?'lineage-proof-unavailable':'lineage-proof-timeout'));
 }
});
test('proof-count exhaustion excludes only candidates whose proof cannot be checked',async()=>{
 const proof=id=>row(id,[],{value:{sources:[],origin:'task-experience-v1'}}),h=fake([row('one',['p1']),row('two',['p2']),proof('p1'),proof('p2')],['one','two']);let checks=0;
 h.repo.memory.experiences={validateRecord:async()=>{checks++;return true;}};
 const result=await h.repo.searchWithAvailability({excludeTaskId:'T',lineageBudget:{maxProofs:1}});
 assert.deepEqual(result.rows.map(r=>r.id),['one']);assert.equal(result.availability.status,'partial');assert.equal(checks,1);assert(result.availability.reasonCodes.includes('lineage-proof-budget'));
});
test('context changes while validating the last source-free leaf cannot return safe complete rows',async()=>{
 const proof=row('proof',[],{value:{sources:[],origin:'task-experience-v1'}}),h=fake([row('candidate',['bridge']),row('bridge',['proof']),proof],['candidate']);
 h.repo.memory.experiences={validateRecord:async()=>{h.repo.memory.generation++;return true;}};
 const result=await h.repo.searchWithAvailability({excludeTaskId:'T'});assert.deepEqual(result.rows,[]);assert.equal(result.availability.status,'unavailable');assert(result.availability.reasonCodes.includes('lineage-context-changed'));
});
test('real temporary vault excludes Task → proof → experience A → experience B without deleting any provenance',async t=>{
 const {fixture}=require('./support/experience-fixture.cjs'),{memory,repo}=await fixture(t),ts=Date.now();
 await memory.write([{id:'lineage-task',kind:'task',ts,domain:'life',visibilityFloor:1,value:{sources:[]}}]);
 await memory.write([{id:'lineage-proof',kind:'state',ts,domain:'life',visibilityFloor:1,value:{sources:['lineage-task']}}]);
 const a=await repo.put({instructions:'lineage A synthetic guidance',tags:['lineage-a']},{scene:'life',sources:['lineage-proof']});
 const b=await repo.put({instructions:'lineage B synthetic guidance',tags:['lineage-b']},{scene:'life',sources:[a.row.id]});
 const safe=await repo.put({instructions:'independent synthetic guidance',tags:['lineage-b']},{scene:'life'});
 const normal=await repo.search({scene:'life',query:'lineage-b'});assert(normal.some(r=>r.id===b.row.id));
 const excluded=await repo.searchWithAvailability({scene:'life',query:'lineage-b',excludeTaskId:'lineage-task'});assert(!excluded.rows.some(r=>r.id===b.row.id));assert(excluded.rows.some(r=>r.id===safe.row.id));assert.equal(excluded.availability.status,'complete');
 assert.deepEqual((await repo.get(b.row.id)).value.sources,[a.row.id]);assert.deepEqual((await repo.get(a.row.id)).value.sources,['lineage-proof']);assert.deepEqual((await repo.get('lineage-task')).value.sources,[]);
});
