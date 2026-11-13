import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { performancePlaybackPlan } from '../src/renderer/performance-playback.mjs';
import { createPerformanceOccupancy } from '../src/renderer/performance-occupancy.mjs';
import { DataAvatarRuntime } from '../src/renderer/data-avatar-runtime.mjs';
import { SoftSurfaceRuntime } from '../src/renderer/soft-surface/runtime.mjs';

const policy = { mode: 'cycle', targetMs: 4000 };
test('cycle plan uses actual duration, limits repetitions, and rejects invalid durations', () => {
  assert.deepEqual(performancePlaybackPlan(policy, .6), { mode: 'cycle', cycles: 7, clipDurationMs: 600, totalDurationMs: 4200 });
  assert.equal(performancePlaybackPlan(policy, 5).cycles, 1);
  assert.equal(performancePlaybackPlan(policy, .001).cycles, 128);
  assert.equal(performancePlaybackPlan({mode:'once'}, .6).cycles, 1);
  assert.equal(performancePlaybackPlan(null, undefined), null);
  assert.throws(() => performancePlaybackPlan(policy, 0));
});

test('actual VRMA playback gateway completes seven whole mixer cycles and emits one start and finish', async () => {
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const part = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  const c = vm.createContext({ THREE, performancePlaybackPlan, createPerformanceOccupancy, performance: {now: () => 0}, setTimeout, clearTimeout });
  vm.runInContext(`
    var avatarKey='avatar', dataAvatar=null, currentMotion=null, currentAction=null, activeTransition=null, pendingMotion=null;
    var motionRequestRevision=0, loading=false, expressiveUntil=0, FADE=.26, bodyPosture='standing', SIT_ENTER='sit', SIT_EXIT='stand';
    var events=[], idleCount=0, motionActions=new Set(), mixer=new THREE.AnimationMixer(new THREE.Object3D());
    var MOTIONS=[{key:'short', posture:'standing', loop:false}], clips=new Map([['short',new THREE.AnimationClip('short',.6,[])]]);
    var pet={motionStarted:e=>events.push(e),bodyPosture(){}}, cfg={};
    function motionEnabled(k){return clips.has(k)} function clipFor(k){return clips.get(k)} function randomIdle(){return null}
    function paintMotionActive(){} function toIdle(){idleCount++} function loadMotion(){return Promise.resolve(true)}
    function crossFadeMotionAction(next){next.reset().play()}
    ${part('const performanceBody =', '\nlet emoTimer =')}
    ${part('function playMotion(', '\n/* ═══════════ 槽位')}
    ${part('function playOneShot(', '\nconst AWAY_MS')}
    ${part('function cancelPendingMotion()', '\nlet queuedAvatar =')}
    ${part("  mixer.addEventListener('finished'", '\n}')}
  `, c);
  const run = code => vm.runInContext(code,c);
  run("performanceBody.begin({key:'short',requestId:'req',performanceId:'perf'},avatarKey)");
  await run("requestMotion({key:'short',reason:'performance',requestId:'req',performanceId:'perf',performancePlayback:{mode:'cycle',targetMs:4000}})");
  assert.equal(c.events.length,1);
  assert.equal(c.events[0].playback.cycles,7);
  assert.equal(c.events[0].playback.totalDurationMs,4200);
  for(let i=0;i<40;i++) c.mixer.update(.1);
  assert.equal(c.events.length,1); assert.equal(run('performanceBody.current().performanceId'),'perf');
  c.mixer.update(.201);
  assert.deepEqual(Array.from(c.events,e=>e.phase),['started','finished']);
  assert.equal(c.idleCount,1);
  c.mixer.update(1);
  assert.equal(c.events.length,2);
});

