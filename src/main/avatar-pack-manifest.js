'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const PACK_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EXTENSIONS = new Set(['.glb', '.bin', '.json', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_FILES = 512;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

function assert(condition, message) { if (!condition) throw Error(message); }
function assetPath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 240, 'invalid asset path');
  assert(/^[a-zA-Z0-9_.\-/]+$/.test(value) && !value.startsWith('/') && !value.endsWith('/') &&
    value.split('/').every(part => part && part !== '.' && part !== '..') && path.posix.normalize(value) === value,
  'invalid asset path');
  assert(EXTENSIONS.has(path.posix.extname(value).toLowerCase()), 'unsupported asset type');
  return value;
}

/**
 * Validate the manifest against already-read bytes. Archive extraction, GLB
 * parsing and runtime/node validation remain separate mandatory steps.
 * Nothing from a pack is executed by this function.
 */
function validatePackManifest(manifest, files, { supportedFeatures = new Set() } = {}) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid pack manifest');
  assert(manifest.format === 'workbunny.avatar-pack' && manifest.formatVersion === 1, 'unsupported pack format');
  assert(typeof manifest.id === 'string' && PACK_ID.test(manifest.id), 'invalid pack id');
  assert(typeof manifest.version === 'string' && VERSION.test(manifest.version), 'invalid pack version');
  assert(manifest.requires && ['declarative-3d-v1', 'soft-surface-v1'].includes(manifest.requires.runtime) && Array.isArray(manifest.requires.features), 'unsupported pack runtime');
  assert(manifest.requires.features.length <= 64 && manifest.requires.features.every(feature =>
    typeof feature === 'string' && PACK_ID.test(feature) && supportedFeatures.has(feature)), 'unsupported pack feature');
  assert(new Set(manifest.requires.features).size === manifest.requires.features.length, 'duplicate pack feature');
  assert(manifest.character && PACK_ID.test(manifest.character.id || '') && typeof manifest.character.name === 'string' &&
    manifest.character.name.trim() && manifest.character.name.length <= 80, 'invalid pack character');
  assert(typeof manifest.defaultIdle === 'string' && PACK_ID.test(manifest.defaultIdle), 'invalid default idle');
  const model = assetPath(manifest.character.model), actions = assetPath(manifest.actions), graph = assetPath(manifest.graph);
  const interactions = manifest.interactions === undefined ? null : assetPath(manifest.interactions);
  assert(path.posix.extname(model).toLowerCase() === (manifest.requires.runtime === 'soft-surface-v1' ? '.json' : '.glb') && path.posix.extname(actions).toLowerCase() === '.json' && path.posix.extname(graph).toLowerCase() === '.json' &&
    (!interactions || path.posix.extname(interactions).toLowerCase() === '.json'), 'invalid pack entry type');
  assert(Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length <= MAX_FILES && files instanceof Map, 'invalid pack assets');
  const seen = new Set(), declared = new Set();
  let total = 0;
  for (const entry of manifest.assets) {
    assert(entry && typeof entry === 'object', 'invalid pack asset');
    const name = assetPath(entry.path), folded = name.toLowerCase();
    assert(!seen.has(folded), 'duplicate pack asset'); seen.add(folded); declared.add(name);
    assert(typeof entry.sha256 === 'string' && DIGEST.test(entry.sha256), 'invalid asset hash');
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE_BYTES, 'invalid asset size');
    total += entry.size; assert(total <= MAX_TOTAL_BYTES, 'pack is too large');
    const data = files.get(name);
    assert(Buffer.isBuffer(data) && data.length === entry.size, 'missing or incorrect asset size');
    assert(crypto.createHash('sha256').update(data).digest('hex') === entry.sha256, 'asset hash mismatch');
  }
  assert(declared.has(model) && declared.has(actions) && declared.has(graph) && (!interactions || declared.has(interactions)), 'missing pack entry');
  assert(files.size === declared.size && [...files.keys()].every(name => declared.has(name)), 'undeclared pack asset');
  return { id: manifest.id, version: manifest.version, characterId: manifest.character.id,
    model, actions, graph, interactions, runtime: manifest.requires.runtime, defaultIdle: manifest.defaultIdle, bytes: total };
}

module.exports = { validatePackManifest, assetPath, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
