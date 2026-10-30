'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { layoutWindow } = require('../src/main/window-geometry');
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
