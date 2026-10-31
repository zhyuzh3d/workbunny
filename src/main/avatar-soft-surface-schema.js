'use strict';
// Validated data only: the host owns all rendering and simulation code.
const channels = new Set('x y z px py pz axial squash inflate lx lz rx rz gx gy wl wr wide joy angry sad sleepy heart star diamond wavy red gold blue blush earRed coverL coverR earTurn earClap earHeart cry flash giggle fire frost step bx by bz'.split(' '));
const SURFACE_ANCHORS = new Set(['head', ...['left','right'].flatMap(side => Array.from({length:4}, (_, i) => `${side}_ear_${i}`))]);
const object = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const number = (v, limit = 30) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const assert = (v, msg) => { if (!v) throw Error(msg); };
function validateSurfaceModel(model) {
  assert(object(model, ['positions','indices','well']), 'invalid surface model');
  const { positions: p, indices: ix, well: w } = model;
  assert(Array.isArray(p) && p.length >= 9 && p.length <= 450000 && p.length % 3 === 0 && p.every(n => number(n, 10)), 'invalid surface positions');
  assert(Array.isArray(w) && w.length === p.length / 3 && w.every(n => number(n, 1) && n >= 0), 'invalid surface colors');
  assert(Array.isArray(ix) && ix.length >= 3 && ix.length <= 900000 && ix.length % 3 === 0 && ix.every(n => Number.isInteger(n) && n >= 0 && n < w.length), 'invalid surface indices');
}
function validateSurfaceGraph(graph, catalog) {
  assert(object(graph, ['palette','palettes','defaultPalette','actions']) && object(graph.palette,['base','inner']) && Object.values(graph.palette).length === 2 && Object.values(graph.palette).every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)), 'invalid surface palette');
  if (graph.palettes !== undefined) {
    assert(Array.isArray(graph.palettes) && graph.palettes.length > 0 && graph.palettes.length <= 24, 'invalid palette choices');
    const ids = new Set();
    for (const p of graph.palettes) {
      assert(object(p, ['id','label','base','inner']) && typeof p.id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(p.id) && !ids.has(p.id) &&
        typeof p.label === 'string' && p.label.trim() && p.label.length <= 40 && [p.base,p.inner].every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)), 'invalid palette choice');
      ids.add(p.id);
    }
    assert(ids.has(graph.defaultPalette), 'invalid default palette');
  } else assert(graph.defaultPalette === undefined, 'invalid default palette');
  assert(Array.isArray(graph.actions) && graph.actions.length === catalog.motions.length, 'invalid surface actions');
  const seen = new Set(), ids = new Set(), metadata = new Map(catalog.motions.map(m => [m.localId,m]));
  for (const action of graph.actions) {
    assert(object(action,['id','loop','performance']) && metadata.has(action.id) && !seen.has(action.id), 'invalid surface action'); seen.add(action.id);
    const p = action.performance, m = metadata.get(action.id);
    assert(object(p,['id','duration','frames','flights','ballFlights','fx','vfx','orbit','ballSpec','countdown','turns','comic','autoBlink','idea','smokeBoost']), 'invalid performance');
    assert(Number.isInteger(p.id) && p.id >= 0 && p.id <= 10000 && !ids.has(p.id), 'invalid performance id'); ids.add(p.id);
    assert(number(p.duration,300) && p.duration > 0 && Math.abs(p.duration-m.duration) < 1e-6 && (action.loop === true) === m.loop, 'invalid performance duration');
    assert(Array.isArray(p.frames) && p.frames.length >= 2 && p.frames.length <= 128, 'invalid performance frames');
    let last = -1;
    for (const frame of p.frames) {
      assert(Array.isArray(frame) && frame.length >= 2 && frame.length <= 3 && number(frame[0],1) && frame[0] >= 0 && frame[0] > last && object(frame[1], [...channels]) && Object.values(frame[1]).every(v => number(v,10)) && (frame[2] === undefined || ['soft','snap','wind','linear','cut'].includes(frame[2])), 'invalid performance frame'); last = frame[0];
    }
    assert(p.frames[0][0] === 0 && last === 1, 'performance must span entire action');
    for (const key of ['flights','ballFlights']) {
      assert(Array.isArray(p[key]) && p[key].length <= 32, 'invalid flight windows'); let end = 0;
      for (const f of p[key]) { assert(object(f,['from','to','y0','y1']) && [f.from,f.to,f.y0,f.y1].every(v=>number(v,10)) && f.from >= end && f.to > f.from && f.to <= 1, 'invalid flight'); end = f.to; }
    }
    assert(['','ball','snow','fireworks'].includes(p.fx) && ['','speed','spark','love','shock','ice','anger','fire'].includes(p.vfx), 'invalid effect');
    for (const k of ['orbit','countdown','autoBlink','idea','smokeBoost']) assert(typeof p[k] === 'boolean', 'invalid performance flag');
    assert(object(p.turns,['py','pz']) && Object.values(p.turns).every(v=>Number.isInteger(v) && Math.abs(v)<=2), 'invalid turns');
    if (p.ballSpec !== null) { const b=p.ballSpec; assert(object(b,['delay','position','velocity','restitution']) && ['position','velocity'].every(k=>Array.isArray(b[k]) && b[k].length === 3 && b[k].every(v=>number(v))) && (b.delay === undefined || (number(b.delay,300) && b.delay>=0 && b.delay<=p.duration)) && (b.restitution === undefined || (number(b.restitution,1) && b.restitution>=0)), 'invalid ball'); }
    if (p.comic !== null) assert(object(p.comic,['text','kind','hit']) && (p.comic.hit === undefined || ['ear','head'].includes(p.comic.hit)) && typeof p.comic.text === 'string' && p.comic.text.length <= 32 && !/[\x00-\x1f]/.test(p.comic.text) && ['joy','surprise','fireworks','clap','impact','love','wonder','speed','ice','anger','fire','refuse','sleep'].includes(p.comic.kind), 'invalid comic');
  }
}
module.exports = { validateSurfaceModel, validateSurfaceGraph, SURFACE_ANCHORS };
