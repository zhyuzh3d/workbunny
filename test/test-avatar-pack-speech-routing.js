'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {validateInteractionMap,AvatarInteractionPicker}=require('../src/main/avatar-interactions');
const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8'),handler=source.slice(source.indexOf("ipcMain.handle('pet:interact'"),source.indexOf("ipcMain.handle('pet:init'"));
function fixture(){
 let now=5000, current='pack_test', digest='rev1', resolveMotion, pending=false, handle;const events=[],speechQueue=[];
 const interactions=validateInteractionMap({regions:[{id:'ear',pool:'ear',hitVolumes:[{type:'sphere',anchor:'head',size:[1,1,1]}]}],pools:{ear:[{action:'wave',speech:{text:'你好呀！',emotion:'happy'}}]}},{actionIds:new Set(['wave']),anchorIds:new Set(['head'])});
 const pack={entry:{key:'pack_test',digest:'rev1'},interactions,catalog:{keyFor:id=>'ns_'+id,select:()=>true}};
 const ctx={ipcMain:{handle(_name,fn){handle=fn}},win:{webContents:{}},config:{load:()=>({avatar:current,motions:{disabled:[]}})},Date:class extends Date{static now(){return now}},Set,Map,require,
  desktop:null,busy:false,speaking:false,speakerFilter:{enrollment:null},lastSpokeAt:0,quietUntil:0,activeAvatarPack:()=>digest?{...pack,entry:{...pack.entry,digest}}:null,
  avatarPackPickers:new Map([['pack_test',new AvatarInteractionPicker({clock:()=>now,random:()=>0})]]),embodiment:{perform:()=>pending?new Promise(r=>{resolveMotion=r}):Promise.resolve({ok:true})},
  speechQueue,pumpSpeech(){events.push('pump')},presentedReplies:new Set(),publishWebSources(){},send:(type,value)=>events.push({type,...value})};
 vm.runInNewContext(handler,ctx);return {call:()=>handle({sender:ctx.win.webContents},{avatar:'pack_test',digest:'rev1',region:'ear'}),events,speechQueue,ctx,advance:()=>{now+=1500},switch:()=>{current='other'},changeDigest:()=>{digest='rev2'},hold:()=>{pending=true},finish:()=>resolveMotion({ok:true})};
}
test('spoken reaction follows confirmed action and quiet mode suppresses audio only',async()=>{const f=fixture(),r=await f.call();assert.equal(r.motion,'ns_wave');assert.equal(f.speechQueue.length,1);assert.equal(f.speechQueue[0].text,'你好呀！');assert.equal(f.speechQueue[0].emo,'happy');assert.equal(f.speechQueue[0].motion,'ns_wave');assert(f.events.some(e=>e.type==='say'));f.advance();f.ctx.quietUntil=999999;await f.call();assert.equal(f.speechQueue.length,1);assert.equal(f.events.filter(e=>e.type==='say').length,2)});
test('stale avatar or package revision cannot trigger speech after action confirmation',async()=>{for(const change of ['switch','changeDigest']){const f=fixture();f.hold();const promise=f.call();f[change]();f.finish();assert.equal(await promise,null);assert.equal(f.speechQueue.length,0);assert.equal(f.events.length,0)}});
