'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { dialoguePage } = require('../src/main/dialogue-history');

test('task result links persist in the encrypted dialogue and remain scoped and idempotent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-dialogue-links-')),url='https://example.com/game?sharecode=a%2Fb%2Bc&mode=kids#start';
 const memory=new MemoryService({dir,bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,72),getSettings:()=>({enabled:true,extract:false,scene:'life'})});
 try{await memory.init();await memory.write([{id:'result-task',kind:'task',ts:1,domain:'life',value:{content:'source task'}}]);
  const details={scene:'life',delivery:'task-receipt',taskId:'result-task',sources:['result-task'],resultLinks:[{url}]},content='游戏做好了。\n'+url;
  await memory.addMessageOnce('result-reply','assistant',content,details);await memory.addMessageOnce('result-reply','assistant',content,details);
  const life=await dialoguePage(memory,{},'life'),row=life.rows.find(r=>r.id==='result-reply');assert.equal(row.taskId,'result-task');assert.equal(row.links[0].url,url);assert(row.text.includes(url));assert(!(await dialoguePage(memory,{},'work')).rows.some(r=>r.id==='result-reply'));
  await assert.rejects(memory.addMessageOnce('result-reply','assistant',content,{...details,resultLinks:[]}));
 }finally{await memory.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('dialogue history pages across years, tied timestamps, scenes and external messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-dialogue-history-'));
  const memory = new MemoryService({ dir, bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 41), getSettings: () => ({ enabled: true, extract: false, scene: 'private' }) });
  try {
    await memory.init();
    const records = Array.from({ length: 163 }, (_, i) => ({ id: `dialogue-${String(i).padStart(4,'0')}`, kind: 'message', ts: Date.UTC(2020 + Math.floor(i / 30), 0, 1) + Math.floor(i / 2), domain: 'work', value: { role: i % 2 ? 'assistant' : 'user', content: '对话 ' + i } }));
    records.push({ id: 'private-message', kind: 'message', ts: Date.UTC(2030, 0, 1), domain: 'private', value: { role: 'user', content: '私聊消息' } },
      { id: 'external-message', kind: 'message', ts: Date.UTC(2030, 0, 2), domain: 'work', value: { role: 'user', characterId: 'wechat.alice', content: '外部原文' } });
    await memory.write(records);
    const found = []; let before;
    for (let i = 0; i < 10; i++) {
      const page = await dialoguePage(memory, { before }, 'work');
      assert(page.rows.length <= 40);
      assert(!page.rows.some(row => /private|external/.test(row.id)));
      found.unshift(...page.rows);
      if (!page.more) break;
      before = page.oldest;
    }
    assert.deepEqual(found.map(r => r.id), records.slice(0,163).map(r => r.id));
    assert.equal(new Set(found.map(r => r.id)).size, 163);
    const newer = await dialoguePage(memory, { after: { ts: found[39].ts, id: found[39].id } }, 'work');
    assert.deepEqual(newer.rows.map(r => r.id), found.slice(40,80).map(r => r.id));
    const privatePage = await dialoguePage(memory, {}, 'private');
    assert(privatePage.rows.some(r => r.id === 'private-message'));
    await assert.rejects(dialoguePage(memory, { before: { ts: -1, id: 'bad' } }, 'work'));
    await assert.rejects(dialoguePage(memory, { before: { ts: 1, id: 'a' }, after: { ts: 2, id: 'b' } }, 'work'));
  } finally { await memory.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
