import * as T from 'three';
import { SoftAppendageRig } from './rig.mjs';
import { SurfaceEyes } from './eyes.mjs';
import { StageEffects } from './effects.mjs';
import { samplePerformance } from './performance.mjs';
import { AvatarHitTest } from '../avatar-hit-test.mjs';

// A host-owned procedural surface preset. Its mesh, animations and interaction
// rules come from a validated data package; packages cannot run scripts.
export class SoftSurfaceRuntime {
  constructor() { this.root = null; this.actions = new Map(); this.elapsed = 0; this.clock = 0; this.current = null; }
  async load(context, descriptor) {
    this.context = context;
    const model = await context.loadSurface(descriptor.model);
    this.root = new T.Group(); this.visualRoot = new T.Group(); this.root.add(this.visualRoot);
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(model.positions, 3)); geometry.setIndex(model.indices);
    geometry.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(model.positions.length), 3)); geometry.computeVertexNormals();
    const fur = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .47, metalness: 0 });
    this.eyeMaterial = new T.MeshStandardMaterial({ color: 0x08070e, roughness: .55 });
    const rim = new T.MeshStandardMaterial({ color: 0xffffff, roughness: .55 });
    this.geometry = geometry; this.model = model;
    this.rig = new SoftAppendageRig(this.visualRoot, geometry, new Float32Array(geometry.attributes.position.array), fur); this.rig.setDebug(false);
    this.eyes = new SurfaceEyes(this.visualRoot, this.eyeMaterial, rim);
    this.base = new T.Color(descriptor.palette.base); this.inner = new T.Color(descriptor.palette.inner);
    this.palettes = descriptor.palettes || []; this.defaultPalette = descriptor.defaultPalette;
    this.blushColor = new T.Color(0xff365c); this.earColor = new T.Color(0xff435d);
    this.eyeBase = new T.Color(0x08070e); this.eyeRed = new T.Color(0xee244a); this.eyeGold = new T.Color(0xffa400); this.eyeBlue = new T.Color(0x1379ec);
    const pos = geometry.attributes.position.array; this.cheeks = new Float32Array(model.well.length); this.earMask = new Float32Array(model.well.length);
    for (let i = 0; i < model.well.length; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      this.cheeks[i] = Math.exp(-(((Math.abs(x) - .55) / .24) ** 2) - (((y + .22) / .18) ** 2)) * Math.max(0, Math.min(1, (z - .42) / .28));
      const u = Math.max(0, Math.min(1, (y - .75) / .48)); this.earMask[i] = u * u * (3 - 2 * u);
    }
    this.lastBlush = -1; this.lastEar = -1; this.recolor(0, 0);
    this.effects = new StageEffects(this.root, this.visualRoot, this.rig, context.camera);
    const nodes = new Map([[ 'head', this.rig.root ]]);
    for (const chain of this.rig.boneChains) for (const bone of chain) nodes.set(bone.name, bone);
    this.hitRegions = new AvatarHitTest(descriptor.regions || [], nodes);
    for (const action of descriptor.actions) {
      const key = `${descriptor.namespace}_${action.id}`;
      this.actions.set(key, { key, loop: action.loop === true, performance: action.performance });
    }
    this.defaultIdle = `${descriptor.namespace}_${descriptor.defaultIdle}`;
    if (!this.actions.get(this.defaultIdle)?.loop) throw Error('Invalid surface idle');
    this.motion = Object.fromEntries(['x','y','z','px','py','pz','axial','squash','inflate','lx','lz','rx','rz','coverL','coverR','earTurn','earClap','earHeart','step','blush','earRed'].map(key => [key, 0]));
    this.longAxis = new T.Vector3(0, 1, 0); this.axial = new T.Quaternion(); this.lastPosition = new T.Vector3();
    this.play({ key: this.defaultIdle, loop: true }); this.update(1 / 120);
  }
  recolor(blush, earRed) {
    if (Math.abs(this.lastBlush - blush) < .012 && Math.abs(this.lastEar - earRed) < .012) return;
    this.lastBlush = blush; this.lastEar = earRed;
    const values = this.geometry.attributes.color.array;
    for (let i = 0; i < this.model.well.length; i++) {
      const w = this.model.well[i], j = i * 3, b = this.cheeks[i] * blush, e = this.earMask[i] * earRed;
      let r = this.base.r + (this.inner.r - this.base.r) * w, g = this.base.g + (this.inner.g - this.base.g) * w, blue = this.base.b + (this.inner.b - this.base.b) * w;
      r += (this.blushColor.r - r) * b; g += (this.blushColor.g - g) * b; blue += (this.blushColor.b - blue) * b;
      values[j] = r + (this.earColor.r - r) * e; values[j + 1] = g + (this.earColor.g - g) * e; values[j + 2] = blue + (this.earColor.b - blue) * e;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }
  getCapabilities() { return { features: ['soft-surface-v1'], expressions: [] }; }
  setPalette(id) {
    const palette = this.palettes.find(p => p.id === id) || this.palettes.find(p => p.id === this.defaultPalette);
    if (!palette || this.paletteId === palette.id) return;
    this.paletteId = palette.id; this.base.set(palette.base); this.inner.set(palette.inner);
    const blush = Math.max(0, this.lastBlush), ear = Math.max(0, this.lastEar);
    this.lastBlush = -1; this.lastEar = -1; this.recolor(blush, ear);
  }
  getActions() { return [...this.actions.keys()]; }
  play(request) {
    const action = this.actions.get(request?.key); if (!action) return { ok: false, error: 'unknown-action' };
    for (const axis of ['py', 'pz']) this.motion[axis] = ((this.motion[axis] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.transition = { start: this.clock, from: { ...this.motion } };
    this.current = { action, loop: request.loop === undefined ? action.loop : request.loop === true }; this.elapsed = 0;
    return { ok: true };
  }
  update(delta) {
    if (!this.current || !Number.isFinite(delta) || delta <= 0) return;
    const dt = Math.min(delta, .05); this.clock += dt; this.elapsed += dt;
    let current = this.current, piece = current.action.performance;
    if (this.elapsed >= piece.duration) {
      if (piece.turns) for (const axis of ['py', 'pz']) if (piece.turns[axis]) this.motion[axis] -= piece.turns[axis] * Math.PI * 2;
      if (current.loop) this.elapsed %= piece.duration;
      else { this.current = null; this.context.onFinished?.(current.action.key); if (!this.current) this.play({ key: this.defaultIdle, loop: true }); current = this.current; piece = current.action.performance; }
    }
    const expression = samplePerformance(piece, this.elapsed), laugh = Math.max(expression.giggle || 0, Math.max(0, (expression.joy - .80) / .20) * .50);
    const laughWave = (Math.sin(this.elapsed * Math.PI * 7.2) + .28 * Math.sin(this.elapsed * Math.PI * 14.4 + .7)) / 1.28;
    expression.laughter = laugh; expression.laughWave = laughWave;
    let mix = 1; if (this.transition) { const u = Math.min(1, (this.clock - this.transition.start) / .16); mix = u * u * (3 - 2 * u); if (u >= 1) this.transition = null; }
    for (const key of Object.keys(this.motion)) this.motion[key] = this.transition ? this.transition.from[key] * (1 - mix) + expression[key] * mix : expression[key];
    const m = this.motion, inflation = 1 + m.inflate * .28, squash = m.squash + laugh * laughWave * .15, scaleY = inflation * (1 - squash * .15);
    const upright = Math.cos(m.pz) > .8 && Math.cos(m.px) > .8 && Math.abs(m.axial) < .15;
    const groundY = .91 * (scaleY - 1); let bodyY = upright ? Math.max(m.y + laugh * Math.max(0, laughWave) * .055, groundY) : m.y;
    this.visualRoot.rotation.set(m.px + laugh * laughWave * .065, m.py, m.pz + laugh * laughWave * .035);
    this.axial.setFromAxisAngle(this.longAxis, m.axial); this.visualRoot.quaternion.multiply(this.axial);
    this.visualRoot.scale.set(inflation * (1 + squash * .10), scaleY, inflation * (1 + squash * .08));
    if (expression.frost > .02) { this.visualRoot.updateMatrix(); const v = this.visualRoot.matrix.elements, bottom = bodyY + v[5] * .76 - (Math.abs(v[1]) * 1.42 + Math.abs(v[5]) * 1.70 + Math.abs(v[9]) * 1.125); bodyY += Math.max(0, -.90 - bottom); }
    this.lastPosition.copy(this.visualRoot.position); this.visualRoot.position.set(m.x, bodyY, m.z);
    if (this.lastPosition.distanceTo(this.visualRoot.position) > 1.6) this.rig.ready = false;
    this.cameraOffset = Math.max(0, bodyY - .45) * 1.6;
    this.rig.poseSteps(m.step); this.rig.step(dt,
      { x: m.lx, z: m.lz, cover: m.coverL, turn: m.earTurn, clap: m.earClap, heart: m.earHeart },
      { x: m.rx, z: m.rz, cover: m.coverR, turn: m.earTurn, clap: m.earClap, heart: m.earHeart }, expression.frost);
    this.eyes.update('idle', this.elapsed, dt, expression); this.recolor(m.blush, m.earRed);
    this.eyeMaterial.color.copy(this.eyeBase).lerp(this.eyeRed, expression.red).lerp(this.eyeGold, expression.gold).lerp(this.eyeBlue, expression.blue);
    this.effects.update(piece, this.elapsed, expression);
  }
  hitTest(raycaster, options) { return this.hitRegions?.hitTest(raycaster, options) || null; }
  stop() { this.current = null; }
  dispose() {
    this.hitRegions?.dispose(); this.hitRegions = null; this.current = null; this.actions.clear();
    if (this.root) this.context?.disposeRoot?.(this.root);
    for (const texture of this.effects?.wordTextures?.values() || []) texture.dispose();
    this.root = null; this.visualRoot = null; this.effects = null; this.rig = null;
  }
}
