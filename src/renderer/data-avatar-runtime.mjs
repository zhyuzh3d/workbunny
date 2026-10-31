import { compileAvatarTimeline, sampleAvatarTimeline } from './avatar-timeline.mjs';
import { AvatarHitTest } from './avatar-hit-test.mjs';
import { AvatarSpringChains } from './avatar-spring-chain.mjs';
import { validateAvatarBindings } from '../shared/avatar-binding-schema.mjs';
import { installDualQuaternionSkin } from './avatar-dual-quaternion-skin.mjs';

const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,23}$/;
const ACTION_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const FEATURES = new Set(['transform-timeline-v1', 'hit-volumes-v1', 'spring-bone-v1', 'morph-target-v1', 'material-color-v1', 'dual-quaternion-skin-v1']);
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

// A deliberately small, data-only runtime. Unsupported physical/visual nodes
// fail at load instead of silently rendering a degraded performance.
export class DataAvatarRuntime {
  constructor() {
    this.root = null;
    this.asset = null;
    this.hitRegions = null;
    this.actions = new Map();
    this.bindings = new Map();
    this.current = null;
    this.elapsed = 0;
    this.springs = null;
  }

  async load(context, descriptor) {
    if (this.root || !context || typeof context.loadModel !== 'function') throw new Error('Invalid runtime context');
    if (!onlyKeys(descriptor, ['namespace', 'model', 'features', 'defaultIdle', 'bindings', 'actions', 'anchors', 'regions', 'springs']) ||
        typeof descriptor.namespace !== 'string' || !NAMESPACE.test(descriptor.namespace)) throw new Error('Unsupported runtime descriptor');
    const required = descriptor?.features || [];
    if (!Array.isArray(required) || required.some(feature => !FEATURES.has(feature))) throw new Error('Unsupported avatar runtime feature');
    const asset = await context.loadModel(descriptor.model);
    if (!asset?.root?.isObject3D || typeof asset.dispose !== 'function') {
      asset?.dispose?.();
      throw new Error('Invalid avatar model');
    }
    this.root = asset.root;
    this.asset = asset;
    this.context = context;
    try {
      const nodes = new Map();
      this.root.traverse(node => {
        if (!node.name) return;
        if (nodes.has(node.name)) throw new Error(`Ambiguous model node: ${node.name}`);
        nodes.set(node.name, node);
      });
      if (required.includes('dual-quaternion-skin-v1')) {
        const materials = new Set(); let skinned = 0;
        this.root.traverse(node => {
          if (!node.isSkinnedMesh) return;
          if (!node.geometry?.attributes?.skinIndex || !node.geometry?.attributes?.skinWeight) throw Error('Invalid skinned mesh');
          skinned++;
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material) materials.add(material);
        });
        if (!skinned || !materials.size) throw Error('Missing skinned mesh');
        for (const material of materials) installDualQuaternionSkin(material);
      }
      const bindings = validateAvatarBindings(descriptor.bindings, new Set(nodes.keys()));
      for (const binding of bindings) {
        const node = nodes.get(binding.node);
        const morph = binding.transform === 'morph', color = binding.transform === 'color';
        if (morph && !required.includes('morph-target-v1') || color && !required.includes('material-color-v1') ||
            !morph && !color && !required.includes('transform-timeline-v1')) throw new Error('Missing animation feature');
        const target = morph ? node.morphTargetInfluences : color ? node.material?.color : node[binding.transform];
        const component = morph ? binding.index : binding.component;
        if (!target || typeof target[component] !== 'number') throw new Error('Invalid animation target');
        this.bindings.set(binding.channel, { target, component, initial: target[component] });
      }
      if (!Array.isArray(descriptor.actions) || !descriptor.actions.length || descriptor.actions.length > 512) throw new Error('Invalid runtime actions');
      for (const action of descriptor.actions) {
        const key = `${descriptor.namespace}_${action?.id}`;
        if (!onlyKeys(action, ['id', 'loop', 'timeline']) || !ACTION_ID.test(action.id || '') || key.length > 80 || this.actions.has(key)) throw new Error('Invalid runtime action');
        const timeline = compileAvatarTimeline(action.timeline, { allowedChannels: new Set(this.bindings.keys()) });
        for (const track of timeline.tracks) for (const frame of track.frames) if (Array.isArray(frame.value)) throw new Error('Transform channels require scalar values');
        this.actions.set(key, { id: action.id, key, loop: action.loop === true, timeline });
      }
      this.defaultIdle = `${descriptor.namespace}_${descriptor.defaultIdle}`;
      if (!this.actions.get(this.defaultIdle)?.loop) throw new Error('Invalid runtime idle');
      const anchors = new Map();
      for (const anchor of descriptor.anchors || []) {
        if (!onlyKeys(anchor, ['id', 'node']) || !ID.test(anchor.id || '') || anchors.has(anchor.id) || !nodes.has(anchor.node)) throw new Error('Invalid interaction anchor');
        anchors.set(anchor.id, nodes.get(anchor.node));
      }
      this.hitRegions = new AvatarHitTest(descriptor.regions || [], anchors);
      if (descriptor.springs?.length && !required.includes('spring-bone-v1')) throw new Error('Missing spring feature');
      this.springs = new AvatarSpringChains(this.root, descriptor.springs || [], nodes);
      this.play({ key: this.defaultIdle, loop: true });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  getCapabilities() { return { features: [...FEATURES], expressions: [] }; }
  getActions() { return [...this.actions.keys()]; }

  play(request) {
    const action = this.actions.get(request?.key);
    if (!this.root || !action) return { ok: false, error: 'unknown-action' };
    this.current = { action, loop: request.loop === undefined ? action.loop : request.loop === true };
    this.elapsed = 0;
    this.apply(0);
    return { ok: true };
  }

  apply(time) {
    if (!this.current) return;
    this.springs?.restoreBase();
    for (const binding of this.bindings.values()) binding.target[binding.component] = binding.initial;
    const values = sampleAvatarTimeline(this.current.action.timeline, time);
    for (const [channel, value] of Object.entries(values)) {
      const binding = this.bindings.get(channel);
      binding.target[binding.component] = value;
    }
    this.root.updateMatrixWorld(true);
  }

  update(dt) {
    if (!this.current || !Number.isFinite(dt) || dt < 0) return;
    const current = this.current, duration = current.action.timeline.duration;
    this.elapsed += dt;
    if (current.loop) {
      this.elapsed %= duration;
      this.apply(this.elapsed);
    } else if (this.elapsed >= duration) {
      this.apply(duration);
      this.current = null;
      this.context.onFinished?.(current.action.key);
      if (!this.current && this.root) this.play({ key: this.defaultIdle, loop: true });
    } else this.apply(this.elapsed);
    this.springs?.step(dt);
  }

  hitTest(raycaster, options) { return this.hitRegions?.hitTest(raycaster, options) || null; }
  stop() { this.current = null; }

  dispose() {
    this.hitRegions?.dispose();
    this.hitRegions = null;
    this.springs = null;
    this.current = null;
    this.actions.clear();
    this.bindings.clear();
    this.asset?.dispose();
    this.asset = null;
    this.root = null;
    this.context = null;
  }
}
