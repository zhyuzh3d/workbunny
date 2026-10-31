'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { layoutWindow } = require('../src/main/window-geometry');
test('actual drag IPC preserves a fast initial displacement and ignores other windows', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const source = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8'), handlers = {};
  const sender = {}, area = { x: 0, y: 25, width: 1920, height: 1080 }; let saves = 0;
  const ctx = { win: { webContents: sender }, windowLayout: layoutWindow({ x: 100, y: 75, width: 832, height: 800 }, area),
    ipcMain: { on: (name, fn) => { handlers[name] = fn; } }, saveWindowPosition: () => saves++,
    placeWindow: rect => { ctx.windowLayout = layoutWindow(rect, area); } };
  vm.runInNewContext(source.slice(source.indexOf('let dragAnchor = null;'), source.indexOf('/* ── 事件推给渲染层')), ctx);
  const drag = handlers['pet:drag']; drag({ sender: {} }, { type: 'start', x: 400, y: 500 });
  drag({ sender }, { type: 'move', x: 400, y: -50 }); assert.equal(ctx.windowLayout.logical.y, 75);
  drag({ sender }, { type: 'start', x: 400, y: 500 }); drag({ sender }, { type: 'move', x: 400, y: -50 });
  assert.equal(ctx.windowLayout.logical.y, -475); assert.equal(ctx.windowLayout.bounds.y, 25); assert(ctx.windowLayout.viewport.offsetY < 0);
  drag({ sender }, { type: 'end' }); assert.equal(saves, 1);
  drag({ sender }, { type: 'move', x: 400, y: 0 }); assert.equal(ctx.windowLayout.logical.y, -475);
});
test('a large logical canvas can move above the menu bar without losing its bottom anchor', () => {
  const area={x:0,y:32,width:1280,height:688};
  const result=layoutWindow({x:200,y:-180,width:832,height:800},area);
  assert.equal(result.logical.y,-180);assert.equal(result.bounds.y,32);assert.equal(result.viewport.offsetY,-212);
  assert.equal(result.bounds.y+result.bounds.height,result.logical.y+result.logical.height);
  assert.equal(result.viewport.height,800);
});
test('screen edges keep at least 160 pixels recoverable and support a monitor above the primary display', () => {
  const area={x:-1440,y:-900,width:1440,height:900};
  for(const y of [-99999,99999]) {const r=layoutWindow({x:-1000,y,width:832,height:1200},area);assert(r.bounds.height>=160);assert(r.bounds.y>=area.y);assert(r.bounds.y+r.bounds.height<=0);}
});
test('Dock height does not constrain the pet canvas, while the menu bar remains excluded',()=>{
 const {canvasArea}=require('../src/main/window-geometry');
 const display={bounds:{x:0,y:0,width:1440,height:900},workArea:{x:0,y:32,width:1440,height:790}};
 const area=canvasArea(display);assert.deepEqual(area,{x:0,y:32,width:1440,height:868});
 const dragged=layoutWindow({x:100,y:500,width:832,height:800},area);
 assert.equal(dragged.logical.y,500);assert.equal(dragged.bounds.y+dragged.bounds.height,900);
 assert(dragged.bounds.y+dragged.bounds.height>display.workArea.y+display.workArea.height);
 assert.equal(layoutWindow({x:100,y:-300,width:832,height:800},area).bounds.y,32);
 const upper={bounds:{x:-1440,y:-900,width:1440,height:900},workArea:{x:-1380,y:-868,width:1380,height:800}};
 assert.deepEqual(canvasArea(upper),{x:-1440,y:-868,width:1440,height:868});
});
test('50% bust halves the production canvas around its bottom center and survives restoring/reloading', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const source = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8');
  const area = { x: 0, y: 32, width: 1920, height: 1080 };
  let settings = { window: { w: 520, h: 800, x: 200, y: -180, scale: .5 } }, actual;
  const ctx = { require, Math, Number, isFinite, clearTimeout,
    config: { load: () => settings, save: patch => { settings = { window: { ...settings.window, ...patch.window } }; } },
    screen: { getDisplayNearestPoint: () => ({ bounds: area, workArea: area }) },
    win: { isDestroyed: () => false, getBounds: () => actual, setBounds: bounds => { actual = bounds; } }, send() {},
  };
  // Resolve the production geometry module relative to index.js.
  ctx.require = name => name === './window-geometry' ? require('../src/main/window-geometry') : require(name);
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const SCALES ='), source.indexOf('function createWindow()')) +
    ';globalThis.geometry = { clampScale, windowSizeFor, applyWindowScale, placeWindow, layout: () => windowLayout };', ctx);
  const g = ctx.geometry;
  g.placeWindow({ x: 200, y: -180, width: 832, height: 800 });
  assert.equal(g.clampScale(.25), .25);
  const small = g.windowSizeFor(.25); assert.equal(small.w, 416); assert.equal(small.h, 400);
  g.applyWindowScale(.25);
  const half = g.layout();
  assert.equal(half.logical.x + half.logical.width / 2, 616);
  assert.equal(half.logical.y + half.logical.height, 620);
  assert.equal(half.logical.width, 416); assert.equal(half.logical.height, 400);
  assert.equal(g.windowSizeFor(settings.window.scale = .25).w, 416, 'saved preset reopens at half size');
  settings.window.scale = .5;
  g.applyWindowScale(.5);
  const restored = g.layout();
  assert.equal(restored.logical.x, 200); assert.equal(restored.logical.y, -180);
  assert.equal(restored.logical.width, 832); assert.equal(restored.logical.height, 800);
  assert.equal(restored.viewport.offsetY, -212, 'restoring preserves offscreen canvas clipping');
});
