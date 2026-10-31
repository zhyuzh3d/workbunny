'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validatePackManifest, assetPath } = require('../src/main/avatar-pack-manifest');

function fixture() {
  const files = new Map([['assets/character.glb', Buffer.from('model')], ['performances/actions.json', Buffer.from('{}')], ['performances/graph.json', Buffer.from('{}')]]);
  const assets = [...files].map(([path, data]) => ({ path, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }));
  return { files, manifest: { format: 'workbunny.avatar-pack', formatVersion: 1, id: 'example', version: '1.0.0',
    character: { id: 'main', name: '角色', model: 'assets/character.glb' },
    requires: { runtime: 'declarative-3d-v1', features: ['timeline'] }, actions: 'performances/actions.json', graph: 'performances/graph.json', defaultIdle: 'idle', assets } };
}
const validate = x => validatePackManifest(x.manifest, x.files, { supportedFeatures: new Set(['timeline']) });

test('manifest only accepts the declared self-contained asset set', () => {
  const x = fixture(), result = validate(x);
  assert.equal(result.id, 'example');
  assert.equal(result.bytes, 9);
  x.files.set('other.json', Buffer.from('{}'));
  assert.throws(() => validate(x), /undeclared/);
});

test('rejects traversal, scripts, duplicate paths, tampering and unsupported runtime features', () => {
  for (const mutate of [
    x => { x.manifest.assets[0].path = '../outside.glb'; },
    x => { x.manifest.assets[0].path = 'assets/code.js'; },
    x => { x.manifest.assets.push({ ...x.manifest.assets[0], path: 'ASSETS/CHARACTER.GLB' }); },
    x => { x.manifest.assets[0].sha256 = '0'.repeat(64); },
    x => { x.manifest.assets[0].size = 2 ** 30; },
    x => { x.manifest.requires.features.push('untrusted'); },
    x => { x.manifest.requires.runtime = 'arbitrary-js'; },
    x => { x.manifest.actions = 'missing.json'; },
    x => { x.manifest.version = '1.0.0/../../'; },
  ]) { const x = fixture(); mutate(x); assert.throws(() => validate(x)); }
  for (const invalid of ['/a.glb', 'a/../b.glb', 'a\\b.glb', 'https://x/a.glb', 'a//b.glb', './a.glb']) {
    assert.throws(() => assetPath(invalid));
  }
});
