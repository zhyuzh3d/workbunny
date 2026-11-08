'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {MemoryService}=require('../src/main/memory-service');
const {createAgentJournal}=require('../src/main/agent-journal');
const {AgentRuntime}=require('../src/main/agent-runtime'),{ToolRegistry}=require('../src/main/agent-tools'),{SkillRegistry}=require('../src/main/agent-skills');
test('production task state is encrypted, restores with its queue, and cannot be recreated after erasing its owner source',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-agent-vault-')),key=crypto.randomBytes(32);
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]);},decryptString:value=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
 const memory=new MemoryService({dir,bin:path.resolve('bin/vault'),safeStorage,getSettings:()=>({enabled:true,extract:false})});
 try{
  await memory.init();assert(memory.ready,memory.error);
  const source=await memory.addMessage('user','Observe Alice and retain pending messages');
  const tools=new ToolRegistry(),skills=new SkillRegistry(tools).register({id:'test.observe',version:1,description:'test',tools:[],capabilities:[],run:async()=>({status:'waiting',consumeEvent:false})});
  const journal=createAgentJournal(memory),runtime=new AgentRuntime({journal,tools,skills,epoch:()=>memory.generation,autoSchedule:false});
  const created=await runtime.start({skill:'test.observe',goal:'private agent marker 9x31',subjects:[{application:'wechat',recipient:'Alice'}]},{role:'owner',verified:true,sources:[source.id],scene:'life'});
  assert(created.ok,created.error);await runtime.enqueue(created.id,{key:'event-1',text:'private message marker 8y42'});await runtime.close();
  const restored=new AgentRuntime({journal,tools,skills,epoch:()=>memory.generation,autoSchedule:false});await restored.restore();assert.equal(restored.tasks.get(created.id).inbox.length,1);
  assert(await journal.authorized(restored.tasks.get(created.id)));
  const files=fs.readdirSync(dir).filter(name=>fs.statSync(path.join(dir,name)).isFile());for(const name of files){const bytes=fs.readFileSync(path.join(dir,name));assert(!bytes.includes(Buffer.from('private agent marker')));assert(!bytes.includes(Buffer.from('private message marker')));}
  // List clearing rewrites only the encrypted Task visibility. Native removal
  // would cascade through this real source graph, so exercise the production vault.
  const artifact=path.join(dir,'preserved-result.txt');fs.writeFileSync(artifact,'preserved artifact bytes');
  const savedTask=restored.tasks.get(created.id);savedTask.state.result={summary:'retained result',artifacts:[{path:artifact}]};savedTask.state.cleanupLog=[{kind:'process',verified:false,reason:'historical failure'}];savedTask.state.reportOutbox=[{eventId:'old-delivery',status:'queued',text:'do not resend'}];await journal.put(savedTask);
  await memory.serial(()=>memory.write([{id:'derived-memory',kind:'memory',ts:Date.now(),domain:'life',value:{content:'retained learned fact',sources:[created.id]}},{id:'derived-state',kind:'state',ts:Date.now()+1,domain:'life',value:{content:'retained state',sources:[created.id]}}]));
  const generation=memory.generation;assert.equal((await restored.archiveList()).ok,true);assert.equal(restored.list().length,0);assert.equal(memory.generation,generation);assert.equal(fs.readFileSync(artifact,'utf8'),'preserved artifact bytes');
  const graph=await memory.db.request('get',{ids:[source.id,created.id,'derived-memory','derived-state']});assert.equal(graph.rows.length,4);assert(graph.rows.every(row=>row.state==='active'));assert.deepEqual(memory.decode(graph.rows.find(row=>row.id==='derived-memory')).value.sources,[created.id]);
  await restored.close();const undo=new AgentRuntime({journal,tools,skills,epoch:()=>memory.generation,autoSchedule:false});await undo.restore();assert.equal(undo.list().length,0);assert.equal((await undo.restoreList()).ok,true);assert.equal(undo.list().length,1);assert.equal(undo.tasks.get(created.id).status,'stopped');assert.equal(undo.tasks.get(created.id).state.result.artifacts[0].path,artifact);assert.equal(undo.tasks.get(created.id).state.cleanupLog[0].reason,'historical failure');assert.equal(undo.tasks.get(created.id).state.reportOutbox[0].status,'cancelled');assert.equal((await undo.control('resume',created.id)).ok,false);await undo.tick();assert.equal(undo.tasks.get(created.id).counters.wakes,0);
  // Native erasure invalidates the source graph; a stale task cannot write itself back.
  await memory.remove(source.id);
  assert.equal(await journal.authorized(undo.tasks.get(created.id)),false);
  await assert.rejects(journal.put(undo.tasks.get(created.id)));
  await undo.close();
 }finally{await memory.close();fs.rmSync(dir,{recursive:true,force:true});}
});
