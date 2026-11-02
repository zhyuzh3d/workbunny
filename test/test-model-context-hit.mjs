import test from 'node:test';
import assert from 'node:assert/strict';
import { modelContextHit } from '../src/renderer/model-context-hit.mjs';

test('context hit uses rendered alpha, respects viewport offset and rejects transparent pixels', () => {
  let alpha = 255, reads = 0, renderCount = 0, point;
  const gl = { drawingBufferWidth: 800, drawingBufferHeight: 800, RGBA: 1, UNSIGNED_BYTE: 2,
    readPixels(x,y,w,h,format,type,out) { reads++; point = [x,y]; out[3] = alpha; } };
  const renderer = { getContext: () => gl, render: () => renderCount++ };
  const root = { visible: true }, view = { width: 400, height: 400, offsetY: 20 };
  const hit = (x,y) => modelContextHit(root,renderer,{}, {},view,x,y);
  assert.equal(hit(100,120),true); assert.deepEqual(point,[200,599]); assert.equal(renderCount,1);
  alpha = 0; assert.equal(hit(100,120),false, 'transparent part of a mesh does not trigger a menu');
  alpha = 255; assert.equal(hit(100,10),false); assert.equal(hit(401,100),false); assert.equal(reads,2);
  root.visible=false; assert.equal(hit(100,120),false);
});
