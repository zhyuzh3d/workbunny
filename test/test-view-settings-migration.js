'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const config = require('../src/main/config');

test('legacy size presets retain their size and VRM framing on migration and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-view-migration-'));
  try {
    for (const [old, size, framing] of [[.25,.25,'half'], [.5,.5,'half'], [1,.5,'full'], [1.5,1.5,'full'], [2,2,'full']]) {
      const file = path.join(dir, `${old}.json`);
      fs.writeFileSync(file, JSON.stringify({ window: { scale: old } }));
      config.setPath(file);
      assert.equal(config.load().window.scale, size);
      assert.equal(config.load().window.vrmFraming, framing);
      config.save({ window: { vrmFraming: framing === 'half' ? 'full' : 'half' } });
      config.setPath(file);
      assert.equal(config.load().window.scale, size);
      assert.equal(config.load().window.vrmFraming, framing === 'half' ? 'full' : 'half');
      assert.throws(() => config.save({ window: { vrmFraming: 'invalid' } }));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
