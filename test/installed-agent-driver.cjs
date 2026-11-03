'use strict';
// Explicit local developer driver for the installed app's real renderer/IPC.
// Run with Electron's Node mode. Never expose the temporary debug port remotely.
const fs=require('fs'),path=require('path');
async function connect(target){
 const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 let id=0;const pending=new Map();socket.addEventListener('message',event=>{const v=JSON.parse(event.data);const p=pending.get(v.id);if(p){pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}});
 socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Local debugger connection closed'));}pending.clear();});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP command timed out'));},90000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
 return {send,close:()=>socket.close(),evaluate:async expression=>{const value=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.text+' '+value.exceptionDetails.exception?.description);return value.result.value;}};
}
async function main(){
 const [operation,...args]=process.argv.slice(2),targets=await(await fetch('http://127.0.0.1:9227/json')).json();
 const page=operation==='open'?targets.find(t=>t.type==='page'&&!t.url.includes('companion.html')):targets.find(t=>t.type==='page'&&t.url.includes('companion.html')&&t.url.includes('desktop'));
 if(!page||!page.url.startsWith('file:///Users/zhyuzh/Applications/workbunny.app/Contents/Resources/app/src/renderer/'))throw Error('Expected installed renderer is not available');const c=await connect(page);
 try{
  if(operation==='open'){await c.evaluate('pet.open("desktop")');console.log(JSON.stringify({opened:true}));}
  else if(operation==='status')console.log(JSON.stringify(await c.evaluate('(async()=>({version:(await pet.init()).versions.app,...await pet.agentStatus()}))()')));
  else if(operation==='command')console.log(JSON.stringify(await c.evaluate('pet.agentCommand('+JSON.stringify(args.join(' '))+')')));
  else if(operation==='control')console.log(JSON.stringify(await c.evaluate('pet.agentControl('+JSON.stringify(args[0])+','+JSON.stringify(args[1])+')')));
  else if(operation==='submit'){await c.evaluate('document.querySelector("#agentCommand").value='+JSON.stringify(args.join(' '))+';document.querySelector("#agentSubmit").click()');console.log(JSON.stringify({submittedThroughUI:true}));}
  else if(operation==='screenshot'){const png=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(args[0],Buffer.from(png.data,'base64'),{mode:0o600});console.log(JSON.stringify({file:path.resolve(args[0])}));}
  else if(operation==='quit'){await c.evaluate('pet.quit()');console.log(JSON.stringify({normalQuitRequested:true}));}
  else throw Error('Unsupported driver command');
 }finally{c.close();}
}
module.exports={connect};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
