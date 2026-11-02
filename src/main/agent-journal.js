'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const { TASK_SCHEMA,clone }=require('./agent-contract');
const { withSources,canRead }=require('./memory-scope');
// Production task state shares the encrypted memory vault's source/erasure scope.
function createAgentJournal(memory){
  const check=t=>{memory.check();if(t.privacyEpoch!==memory.generation)throw new Error('任务资料版本已经变化');};
  const get=async ids=>(await memory.db.request('get',{ids})).rows.map(row=>memory.decode(row));
  async function sources(task){
    if(!Array.isArray(task.sources)||!task.sources.length)throw new Error('任务缺少交办来源');
    const rows=await get(task.sources);
    if(rows.length!==new Set(task.sources).size||rows.some(r=>r.state&&r.state!=='active'))throw new Error('交办来源已删除或失效');
    withSources(task.domain,rows,task.visibilityFloor);return rows;
  }
  return {
    async put(task){return memory.serial(async()=>{
      check(task);if(task.schema!==TASK_SCHEMA)throw new Error('任务规范不匹配');await sources(task);check(task);
      if(Buffer.byteLength(JSON.stringify(task))>1_200_000)throw new Error('任务记录达到容量上限，需要整理会话');
      await memory.write([{id:task.id,kind:'task',ts:task.createdAt,updatedAt:task.updatedAt,domain:task.domain,visibilityFloor:task.visibilityFloor,
        value:{...clone(task),taskType:'agent-task',content:[task.goal,task.note].join('\n')}}]);check(task);
    });},
    async list(){memory.check();const result=[];let cursor={};for(;;){
      const rows=await memory.query('task',200,{...cursor,state:'all',scene:null});
      for(const row of rows)if(row.state==='active'&&row.value.schema===TASK_SCHEMA&&row.value.taskType==='agent-task')result.push({...row.value,id:row.id});
      if(rows.length<200)break;const tail=rows.at(-1);cursor={before:tail.ts,beforeId:tail.id};
    }return result;},
    async authorized(task){try{memory.check();await sources(task);const root=(await get([task.id]))[0];
      return root?.state==='active'&&root.value.schema===TASK_SCHEMA&&root.value.authority?.verified===true&&canRead(task.scene,root);
    }catch{return false;}}
  };
}
// Explicit developer/live-test adapter. App production always uses the encrypted adapter above.
class FileAgentJournal{
  constructor(file){this.file=file;this.records=new Map();this.tail=Promise.resolve();}
  async load(){try{for(const task of JSON.parse(await fs.readFile(this.file,'utf8')))this.records.set(task.id,task);}catch(e){if(e.code!=='ENOENT')throw e;}}
  async put(task){const value=clone(task);const job=this.tail.then(async()=>{
    this.records.set(value.id,value);await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    const temporary=this.file+'.tmp';await fs.writeFile(temporary,JSON.stringify([...this.records.values()]),{mode:0o600});await fs.rename(temporary,this.file);
  });this.tail=job.catch(()=>{});return job;}
  async list(){return [...this.records.values()].map(clone);}
  async authorized(task){return task.authority?.verified===true&&task.authority.role==='owner'&&this.records.has(task.id);}
}
module.exports={createAgentJournal,FileAgentJournal};
