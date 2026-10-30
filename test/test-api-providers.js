'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const config = require('../src/main/config'), catalog = require('../src/main/model-catalog'), llm = require('../src/main/llm');
const doubao = require('../src/main/doubao-tts'), tts = require('../src/main/tts');
test('dedicated providers preserve independent connections, redact all keys and validate addresses', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-api-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  config.setPath(path.join(dir,'config.json'));
  for (const id of ['deepseek','grok','openai']) config.save({ brain: { source:'apikey', provider:id, profiles:{ [id]:{ apiKey:'private-'+id, modelId: id==='openai'?'gpt-5.2':id==='grok'?'grok-4.7':'deepseek-flash', thinking:'none' } } } });
  for (const id of ['deepseek','grok','openai']) {
    const L = config.resolveLLM(config.preview({brain:{provider:id}}));
    assert.equal(L.provider,id); assert.equal(L.apiKey,'private-'+id); assert.equal(L.transport,'apikey');
    assert.equal(L.extraBody.reasoning_effort,id==='grok'?'low':'none');
  }
  config.save({tts:{doubao:{apiKey:'private-voice'}}});
  assert(!JSON.stringify(config.publicConfig()).includes('private-'));
  config.setPath(path.join(dir,'config.json')); assert.equal(config.load().brain.source,'apikey'); assert.equal(config.resolveLLM().provider,'openai');
  assert.throws(()=>config.save({brain:{profiles:{openai:{baseURL:'https://u:pass@example.com'}}}}),/凭据/);
  assert.throws(()=>config.save({tts:{doubao:{url:'https://example.com/?api_key=secret'}}}),/凭据/);
  assert.equal(config.load().brain.profiles.openai.apiKey,'private-openai');
  assert.deepEqual(catalog.apiThinking('deepseek','deepseek-flash','medium'),{thinking:{type:'enabled'},reasoning_effort:'medium'});
  assert.deepEqual(catalog.apiThinking('grok','grok-3-mini','medium'),{reasoning_effort:'low'});
  assert.deepEqual(catalog.apiThinking('openai','gpt-4.1','high'),{});
});
test('real HTTP model discovery, SSE conversation and Doubao JSON audio adapter use the selected protocol', async t=>{
  let seen; const audio=Buffer.alloc(4800,1), encoded=audio.toString('base64');
  const server=http.createServer((q,r)=>{
    const b=[]; q.on('data',x=>b.push(x));q.on('end',()=>{
      seen={url:q.url,headers:q.headers,body:b.length?JSON.parse(Buffer.concat(b)):null};
      if(q.url==='/models') return r.end(JSON.stringify({data:[{id:'gpt-5.2'},{id:'text-embedding-3-small'},{id:'gpt-image-1'}]}));
      if(q.url==='/error'){r.writeHead(401);return r.end('never-echo-secret');}
      if(q.url==='/tts')return r.end(JSON.stringify({code:0,data:encoded})+'\n'+JSON.stringify({code:20000000,data:null})+'\n');
      if(q.url==='/eof')return r.end(JSON.stringify({code:0,data:encoded})+'\n');
      if(q.url==='/truncated')return r.end('{"code":0,"data":');
      r.setHeader('content-type','text/event-stream');
      r.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'hidden',content:'你'}}]})+'\n\n');
      r.end('data: '+JSON.stringify({choices:[{delta:{content:'好。'}}],usage:{completion_tokens:3}})+'\n\ndata: [DONE]\n\n');
    });
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseURL=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();tts.reset();});
  const C=catalog.createCatalog();const list=await C.refresh('openai','private-key',baseURL);assert.deepEqual(list.models.map(m=>m.id),['gpt-5.2']);
  for (const provider of ['openai','deepseek','grok']) {
    const result=await llm.chat({provider,baseURL,apiKey:'private-key',model:'fixture',maxTokens:512,messages:[{role:'user',content:'hi'}]});
    assert.equal(result.text,'你好。');assert.equal(seen.headers.authorization,'Bearer private-key');assert.equal(seen.url,'/chat/completions');
    assert.equal(seen.body[provider==='openai'?'max_completion_tokens':'max_tokens'],512);
    assert(!('temperature' in seen.body));
  }
  const voice={enabled:true,engine:'doubao',doubao:{apiKey:'private-voice',url:baseURL+'/tts',model:'seed-tts-2.0',voice:'voice-a'}};
  const a=await tts.synthesize('测试',voice,{strict:true}); assert.equal(a.engine,'doubao');assert.equal(a.voice,'voice-a');assert.equal(a.buffer.length,4844);
  assert.equal(seen.headers['x-api-key'],'private-voice');assert.equal(seen.headers['x-api-resource-id'],'seed-tts-2.0');assert.match(seen.headers['x-api-request-id'],/^[a-f0-9-]{36}$/);
  assert.deepEqual(seen.body.req_params,{text:'测试',speaker:'voice-a',audio_params:{format:'pcm',sample_rate:24000}});
  voice.doubao.voice='voice-b'; const changed=await tts.synthesize('测试',voice,{strict:true});assert(!changed.cached);assert.equal(seen.body.req_params.speaker,'voice-b');
  voice.doubao.model='seed-icl-2.0'; await tts.synthesize('测试',voice,{strict:true});assert.equal(seen.headers['x-api-resource-id'],'seed-icl-2.0');
  const identity=await tts.voiceIdentity(voice);assert(!JSON.stringify(identity).includes('private'));
  assert.equal(seen.body.req_params.model,'seed-tts-2.0-standard');
  voice.doubao.url=baseURL+'/eof';assert.equal((await tts.synthesize('测试',voice,{strict:true})).engine,'doubao');
  voice.doubao.url=baseURL+'/truncated';await assert.rejects(tts.synthesize('测试',voice,{strict:true}),/JSON/);
  voice.doubao.url=baseURL+'/error';await assert.rejects(tts.synthesize('测试',voice,{strict:true}),e=>/401/.test(e.message)&&!e.message.includes('never-echo'));
  const controller=new AbortController();controller.abort();await assert.rejects(doubao.synthesize('取消',voice,{signal:controller.signal}),{name:'AbortError'});
});
test('fixed Grok variants never send reasoning effort; missing keys fail locally and parameter errors are safe', async t=>{
  let requests=0;const server=http.createServer((q,r)=>{requests++;let body='';q.on('data',p=>body+=p);q.on('end',()=>{
    const data=JSON.parse(body);
    if(q.url.startsWith('/unsupported') || 'reasoning_effort' in data){r.writeHead(400);r.end(JSON.stringify({error:'Model does not support parameter reasoningEffort. private-credential-echo'}));return;}
    r.setHeader('Content-Type','text/event-stream');r.end('data: '+JSON.stringify({choices:[{delta:{content:'OK'}}]})+'\n\ndata: [DONE]\n\n');
  });});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const baseURL='http://127.0.0.1:'+server.address().port;
  for(const model of ['grok-4.20-0309-non-reasoning','grok-4.20-0309-reasoning']){
    for(const effort of ['none','low','medium','high']) assert.deepEqual(catalog.apiThinking('grok',model,effort),{});
    const L=config.resolveLLM({brain:{source:'apikey',provider:'grok',profiles:{grok:{apiKey:'fixture-key',baseURL,modelId:model,thinking:'none'}}}});
    assert.equal((await llm.chat({...L,messages:[{role:'user',content:'hi'}]})).text,'OK');
  }
  assert.deepEqual(catalog.apiThinking('grok','grok-4.7','none'),{reasoning_effort:'low'});
  assert.deepEqual(catalog.apiThinking('grok','grok-4.20-multi-agent-0309','high'),{reasoning_effort:'high'});
  const prior=requests;await assert.rejects(llm.chat({transport:'apikey',baseURL,apiKey:'',model:'fixture',messages:[]}),/填写 API Key/);assert.equal(requests,prior);
  await assert.rejects(llm.chat({baseURL:baseURL+'/unsupported',apiKey:'fixture-key',model:'fixture',messages:[]}),e=>e.code==='E_MODEL_PARAMETER'&&/思考参数/.test(e.message)&&!e.message.includes('private-credential-echo'));
});
