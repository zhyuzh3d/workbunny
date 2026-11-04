'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-install-retention-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const dest = path.join(root, 'applications');
  const bin = path.join(root, 'bin');
  const volume = path.join(root, 'external');
  for (const dir of [path.join(project, 'tools'), path.join(project, 'dist', 'workbunny.app'), dest, bin, volume]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../tools/install-app.sh'), path.join(project, 'tools/install-app.sh'));
  const app = (dir, marker) => {
    fs.mkdirSync(path.join(dir, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Contents/MacOS/workbunny'), marker);
  };
  app(path.join(project, 'dist/workbunny.app'), 'new');
  app(path.join(dest, 'workbunny.app'), 'old');
  app(path.join(dest, '.workbunny-backup-20261101-010101.app'), 'older');
  const cmd = (name, body) => { const f = path.join(bin, name); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); };
  cmd('codesign', 'case "$*" in */WorkBunny备份/安装版本/*) [ "${FAIL_ARCHIVE_VERIFY:-0}" = 1 ] && exit 1 ;; esac\nexit 0');
  cmd('node', 'exit 0');
  cmd('lsof', 'exit 1');
  cmd('ditto', '/bin/cp -R "$1" "$2"');
  cmd('diskutil', 'printf "%s" "$WORKBUNNY_ARCHIVE_VOLUME"');
  cmd('plutil', 'if [ "$2" = Internal ]; then printf false; else printf "%s" "$WORKBUNNY_ARCHIVE_VOLUME"; fi');
  cmd('mv', 'case "$1" in */.workbunny-install-*/workbunny.app) [ "${FAIL_INSTALL:-0}" = 1 ] && exit 1 ;; esac\nexec /bin/mv "$@"');
  const run = (extra = {}) => spawnSync('/bin/zsh', [path.join(project, 'tools/install-app.sh')], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, WORKBUNNY_INSTALL_DIR: dest,
      WORKBUNNY_SKIP_OPEN: '1', WORKBUNNY_ARCHIVE_VOLUME: volume, ...extra }, encoding: 'utf8'
  });
  const read = p => fs.readFileSync(path.join(p, 'Contents/MacOS/workbunny'), 'utf8');
  return { root, dest, volume, run, read };
}

test('successful install removes old application copies and keeps user data', t => {
  const f = fixture(t);
  const data = path.join(f.root, 'user-data');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'personal'), 'keep');
  const result = f.run({ WORKBUNNY_DATA_DIR: data });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'new');
  assert.deepEqual(fs.readdirSync(f.dest), ['workbunny.app']);
  assert.equal(fs.readFileSync(path.join(data, 'personal'), 'utf8'), 'keep');
});

test('failed replacement restores old application and retains historical backups', t => {
  const f = fixture(t), result = f.run({ FAIL_INSTALL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'old');
  assert.equal(f.read(path.join(f.dest, '.workbunny-backup-20261101-010101.app')), 'older');
});

test('requested archive requires the external backup directory before replacement', t => {
  const f = fixture(t), result = f.run({ WORKBUNNY_ARCHIVE_PREVIOUS: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'old');
});

test('requested archive saves the old app externally before replacing it', t => {
  const f = fixture(t), archive = path.join(f.volume, 'WorkBunny备份');
  fs.mkdirSync(archive);
  const result = f.run({ WORKBUNNY_ARCHIVE_PREVIOUS: '1' });
  assert.equal(result.status, 0, result.stderr);
  const versions = path.join(archive, '安装版本');
  const saved = path.join(versions, fs.readdirSync(versions)[0], 'workbunny.app');
  assert.equal(f.read(saved), 'old');
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'new');
  assert.deepEqual(fs.readdirSync(f.dest), ['workbunny.app']);
});

test('failed archive verification leaves the installed version and old backups intact', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.volume, 'WorkBunny备份'));
  const result = f.run({ WORKBUNNY_ARCHIVE_PREVIOUS: '1', FAIL_ARCHIVE_VERIFY: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'old');
  assert.equal(f.read(path.join(f.dest, '.workbunny-backup-20261101-010101.app')), 'older');
});

test('another installation lock prevents any replacement or cleanup', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dest, '.workbunny-install.lock'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.read(path.join(f.dest, 'workbunny.app')), 'old');
  assert.equal(f.read(path.join(f.dest, '.workbunny-backup-20261101-010101.app')), 'older');
});
