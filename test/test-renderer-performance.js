const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  const { createPerformanceOccupancy } = await import('../src/renderer/performance-occupancy.mjs');
  const { performancePlaybackPlan } = await import('../src/renderer/performance-playback.mjs');
  const source = fs.readFileSync('src/renderer/app.js', 'utf8');
  const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const context = vm.createContext({ createPerformanceOccupancy, performancePlaybackPlan, console, performance: { now: () => 100 },
    setTimeout: fn => { context.timer = fn; return 1; }, clearTimeout: () => { context.timer = null; } });
  vm.runInContext(`
    var events = [], played = [], idleCount = 0, avatarKey = 'avatar', dataAvatar = null;
    var pet = { motionStarted: e => events.push(e), bodyPosture: e => events.push(e) };
    var MOTIONS = [{key:'run', posture:'standing'}, {key:'sit', posture:'sitting'}, {key:'bridge', posture:'standing'}, {key:'idle', posture:'standing', loop:true}, {key:'loop', posture:'standing', loop:true}];
    var cfg = {}, FADE = .26, activeTransition = null, pendingMotion = null, motionRequestRevision = 0;
    var bodyPosture = 'standing', SIT_ENTER = 'bridge', SIT_EXIT = 'bridge', SIT_IDLE = 'idle', IDLE = 'idle', idleKey = 'idle';
    var loading = false, expressiveUntil = 0, currentAction = null, currentMotion = null, motionActions = new Set();
    var clips = new Map(MOTIONS.map(m => [m.key, {key:m.key, duration:2}]));
    var resolveLoad = null, delayLoads = false;
    function loadMotion() { return delayLoads ? new Promise(r => { resolveLoad = r; }) : Promise.resolve(true); }
    function motionEnabled(key) { return MOTIONS.some(m => m.key === key); }
    function clipFor(key) { return clips.get(key); }
    function randomIdle() { return 'idle'; }
    function paintMotionActive() {}
    function toIdle() { idleCount++; playMotion('idle', {loop:true}); }
    function crossFadeMotionAction(next) { next.play(); }
    var THREE = { LoopRepeat: 1, LoopOnce: 2, AnimationMixer: class {
      constructor() { mixer = this; this.actions = new Map(); }
      addEventListener(name, cb) { this.finished = cb; }
      clipAction(clip) {
        if (!this.actions.has(clip.key)) this.actions.set(clip.key, { key:clip.key,
          setEffectiveTimeScale(){}, setLoop(){}, setEffectiveWeight(){}, reset(){return this;},
          play(){played.push(this.key); return this;} });
        return this.actions.get(clip.key);
      }
    }};
    var mixer = new THREE.AnimationMixer();
    ${part('const performanceBody =', '\nlet emoTimer =')}
    ${part('function playMotion(', '\n/* ═══════════ 槽位')}
    ${part('function playOneShot(', '\nconst AWAY_MS')}
    ${part('function cancelPendingMotion()', '\nlet queuedAvatar =')}
    ${part("  mixer.addEventListener('finished'", '\n}')}
    async function dispatchEvent(ev) { switch (ev.type) { ${part("      case 'motion': {", "      case 'emo':")} } }
  `, context);
  const run = code => vm.runInContext(code, context);
  const dispatch = id => run(`performanceBody.begin({key:'run', requestId:'r-${id}', performanceId:'${id}', reason:'performance'}, avatarKey)`);

  // A cancelled slow load cannot start or produce a late failure receipt.
  run('delayLoads = true'); dispatch('slow');
  const slow = run("requestMotion({key:'run', requestId:'r-slow', performanceId:'slow', reason:'performance'})");
  run("cancelPerformance('slow'); resolveLoad(true)"); await slow;
  assert.deepEqual(Array.from(context.played), ['idle']);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['cancelled']);
  assert.equal(run("performanceBody.begin({key:'run', performanceId:'slow'}, avatarKey)"), null);

  // During load, automatic action is suppressed. A late completion from an old
  // action cannot release the new owner; only the owner's finished event can.
  run('events = []; played = []; delayLoads = true'); const newer = dispatch('new');
  const pending = run("requestMotion({key:'run', requestId:'r-new', performanceId:'new', reason:'performance'})");
  assert.equal(run("playMotion('idle', {reason:'thinking'})"), false);
  assert.equal(run('performanceBody.finish({performanceId:"new"})'), false);
  run('resolveLoad(true)'); await pending;
  assert.deepEqual(Array.from(context.played), ['run']);
  assert.equal(run('performanceBody.current().performanceId'), 'new');
  run("finishPerformance(performanceBody.current(), 'finished')");
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['started', 'finished']);
  assert.equal(run('performanceBody.current()'), null);

  // Cancellation during a posture bridge retires the queued target and lets the
  // bridge settle before idle, without falsely updating the posture early.
  run("events = []; played = []; delayLoads = false; currentAction = null; bodyPosture = 'standing'");
  run("performanceBody.begin({key:'sit', requestId:'r-bridge', performanceId:'bridge-id', reason:'performance'}, avatarKey)");
  await run("requestMotion({key:'sit', requestId:'r-bridge', performanceId:'bridge-id', reason:'performance', allowPostureChange:true})");
  assert.equal(run('activeTransition.to'), 'sitting');
  run("cancelPerformance('bridge-id')");
  assert.equal(run('bodyPosture'), 'standing');
  assert.equal(run('pendingMotion'), null);
  assert.deepEqual(Array.from(context.played), ['bridge']);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['cancelled']);
  run('mixer.finished({action:currentAction})');
  assert.equal(run('bodyPosture'), 'sitting');
  assert.deepEqual(Array.from(context.played), ['bridge', 'idle']);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['cancelled']);

  // A performance reusing the current clip must restart it, including if that
  // action previously completed once and is now requested as a loop.
  run("events = []; played = []; activeTransition = null; currentAction = null; bodyPosture = 'standing'");
  run("playMotion('loop', {loop:false})");
  await run("dispatchEvent({type:'motion', key:'loop', reason:'performance', performanceId:'same-clip', requestId:'r-same', holdMs:4000})");
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(Array.from(context.played), ['loop', 'loop']);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['started']);
  run("cancelPerformance('same-clip')");

  // An invalid newer request during an older bridge must retire that bridge's
  // queued target; after the bridge settles it returns to idle, not the old one.
  run("events = []; played = []; currentAction = null; bodyPosture = 'standing'");
  await run("requestMotion({key:'sit', requestId:'old-manual', reason:'manual', allowPostureChange:true})");
  assert.equal(run('pendingMotion.key'), 'sit');
  await run("dispatchEvent({type:'motion', key:'missing', reason:'performance', performanceId:'invalid', requestId:'r-invalid'})");
  assert.equal(run('pendingMotion'), null);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['failed']);
  run('mixer.finished({action:currentAction})');
  assert.equal(run('bodyPosture'), 'sitting');
  assert.deepEqual(Array.from(context.played), ['bridge', 'idle']);

  // Exercise the actual data-avatar dispatch branch and its bounded loop hold.
  run(`events = []; played = []; activeTransition = null; bodyPosture = 'standing';
    dataAvatar = {defaultIdle:'idle', current:null, play({key}) { played.push(key); this.current = {loop:key === 'run'}; return {ok:true}; }};`);
  await run("dispatchEvent({type:'motion', key:'run', reason:'performance', performanceId:'data', requestId:'r-data', holdMs:4000})");
  await run("dispatchEvent({type:'motion', key:'sit', reason:'task', requestId:'r-task'})");
  assert.deepEqual(Array.from(context.played), ['run']);
  run('timer()');
  assert.deepEqual(Array.from(context.played), ['run', 'idle']);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['started', 'finished']);
  assert.equal(run('performanceBody.current()'), null);

  // The new policy uses the data runtime's actual duration, sends the finite
  // repetition count and does not install the legacy mid-cycle wall timer.
  run(`events = []; played = []; dataAvatar.getActionDuration = () => .6;
    dataAvatar.play = ({key, repetitions}) => { played.push({key, repetitions}); dataAvatar.current = {loop:repetitions > 1}; return {ok:true}; };`);
  await run("dispatchEvent({type:'motion', key:'run', reason:'performance', performanceId:'data-cycles', requestId:'r-cycles', performancePlayback:{mode:'cycle', targetMs:4000}})");
  assert.equal(context.played[0].repetitions, 7);
  assert.equal(context.events[0].playback.totalDurationMs, 4200);
  assert.equal(context.timer, null);
  await run("dispatchEvent({type:'motion', cancelPerformance:'data-cycles'})");
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['started','cancelled']);

  // The installed data-avatar onFinished callback releases the matching owner.
  run(`events = []; played = []; var key = avatarKey, nextData = dataAvatar;`);
  await run("dispatchEvent({type:'motion', key:'sit', reason:'performance', performanceId:'data-once', requestId:'r-once'})");
  const callback = part('finishedKey => {\n        if (dataAvatar === nextData', '\n      }');
  run(`var dataFinished = ${callback}\n}; dataFinished('sit')`);
  assert.equal(run('performanceBody.current()'), null);
  assert.deepEqual(Array.from(context.events, e => e.phase).filter(Boolean), ['started', 'finished']);
  assert.equal(run('currentMotion'), 'idle');

  // Rolling back an unmounted replacement to the old live avatar must
  // reconfirm body readiness, even though no resource needs reloading.
  run(`events = []; var AVATARS = {avatar:{}}, avatarSwitchRevision = 0, loading = false, vrm = null;
    pet.bodyReady = e => events.push({bodyReady:e});
    ${part('async function switchAvatar(', '\n/* 重扫模型目录')}`);
  await run("switchAvatar('avatar', {persist:false})");
  assert.equal(context.events.at(-1).bodyReady.avatar, 'avatar');

  // Retired IDs are bounded and stale end notifications cannot retire a newer owner.
  const reports = [], occupancy = createPerformanceOccupancy(e => reports.push(e), 2);
  const old = occupancy.begin({key:'a', performanceId:'a', requestId:'1'}, 'avatar');
  assert.equal(occupancy.begin({key:'a', performanceId:'a', requestId:'duplicate'}, 'avatar'), null);
  assert.equal(occupancy.current(), old);
  const live = occupancy.begin({key:'b', performanceId:'b', requestId:'2'}, 'avatar');
  assert.equal(occupancy.finish(old), false);
  assert.equal(occupancy.current(), live);
  occupancy.cancel('b'); occupancy.cancel('c');
  assert.ok(occupancy.begin({key:'a', performanceId:'a', requestId:'3'}, 'avatar'));
  assert.deepEqual(reports.map(e => e.phase), ['cancelled', 'cancelled']);
  console.log('renderer performance lifecycle: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
