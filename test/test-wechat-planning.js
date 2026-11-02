'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DesktopService } = require('../src/main/desktop-service');
const scope = { id:'wechat-fixture', target:'wechat', operation:'send', recipient:'Alice', message:'hello',
 goal:'给Alice发送hello',workModel:'deepseek-v4.1-flash',thinking:'high',steps:[] };
const shot = { preview:'data:image/png;base64,YQ==',ocr:[] };
test('WeChat planning has explicit action JSON and retries only bounded read-only output exhaustion', async()=>{
 const calls=[];
 const s=new DesktopService({native:{},modelRequest:async options=>{
  calls.push(options);
  if(calls.length===1)throw Object.assign(new Error('limit'),{code:'E_OUTPUT_LIMIT'});
  return {text:JSON.stringify({action:'done',completed:false,evidence:'等待可用画面'})};
 }});
 const result=await s.nextAction(scope,shot,new AbortController().signal);
 assert.equal(result.completed,false);assert.equal(calls.length,2);
 assert.deepEqual(calls.map(c=>c.maxTokens),[2048,2048]);
 assert(calls.every(c=>c.thinking==='low'&&c.extraBody.reasoning_effort==='low'));
 assert(calls[0].messages[0].content.includes('"action":"type"'));
 const payload=JSON.parse(calls[0].messages[1].content[0].text);
 assert.equal(payload.recipient,'Alice');assert.equal(payload.windowTarget,undefined);
});
test('WeChat before/after screenshots are in one multimodal turn and do not survive another task',async()=>{
 const calls=[],s=new DesktopService({native:{},modelRequest:async o=>{calls.push(o);return {text:'{"action":"wait"}'};}});
 s.wechatBeforeSubmit={taskId:scope.id,preview:'data:image/png;base64,Yg=='};
 await s.nextAction({...scope,submitAttempted:true},shot,new AbortController().signal);
 assert.equal(calls[0].messages.filter(m=>m.role==='user').length,1);
 assert.equal(calls[0].messages[1].content.filter(p=>p.type==='image_url').length,2);
 await s.nextAction({...scope,id:'another-task',submitAttempted:true},shot,new AbortController().signal);
 assert.equal(calls[1].messages[1].content.filter(p=>p.type==='image_url').length,1);
});
