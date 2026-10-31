'use strict';

const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { readAvatarPackZip } = require('./avatar-pack-zip');
const { validatePackManifest } = require('./avatar-pack-manifest');
const { inspectAvatarGLB } = require('./avatar-pack-glb');
const { AvatarActionCatalog } = require('./avatar-action-catalog');
const { validateInteractionMap } = require('./avatar-interactions');

const FEATURES = new Set(['transform-timeline-v1', 'hit-volumes-v1', 'spring-bone-v1', 'morph-target-v1', 'material-color-v1', 'dual-quaternion-skin-v1', 'soft-surface-v1']);
const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const NODE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function assert(condition, message) { if (!condition) throw Error(message); }
function jsonFile(files, name, limit = 4 * 1024 * 1024) {
  const data = files.get(name);
  assert(data && data.length <= limit, 'invalid pack JSON size');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw Error(`invalid pack JSON: ${name}`); }
}

// All paths here are keys in an already bounded in-memory archive. This is a
// validation step, not an installer and not a permission to execute pack code.
async function inspectAvatarPack(bytes) {
  const { manifest, files } = readAvatarPackZip(bytes);
  const metadata = validatePackManifest(manifest, files, { supportedFeatures: FEATURES });
  if (metadata.runtime === 'soft-surface-v1') {
    assert(manifest.requires.features.includes('soft-surface-v1'), 'missing surface feature');
    const namespace = 'p' + crypto.createHash('sha256').update(`${metadata.id}\0${metadata.characterId}`).digest('hex').slice(0, 20);
    const actionData = jsonFile(files, metadata.actions), graph = jsonFile(files, metadata.graph);
    assert(onlyKeys(actionData, ['categories', 'actions']), 'invalid action catalog');
    const catalog = new AvatarActionCatalog({ namespace, defaultIdle: metadata.defaultIdle, ...actionData });
    const { validateSurfaceModel, validateSurfaceGraph, SURFACE_ANCHORS } = require('./avatar-soft-surface-schema');
    validateSurfaceModel(jsonFile(files, metadata.model, 16 * 1024 * 1024));
    validateSurfaceGraph(graph, catalog);
    const actionIds = new Set(catalog.motions.map(item => item.localId));
    const interactions = metadata.interactions ? validateInteractionMap(jsonFile(files, metadata.interactions), { actionIds, anchorIds: SURFACE_ANCHORS }) : { regions: [], pools: {} };
    assert(!interactions.regions.length || manifest.requires.features.includes('hit-volumes-v1'), 'missing hit-volume feature');
    return { manifest, metadata, files, catalog, interactions, runtime: { engine: 'soft-surface-v1', namespace, model: metadata.model,
      features: [...manifest.requires.features], defaultIdle: metadata.defaultIdle, palette: graph.palette, palettes: graph.palettes || [], defaultPalette: graph.defaultPalette || null,
      actions: graph.actions, regions: interactions.regions } };
  }
  const model = inspectAvatarGLB(files.get(metadata.model));
  if (manifest.requires.features.includes('dual-quaternion-skin-v1')) {
    assert(Array.isArray(model.doc.skins) && model.doc.skins.length > 0 && model.doc.nodes?.some(node => Number.isInteger(node.skin) && Number.isInteger(node.mesh)), 'missing skinned model');
  }
  const actionData = jsonFile(files, metadata.actions), graph = jsonFile(files, metadata.graph);
  assert(onlyKeys(actionData, ['categories', 'actions']) && onlyKeys(graph, ['bindings', 'anchors', 'actions', 'springs']), 'invalid avatar pack graph');
  const namespace = 'p' + crypto.createHash('sha256').update(`${metadata.id}\0${metadata.characterId}`).digest('hex').slice(0, 20);
  const catalog = new AvatarActionCatalog({ namespace, defaultIdle: metadata.defaultIdle, ...actionData });
  assert(Array.isArray(graph.bindings) && graph.bindings.length <= 256 && Array.isArray(graph.anchors) && graph.anchors.length <= 256 &&
    Array.isArray(graph.actions) && graph.actions.length === catalog.motions.length, 'invalid avatar pack graph');
  const bindingPath = pathToFileURL(path.join(__dirname, '../shared/avatar-binding-schema.mjs')).href;
  const { validateAvatarBindings } = await import(bindingPath);
  const bindings = validateAvatarBindings(graph.bindings, model.nodeNames);
  const channels = new Set(bindings.map(binding => binding.channel)), anchors = new Set();
  for (const binding of bindings) {
    const feature = binding.transform === 'morph' ? 'morph-target-v1' : binding.transform === 'color' ? 'material-color-v1' : 'transform-timeline-v1';
    assert(manifest.requires.features.includes(feature), 'missing animation feature');
    if (binding.transform === 'morph' || binding.transform === 'color') {
      const node = (model.doc.nodes || []).find(item => item.name === binding.node), mesh = model.doc.meshes?.[node?.mesh];
      assert(Array.isArray(mesh?.primitives) && mesh.primitives.length === 1, 'invalid animated mesh');
      if (binding.transform === 'morph') assert(Array.isArray(mesh.primitives[0].targets) && binding.index < mesh.primitives[0].targets.length, 'invalid morph target');
    }
  }
  for (const anchor of graph.anchors) {
    assert(onlyKeys(anchor, ['id', 'node']) && ID.test(anchor.id || '') && !anchors.has(anchor.id) && NODE_NAME.test(anchor.node || '') && model.nodeNames.has(anchor.node), 'invalid graph anchor');
    anchors.add(anchor.id);
  }
  const timelinePath = pathToFileURL(path.join(__dirname, '../renderer/avatar-timeline.mjs')).href;
  const { compileAvatarTimeline } = await import(timelinePath);
  const springPath = pathToFileURL(path.join(__dirname, '../shared/avatar-spring-schema.mjs')).href;
  const { validateAvatarSprings } = await import(springPath);
  const springs = validateAvatarSprings(graph.springs || [], model.nodeNames);
  const actionIds = new Set(), metadataById = new Map(catalog.motions.map(item => [item.localId, item]));
  for (const action of graph.actions) {
    assert(onlyKeys(action, ['id', 'loop', 'timeline']) && metadataById.has(action.id) && !actionIds.has(action.id), 'invalid graph action');
    const item = metadataById.get(action.id), timeline = compileAvatarTimeline(action.timeline, { allowedChannels: channels });
    assert(Math.abs(timeline.duration - item.duration) < 1e-6 && (action.loop === true) === item.loop, 'action metadata does not match graph');
    for (const track of timeline.tracks) for (const frame of track.frames) assert(!Array.isArray(frame.value), 'transform track must be scalar');
    actionIds.add(action.id);
  }
  const interactions = metadata.interactions ? validateInteractionMap(jsonFile(files, metadata.interactions), { actionIds, anchorIds: anchors }) : { regions: [], pools: {} };
  assert(!interactions.regions.length || manifest.requires.features.includes('hit-volumes-v1'), 'missing hit-volume feature');
  assert(!springs.length || manifest.requires.features.includes('spring-bone-v1'), 'missing spring feature');
  return { manifest, metadata, files, catalog, interactions,
    runtime: { namespace, model: metadata.model, features: [...manifest.requires.features], defaultIdle: metadata.defaultIdle,
      bindings, anchors: graph.anchors, actions: graph.actions, springs, regions: interactions.regions } };
}

module.exports = { inspectAvatarPack, FEATURES };