test('data avatar completes finite repetitions at a whole boundary, including a large update', async () => {
  const root=new THREE.Group(), body=new THREE.Group(); body.name='body'; root.add(body);
  const finished=[], runtime=new DataAvatarRuntime();
  const action=(id,duration,loop=false)=>({id,loop,timeline:{duration,tracks:[{channel:'y',frames:[{time:0,value:0},{time:duration,value:0}]}]}});
  await runtime.load({loadModel:async()=>({root,dispose(){}}),onFinished:key=>finished.push(key)},
    {namespace:'test',model:'model.glb',features:['transform-timeline-v1'],defaultIdle:'idle',bindings:[{channel:'y',node:'body',transform:'position',component:'y'}],actions:[action('idle',1,true),action('short',.6),action('story',5)]});
  assert.equal(runtime.getActionDuration('test_short'),.6);
  runtime.play({key:'test_short',repetitions:performancePlaybackPlan(policy,runtime.getActionDuration('test_short')).cycles});
  runtime.update(4.19); assert.deepEqual(finished,[]); assert.equal(runtime.current.action.key,'test_short');
  runtime.update(.02); assert.deepEqual(finished,['test_short']); assert.equal(runtime.current.action.key,'test_idle');
  runtime.update(10); assert.deepEqual(finished,['test_short']);
  runtime.play({key:'test_short',repetitions:7}); runtime.update(9); assert.deepEqual(finished,['test_short','test_short']);
  runtime.play({key:'test_story',repetitions:1}); runtime.update(4); assert.equal(finished.length,2);
  runtime.update(1); assert.deepEqual(finished,['test_short','test_short','test_story']);
  assert.equal(runtime.play({key:'test_short',repetitions:129}).ok,false);
  runtime.dispose();
});

function makeSurface() {
  const runtime=new SoftSurfaceRuntime(), finished=[];
  const make=(key,duration,loop=false)=>({key,loop,performance:{id:key,duration,frames:[[0,{}],[1,{}]],flights:[],ballFlights:[]}});
  for(const a of [make('idle',1,true),make('short',.6),make('story',5)]) runtime.actions.set(a.key,a);
  runtime.defaultIdle='idle'; runtime.root=new THREE.Group(); runtime.visualRoot=new THREE.Group(); runtime.context={onFinished:k=>finished.push(k)};
  runtime.motion=Object.fromEntries(['x','y','z','px','py','pz','axial','squash','inflate','lx','lz','rx','rz','coverL','coverR','earTurn','earClap','earHeart','step','blush','earRed'].map(k=>[k,0]));
  runtime.longAxis=new THREE.Vector3(0,1,0); runtime.axial=new THREE.Quaternion(); runtime.lastPosition=new THREE.Vector3();
  runtime.rig={poseSteps(){},step(){}}; runtime.eyes={update(){}}; runtime.effects={update(){}}; runtime.recolor=()=>{};
  runtime.eyeMaterial={color:new THREE.Color()}; runtime.eyeBase=new THREE.Color(); runtime.eyeRed=new THREE.Color(); runtime.eyeGold=new THREE.Color(); runtime.eyeBlue=new THREE.Color();
  runtime.play({key:'idle'}); return {runtime,finished};
}
test('soft surface finite periodic actions finish once; full theatre and idle retain their timing', () => {
  const {runtime:r,finished}=makeSurface();
  r.play({key:'short',repetitions:performancePlaybackPlan(policy,r.getActionDuration('short')).cycles});
  for(let i=0;i<80;i++) r.update(.05);
  assert.deepEqual(finished,[]); assert.equal(r.current.action.key,'short');
  for(let i=0;i<5;i++) r.update(.05);
  assert.deepEqual(finished,['short']); assert.equal(r.current.action.key,'idle');
  for(let i=0;i<50;i++) r.update(.05);
  assert.deepEqual(finished,['short']);
  r.play({key:'story',repetitions:1});
  for(let i=0;i<90;i++) r.update(.05);
  assert.deepEqual(finished,['short']);
  for(let i=0;i<11;i++) r.update(.05);
  assert.deepEqual(finished,['short','story']);
  assert.equal(r.current.action.key,'idle');
});
