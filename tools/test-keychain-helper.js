'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const built = path.join(root, 'bin/workbunny-keychain.app');

function main() {
  execFileSync(path.join(__dirname, 'build-keychain.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-keychain-protocol-'));
  try {
    const outerApp = path.join(temp, 'Bunny Renamed.app');
    const helperBundle = path.join(outerApp, 'Contents/Resources/bin/workbunny-keychain.app');
    fs.mkdirSync(path.join(outerApp, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(outerApp, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.haminn.workbunny</string></dict></plist>');
    fs.copyFileSync('/dev/null', path.join(outerApp, 'Contents/MacOS/workbunny'));
    fs.cpSync(built, helperBundle, { recursive: true });
    const executable = path.join(helperBundle, 'Contents/MacOS/workbunny-keychain');
    const fakeImport = { op: 'import', key: Buffer.alloc(32, 0x7b).toString('base64') };
    fakeImport.account = 'vault-123e4567-e89b-12d3-a456-426614174000';
    const input = `${JSON.stringify({ op: 'read', account: fakeImport.account })}\n${JSON.stringify(fakeImport)}\n`;
    const result = spawnSync(executable, [], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'native helper must not log protocol or authorization details');
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.deepEqual(responses, [
      { ok: false, error: 'unauthorized' },
      { ok: false, error: 'unauthorized' },
    ], 'direct launch by this test process must be rejected before any Keychain access');
    assert(!result.stdout.includes(fakeImport.key), 'unauthorized import must not echo the supplied key');

    const withArgs = spawnSync(executable, ['--untrusted'], { input: `${JSON.stringify({ op: 'read' })}\n`, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    assert.equal(withArgs.status, 64, 'helper must reject unexpected command-line arguments');
    assert.equal(withArgs.stdout, '');

    const testExecutable = path.join(helperBundle, 'Contents/MacOS/workbunny-keychain');
    execFileSync('xcrun', ['swiftc', '-O', '-D', 'WORKBUNNY_KEYCHAIN_PARENT_GATE_TESTING', '-target', 'arm64-apple-macos13.0', path.join(root, 'native/keychain.swift'), '-o', testExecutable, '-framework', 'Security'], { cwd: root, stdio: 'inherit' });
    fs.writeFileSync(path.join(temp, 'fake-parent.c'), `#include <spawn.h>\n#include <unistd.h>\n#include <sys/wait.h>\n#include <stdlib.h>\n#include <string.h>\nextern char **environ;\nint main(int argc,char **argv){if(argc!=2)return 2;int in[2],out[2];if(pipe(in)||pipe(out))return 3;posix_spawn_file_actions_t a;posix_spawn_file_actions_init(&a);posix_spawn_file_actions_adddup2(&a,in[0],0);posix_spawn_file_actions_adddup2(&a,out[1],1);posix_spawn_file_actions_addclose(&a,in[1]);posix_spawn_file_actions_addclose(&a,out[0]);char *args[]={argv[1],NULL};pid_t p=0;int rc=posix_spawn(&p,argv[1],&a,NULL,args,environ);posix_spawn_file_actions_destroy(&a);close(in[0]);close(out[1]);if(rc)return 4;const char *q="{\\\"op\\\":\\\"read\\\",\\\"account\\\":\\\"vault-123e4567-e89b-12d3-a456-426614174000\\\"}\\n";write(in[1],q,strlen(q));close(in[1]);char b[512];ssize_t n;while((n=read(out[0],b,sizeof(b)))>0)write(1,b,(size_t)n);close(out[0]);int status=0;waitpid(p,&status,0);return WIFEXITED(status)?WEXITSTATUS(status):5;}\n`);
    execFileSync('xcrun', ['clang', '-O', path.join(temp, 'fake-parent.c'), '-o', path.join(outerApp, 'Contents/MacOS/workbunny')], { stdio: 'inherit' });
    const fakeMain = spawnSync(path.join(outerApp, 'Contents/MacOS/workbunny'), [testExecutable], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    assert.equal(fakeMain.error, undefined, fakeMain.error?.message);
    assert.equal(fakeMain.status, 0, fakeMain.stderr);
    assert.deepEqual(fakeMain.stdout.trim().split('\n').map(line => JSON.parse(line)), [{ ok: false, error: 'unauthorized' }],
      'a fake same-path parent with no matching code signature must be denied');
    console.log('Keychain helper protocol/unauthorized checks passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
