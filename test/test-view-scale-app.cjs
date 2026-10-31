'use strict';
// Production window geometry, real VRM camera and settings, with isolated data/no LLM.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { spawn } = require('node:child_process');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-view-scale-'));
  const config = require('../src/main/config'); config.setPath(path.join(root, 'config.json'));
  config.save({ avatar: 'AvatarSample_D.vrm', window: { w: 520, h: 800, x: 200, y: -180, scale: .5, canvasWidthVersion: 1, canvasExpansionVersion: 2 },
    voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { extract: false } });
  fs.writeFileSync(path.join(root, '.no-restart'), '');
  fs.writeFileSync(path.join(root, 'storage-location.json'), JSON.stringify({ format: 'workbunny-location/v1', dir: path.join(root, 'unavailable/vault') }));
  const wait = condition => `(async()=>{for(let i=0;i<150;i++){if(${condition})return true;await new Promise(r=>setTimeout(r,80));}throw Error('view state timeout')})()`;
  const check = body => `(async()=>{const check=(ok,label)=>{if(!ok)throw Error(label)};${body}})()`;
  const select = scale => `@panel:settings:document.querySelector('#sizeRow [data-k="${scale}"]').click()`;
  const script = [
    wait('window.__pet?.().vrm&&!window.__pet().loading'),
    check(`window.__freeze(true);window.__dock('open');await Promise.all(document.getElementById('dock').getAnimations().map(a=>a.finished));window.__viewState=async()=>{const f=window.__frame(),c=(await window.pet.panelInit()).config.window;
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {w:r.width,h:r.height,cx:c.x+r.x+r.width/2,bottom:c.y-f.viewport.offsetY+r.bottom}};
      return {f,c,ui:['statusRow','dock','ear','muteBtn'].map(rect),head:{x:c.x+f.head.x,y:c.y+f.head.y-f.viewport.offsetY},hips:{x:c.x+f.hips.x,y:c.y+f.hips.y-f.viewport.offsetY},anchor:{x:c.x+f.viewport.width/2,y:c.y+f.viewport.height}}};
      window.__v100=await window.__viewState();check(Math.abs(__v100.ui[0].w-(832*4/7-16)*.8)<.1,'control envelope must be 80%');check(Math.abs(__v100.ui[1].w-358*.8)<.1,'text input must be 80%');return {baseline:true};`),
    'window.pet.open("settings")',
    '@panel:settings:document.querySelector("[data-t=look]").click()',
    '@panel:settings:({halfPreset:document.querySelector(\'#sizeRow [data-k="0.25"]\')?.textContent==="50% 半身"})',
    select(.25),
    wait('window.__frame().scale===.25&&window.__frame().viewport.width===416&&window.__frame().viewport.height===400'),
    check(`const v=await window.__viewState(),old=window.__v100;check(v.f.bust,'half preset remains bust framing');
      check(v.anchor.x===old.anchor.x&&v.anchor.y===old.anchor.y,'bottom center must not move');
      for(let i=0;i<v.ui.length;i++){check(Math.abs(v.ui[i].w-old.ui[i].w)<.1&&Math.abs(v.ui[i].h-old.ui[i].h)<.1,'controls must keep their dimensions');check(Math.abs(v.ui[i].cx-old.ui[i].cx)<.1&&Math.abs(v.ui[i].bottom-old.ui[i].bottom)<.1,'controls must stay anchored');}
      for(const p of ['head','hips'])for(const axis of ['x','y'])check(Math.abs(v[p][axis]-(old.anchor[axis]+(old[p][axis]-old.anchor[axis])*.5))<=2,'model must shrink around UI bottom center: '+p+axis);
      return {halfCanvas:true,fixedControls:true,bottomAnchor:true,halfProjection:true};`),
    select(.5),
    wait('window.__frame().scale===.5&&window.__frame().viewport.width===832'),
    check(`const v=await window.__viewState(),old=window.__v100;check(v.anchor.x===old.anchor.x&&v.anchor.y===old.anchor.y,'restore anchor');check(Math.abs(v.head.y-old.head.y)<=1,'restore bust framing');return {restored:true};`),
    'window.pet.scale(2)',
    wait('window.__frame().scale===2&&window.__frame().viewport.width===1664'),
    check(`const v=await window.__viewState();check(v.ui.every((r,i)=>Math.abs(r.w-window.__v100.ui[i].w)<.1&&Math.abs(r.h-window.__v100.ui[i].h)<.1),'200% controls must remain fixed');return {largeControlsFixed:true};`),
    'window.pet.scale(.25)',
    wait('window.__frame().scale===.25&&window.__frame().viewport.width===416'),
    'window.__freeze(false)',
  ];
  const source = process.argv.includes('--source');
  async function run(script, markers, name) {
    fs.writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ shotDir: path.join(root, name), delay: 4500, every: 300, extra: 0, script }));
    const env = { ...process.env, BUDDY_PET_HOME: root }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.resolve(source ? 'node_modules/.bin/electron' : 'dist/workbunny.app/Contents/MacOS/workbunny'), source ? ['.', '--dev'] : [], { env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      const log = fs.readFileSync(path.join(root, 'buddy.log'), 'utf8'); assert.equal(code, 0, log.slice(-6000));
      for (const marker of markers) assert(log.includes(marker), marker + '\n' + log.slice(-7000));
      assert(!log.includes('ERR:') && !log.includes('[selftest] fail'), log.slice(-8000));
    } finally { clearTimeout(timer); }
  }
  await run(script, ['"baseline":true', '"halfPreset":true', '"halfCanvas":true', '"fixedControls":true', '"bottomAnchor":true', '"halfProjection":true', '"restored":true', '"largeControlsFixed":true'], 'switching');
  await run([wait('window.__pet?.().vrm&&!window.__pet().loading'), check(`const f=window.__frame();check(f.scale===.25&&f.bust&&f.viewport.width===416&&f.viewport.height===400,'half preset must survive restart');return {restartHalf:true};`)], ['"restartHalf":true'], 'restart');
  console.log(JSON.stringify({ ok: true, source, scope: '80% controls + 50% bust canvas + anchored projection + fixed UI + restart', artifacts: root }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
