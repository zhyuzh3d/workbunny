'use strict';
// Explicit real installed-client acceptance. No synthetic task or WeChat API.
// begin: ordinary Bunny chat creates/pauses/resumes a notification-only task.
// finish: after a normal app restart, verify that same task then stop via chat.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {connect}=require('./installed-agent-driver.cjs');
const [phase,directory]=process.argv.slice(2),sleep=ms=>new Promise(r=>setTimeout(r,ms)),local=process.env.BUNNY_LOCAL_CONTROL==='1';
let main,desktop,id;const checks=[];
const save=value=>fs.writeFileSync(path.join(directory,'chat-control.json'),JSON.stringify(value,null,2),{mode:0o600});
async function status(){return desktop.evaluate('pet.agentStatus()');}
async function waitFor(predicate,label){const until=Date.now()+120000;while(Date.now()<until){const state=await status();if(state.circuit)throw Error(state.circuit.reason);const found=predicate(state);if(found)return found;await sleep(800);}throw Error('Timed out: '+label);}
async function say(text){const result=await main.evaluate('pet.say('+JSON.stringify(text)+')');assert(result.ok,result.error);}
async function run(){
 assert(['begin','finish'].includes(phase));assert(path.isAbsolute(directory)&&fs.statSync(directory).isDirectory());
 let targets=await(await fetch('http://127.0.0.1:9227/json')).json();
 const owned=t=>t.type==='page'&&t.url.startsWith('file:///Users/zhyuzh/Applications/workbunny.app/Contents/Resources/app/');
 main=await connect(targets.find(t=>owned(t)&&t.url.includes('/renderer/index.html')));
 await main.evaluate('pet.open("desktop")');await sleep(300);targets=await(await fetch('http://127.0.0.1:9227/json')).json();
 desktop=await connect(targets.find(t=>owned(t)&&t.url.includes('companion.html')&&t.url.includes('desktop')));
 if(phase==='begin'){
  const before=new Set((await status()).tasks.map(t=>t.id));
  const request='请开始一个新任务：只监看 Alice 的微信新消息，每60秒检查，持续10分钟；发现新消息只通知我，不自动回复。';
  if(local)await desktop.evaluate('document.querySelector("#agentCommand").value='+JSON.stringify(request)+';document.querySelector("#agentSubmit").click()');else await say(request);
  const task=await waitFor(s=>s.tasks.find(t=>!before.has(t.id)),'main chat creates task');id=task.id;
  assert.equal(task.skill,'conversation.manage');assert.equal(task.schedule.intervalSeconds,60);assert.equal(task.schedule.durationMinutes,10);assert.equal(task.expiresAt-task.createdAt,600000);
  await waitFor(s=>s.tasks.find(t=>t.id===id&&t.observationReady&&t.status==='waiting'),'real observation baseline');checks.push(local?'TaskUI-admission-and-expiry':'main-dialogue-admission-and-expiry');
  await main.evaluate('window.__controlLabReplies=[];pet.on(e=>{if(e.type==="chat"&&e.role==="assistant"&&e.final)window.__controlLabReplies.push(e.text)})');
  await say(local?'查看代办进度':'告诉我现在 Alice 那项监听任务的实际状态和观察间隔。只查询，不要修改、暂停、停止或新建任务。');
  const until=Date.now()+90000;let reply;
  while(Date.now()<until){reply=await main.evaluate('window.__controlLabReplies.at(-1)');if(reply)break;await sleep(500);}
  assert(reply&&/60/.test(reply),'main chat must report the actual 60-second cadence');assert.equal((await status()).tasks.filter(t=>!before.has(t.id)).length,1);checks.push('main-dialogue-read-only-status');
  await say(local?'暂停当前任务':'暂停刚才那项 Alice 微信监看任务。');await waitFor(s=>s.tasks.find(t=>t.id===id&&t.status==='paused'),'natural pause');checks.push(local?'local-natural-pause':'natural-pause');
  await say(local?'继续原任务':'继续刚才暂停的 Alice 微信监看任务，保留原任务，不新建。');await waitFor(s=>s.tasks.find(t=>t.id===id&&t.status==='waiting'),'natural resume');checks.push(local?'local-natural-resume':'natural-resume');
  const current=(await status()).tasks.find(t=>t.id===id);assert.equal(current.counters.writes,0);save({phase,id,checks,createdAt:task.createdAt,expiresAt:task.expiresAt,beforeRestart:current});
 }else{
  const previous=JSON.parse(fs.readFileSync(path.join(directory,'chat-control.json'),'utf8'));id=previous.id;checks.push(...previous.checks);
  const restored=await waitFor(s=>s.tasks.find(t=>t.id===id&&t.observationReady&&t.status==='waiting'&&t.counters.reads>previous.beforeRestart.counters.reads),'same task restored and freshly observed');assert.equal(restored.expiresAt,previous.expiresAt);assert.equal(restored.counters.writes,0);checks.push('normal-restart-retains-task-cursor-and-expiry');
  await say('停止当前代办');await waitFor(s=>s.tasks.find(t=>t.id===id&&t.status==='stopped'),'local natural stop');checks.push('local-natural-stop-without-model');
  assert.equal((await status()).tasks.filter(t=>!['completed','stopped','expired'].includes(t.status)).length,0);save({...previous,phase,checks,passed:true,stopped:true});
 }
 console.log(JSON.stringify({phase,id,checks,passed:true}));
}
run().catch(async error=>{console.error(error.message);if(id)await desktop?.evaluate('pet.agentControl("stop",'+JSON.stringify(id)+')').catch(()=>{});process.exitCode=1;}).finally(()=>{main?.close();desktop?.close();});
