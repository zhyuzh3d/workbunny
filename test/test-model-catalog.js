'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {createCatalog,normalize,requestJSON,PROVIDERS}=require('../src/main/model-catalog');
const {chatPayload}=require('../src/main/workbuddy');
const wb=[{id:'hy3',name:'Hy3',onlyReasoning:true,supportsReasoning:true,reasoning:{effort:'high'},iconUrl:'excluded'},
{id:'space-bunny',name:'Space-Bunny',onlyReasoning:true,supportsReasoning:true,reasoning:{supportedEfforts:['low','medium','high','xhigh','max'],canDisableThinking:false},apiKey:'never-persist'},
{id:'switchable',supportsReasoning:true,reasoning:{supportedEfforts:['low','high'],canDisableThinking:true}},
{id:'image',tags:['text-to-image']},{id:'disabled',disabled:true}];
function fixture(t,overrides={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-models-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const catalog=createCatalog(overrides);catalog.setPath(path.join(dir,'models.json'));return{dir,catalog};}
test('WorkBuddy filters incompatible models, reads per-model levels, and persists only safe metadata',async t=>{
 const f=fixture(t,{workbuddyRequest:async p=>{assert.equal(p.path,'/v2/enterprises/personal/models');return{body:JSON.stringify({code:0,data:{models:wb}})}}});
 const result=await f.catalog.refresh('workbuddy');assert.equal(result.models.length,3);
 assert.deepEqual(f.catalog.thinking('workbuddy','hy3').map(x=>x.id),['auto','low','high']);
 assert.deepEqual(f.catalog.thinking('workbuddy','space-bunny').map(x=>x.id),['auto','low','medium','high','xhigh','max']);
 assert.deepEqual(f.catalog.body('workbuddy','space-bunny','max'),{reasoning_effort:'max'});
 assert.deepEqual(f.catalog.body('workbuddy','space-bunny','off'),{});
 assert.deepEqual(f.catalog.body('workbuddy','switchable','off'),{thinking:{type:'disabled'}});
 const saved=fs.readFileSync(path.join(f.dir,'models.json'),'utf8');assert.ok(!/never-persist|apiKey|iconUrl/.test(saved));
 const reload=createCatalog();reload.setPath(path.join(f.dir,'models.json'));assert.deepEqual(reload.get('workbuddy'),result);
});
test('DeepSeek and Grok read their own capabilities and produce different supported thinking payloads',async t=>{
 const calls=[];const f=fixture(t,{request:async(url,key)=>{calls.push({url,key});return url.includes('deepseek')?{data:[{id:'new-deepseek',name:'New model',effort:{supported_levels:['low','max']}}]}:{models:[{id:'new-grok',input_modalities:['text'],output_modalities:['text'],capabilities:{reasoning_effort:['none','low','xhigh']}},{id:'video',output_modalities:['video']}]};}});
 await f.catalog.refresh('deepseek',' fixture ');await f.catalog.refresh('grok',' fixture ');
 assert.equal(calls[0].url,'https://api.deepseek.com/v1/models');assert.equal(calls[1].url,'https://api.x.ai/v1/language-models');assert.equal(calls[0].key,'fixture');
 assert.deepEqual(f.catalog.thinking('deepseek','new-deepseek').map(x=>x.id),['auto','off','low','max']);
 assert.deepEqual(f.catalog.body('deepseek','new-deepseek','off'),{thinking:{type:'disabled'}});
 assert.deepEqual(f.catalog.body('deepseek','new-deepseek','max'),{thinking:{type:'enabled'},reasoning_effort:'max'});
 assert.deepEqual(f.catalog.body('grok','new-grok','off'),{reasoning_effort:'none'});
 assert.deepEqual(f.catalog.body('grok','new-grok','xhigh'),{reasoning_effort:'xhigh'});
 assert.equal(f.catalog.get('grok').models.length,1);await assert.rejects(f.catalog.refresh('grok',''),/API Key/);
});
test('failed refresh retains the working catalog and unsupported levels are never sent',async t=>{
 let fail=false;const f=fixture(t,{request:async()=>{if(fail)throw new Error('offline');return{data:[{id:'one',effort:{supported_levels:['high']}}]}}});
 const good=await f.catalog.refresh('deepseek','fixture');fail=true;await assert.rejects(f.catalog.refresh('deepseek','fixture'),/offline/);assert.deepEqual(f.catalog.get('deepseek'),good);assert.deepEqual(f.catalog.body('deepseek','one','max'),{});
});
test('the selected WorkBuddy model and all allowed effort names reach the actual request payload',async t=>{
 const config=require('../src/main/config'),f=fixture(t);config.setPath(path.join(f.dir,'config.json'));
 const catalog=require('../src/main/model-catalog');const normalized=normalize('workbuddy',wb);fs.writeFileSync(path.join(f.dir,'model-catalog.json'),JSON.stringify({workbuddy:{at:1,models:normalized}}));config.setPath(path.join(f.dir,'config.json'));
 for(const level of ['low','medium','high','xhigh','max']){
  const L=config.resolveLLM(config.preview({brain:{source:'workbuddy',model:'space-bunny',thinking:level}}));const payload=chatPayload({...L,messages:[]});assert.equal(payload.model,'space-bunny');assert.equal(payload.reasoning_effort,level);
 }
 assert.ok(PROVIDERS.every(p=>p.id!=='nvidia'));
 fs.writeFileSync(path.join(f.dir,'legacy.json'),JSON.stringify({brain:{source:'apikey',provider:'nvidia',profiles:{nvidia:{apiKey:'legacy-fixture'}}}}));config.setPath(path.join(f.dir,'legacy.json'));const c=config.load();assert.equal(config.resolveLLM(c).provider,'workbuddy');assert.equal(c.brain.profiles.nvidia.apiKey,'legacy-fixture');assert.ok(!JSON.stringify(config.publicConfig(c)).includes('legacy-fixture'));
});
test('HTTP errors do not expose provider response bodies or credentials',async t=>{
 const server=http.createServer((_q,r)=>{r.writeHead(401);r.end('private-account-data');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 await assert.rejects(requestJSON(`http://127.0.0.1:${server.address().port}/models`,'fixture'),e=>!e.message.includes('private-account-data')&&/API Key/.test(e.message));
});
test('external catalogs start empty and belong to the exact provider, key and address across restart',async t=>{
 const f=fixture(t,{request:async url=>url.endsWith('/language-models')?{models:[{id:'actual-grok'}]}:{data:[{id:'actual-model'}]}});
 for(const provider of ['deepseek','openai','grok']){
  const base='https://fixture.invalid/'+provider+'/v1';
  assert.deepEqual(f.catalog.forConnection(provider,'secret-key',base).models,[]);
  await f.catalog.refresh(provider,'secret-key',base);
  assert.equal(f.catalog.forConnection(provider,'secret-key',base).models.length,1);
  assert.deepEqual(f.catalog.forConnection(provider,'other-key',base).models,[]);
  assert.deepEqual(f.catalog.forConnection(provider,'secret-key',base+'-other').models,[]);
  const reload=createCatalog();reload.setPath(path.join(f.dir,'models.json'));
  assert.equal(reload.forConnection(provider,'secret-key',base+'/').models.length,1);
  assert.deepEqual(reload.forConnection(provider,'other-key',base).models,[]);
  assert(!JSON.stringify(reload.forConnection(provider,'secret-key',base)).includes('connectionKey'));
 }
 assert(!fs.readFileSync(path.join(f.dir,'models.json'),'utf8').includes('secret-key'));
});
