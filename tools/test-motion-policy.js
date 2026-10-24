'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const config=require('../src/main/config');
test('all motions start enabled, the final idle cannot be removed, and disabled categories leave the model prompt',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-motion-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));config.setPath(path.join(dir,'config.json'));
 assert.deepEqual(config.load().motions.disabled,[]);
 const idle=config.MOTIONS.filter(m=>m.slot==='idle').map(m=>m.key);
 assert.throws(()=>config.save({motions:{disabled:idle}}),/至少保留一个/);assert.deepEqual(config.load().motions.disabled,[]);
 const disabled=config.MOTIONS.filter(m=>m.slot==='cheer').map(m=>m.key);
 config.save({motions:{disabled}});assert.ok(!config.buildSystemPrompt().includes('cheer（'));config.setPath(path.join(dir,'config.json'));assert.deepEqual(config.load().motions.disabled,disabled);
});
test('the real playback gateway and slot resolver replace disabled, empty and missing actions with an enabled idle',()=>{
 const s=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');
 const playback=s.slice(s.indexOf('function playMotion('),s.indexOf('const AWAY_MS ='));
 const idle=s.slice(s.indexOf('let idleKey = IDLE;'),s.indexOf('/* ═══════════ 表情'));
 const played=[];
 const actions=new Map(config.MOTIONS.map(m=>[m.key,{enabled:true,setEffectiveTimeScale(){},setEffectiveWeight(){},setLoop(loop){this.loop=loop},reset(){return this},play(){played.push({key:m.key,loop:this.loop});return this},crossFadeFrom(){}}]));
 const context={motionActions:new Set(),crossFadeMotionAction(next){next.reset().play()},cfg:{motions:{disabled:config.MOTIONS.filter(m=>m.key!=='idle_breath').map(m=>m.key)}},MOTIONS:config.MOTIONS,clips:new Map(config.MOTIONS.map(m=>[m.key,m])),mixer:{clipAction:m=>actions.get(m.key)},THREE:{LoopRepeat:1,LoopOnce:0},currentAction:null,currentMotion:'',FADE:.2,IDLE:'idle_loop',phase:'idle',paintMotionActive(){},pet:{log(){}},Math};
 vm.createContext(context);vm.runInContext(playback+idle,context);
 for(const key of ['','cheer','cheer_joy','work_maid','not-a-motion']){assert.equal(vm.runInContext(`resolveMotion(${JSON.stringify(key)})`,context),'idle_breath');vm.runInContext(`playMotion(${JSON.stringify(key)})`,context);}
 vm.runInContext('toIdle();rotateIdle()',context);
 assert.ok(played.length);assert.ok(played.every(m=>m.key==='idle_breath'&&m.loop===1));
});
