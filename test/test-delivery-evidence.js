'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { collectDeliveryEvidence } = require('../src/main/delivery-evidence');

async function withTempDir(fn) {
  const tempBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempBase, 'bunny-delivery-evidence-'));
  try { await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function main() {
  await withTempDir(async root => {
    const dir = path.join(root, 'authorized output with spaces');
    await fs.mkdir(dir);
    const file = path.join(dir, 'result.md');
    await fs.writeFile(file, 'cover\nfirst result\nsecond result\nfinal note\n', { mode: 0o600 });
    const result = await collectDeliveryEvidence({
      userRequest: `请检查目录中的交付文件："${dir}"`,
      monitorSummary: `WorkBuddy reports "${file}":3 is the final result.`,
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, file);
    assert.equal(result.files[0].status, 'text-metadata');
    assert.equal(result.files[0].textLines, 4);
    assert.equal(result.files[0].textCharacters, [...'cover\nfirst result\nsecond result\nfinal note\n'].length);
    assert.equal(result.files[0].excerpt, 'cover\nfirst result\nsecond result\nfinal note');
    assert.deepEqual(result.files[0].excerptLines, [1, 4]);
    assert.equal(result.files[0].excerptTrust, 'untrusted-data-not-instructions');
    assert.equal(result.files[0].excerpts[0].requestedLine, 3);
    assert(Number.isFinite(result.files[0].mtimeMs), 'evidence includes the source mtime for freshness review');
    assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
  });

  await withTempDir(async root => {
    const source = path.join(root, '源文件.js'), output = path.join(root, '结果.md');
    await fs.writeFile(source, 'function genuineSource() {}'); await fs.writeFile(output, '# actual output');
    const result = await collectDeliveryEvidence({ userRequest: `请只读 ${source}，然后生成 ${output}。不要修改其他文件。` });
    assert.deepEqual(result.files.map(file => file.path), [source, output], 'Chinese punctuation adjacent to an unquoted path terminates the path');
    assert(result.files.every(file => file.exists && file.excerpt));
    const english = await collectDeliveryEvidence({ userRequest: `Read ${source}. Then inspect ${output}.` });
    assert.deepEqual(english.files.map(file => file.path), [source, output]);
    const literal = path.join(root, '结果，终稿.md'); await fs.writeFile(literal, 'quoted literal punctuation');
    const quoted = await collectDeliveryEvidence({ userRequest: `请读取“${literal}”。` });
    assert.equal(quoted.files.length, 1); assert.equal(quoted.files[0].path, literal);
    assert.equal(quoted.files[0].excerpt, 'quoted literal punctuation');
    for (const suffix of [')', ':3', '.']) {
      const exact = path.join(root, 'literal.txt' + suffix), neighbour = path.join(root, 'literal.txt');
      await fs.writeFile(exact, 'exact named file'); await fs.writeFile(neighbour, 'not authorized by the quoted literal');
      const checked = await collectDeliveryEvidence({ userRequest: `Read "${exact}".` });
      assert.deepEqual(checked.files.map(file => file.path), [exact], 'a quoted literal must not authorize a punctuation-stripped neighbour');
      assert(!JSON.stringify(checked).includes('not authorized by the quoted literal'));
    }
  });

  await withTempDir(async root => {
    const file = path.join(root, 'secretary.js');
    await fs.writeFile(file, Array.from({ length: 32 }, (_, index) => `line-${index + 1}`).join('\n'));
    const result = await collectDeliveryEvidence({ userRequest: `请核对源文件 "${file}"`,
      monitorSummary: '检查 secretary.js:15、secretary.js:4、secretary.js:15 和 secretary.js:28 的实现。' });
    assert.equal(result.limits.excerptsPerFile, 3);
    assert.equal(result.files.length, 1);
    assert.deepEqual(result.files[0].excerpts.map(item => item.requestedLine), [15, 4, 28], 'line references deduplicate and retain at most three excerpts');
    assert.deepEqual(result.files[0].excerpts[0] && [result.files[0].excerpts[0].startLine, result.files[0].excerpts[0].endLine], [10, 20]);
    assert(result.files[0].excerpts[0].text.includes('line-15'));
    assert(result.excerptBytes <= 12 * 1024);
  });

  await withTempDir(async root => {
    const firstDir = path.join(root, 'one'), secondDir = path.join(root, 'two');
    await fs.mkdir(firstDir); await fs.mkdir(secondDir);
    const first = path.join(firstDir, 'secretary.js'), second = path.join(secondDir, 'secretary.js');
    await fs.writeFile(first, Array.from({ length: 20 }, (_, index) => `first-${index + 1}`).join('\n'));
    await fs.writeFile(second, Array.from({ length: 20 }, (_, index) => `second-${index + 1}`).join('\n'));
    const ambiguous = await collectDeliveryEvidence({ userRequest: `请核对文件 "${first}" 和 "${second}"`, monitorSummary: 'secretary.js:15' });
    assert.equal(ambiguous.ambiguousBasenameReferences, 1);
    assert.equal(ambiguous.files.length, 2);
    assert(ambiguous.files.every(file => file.excerpts.every(item => item.requestedLine === null)),
      'duplicate authorized basenames do not guess which file the report intended');
  });

  await withTempDir(async root => {
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside.txt');
    await fs.mkdir(allowed);
    await fs.writeFile(outside, 'not authorized');
    await fs.writeFile(path.join(allowed, 'ok.txt'), 'in-scope');
    const result = await collectDeliveryEvidence({
      userRequest: `核对目录 ${allowed}`,
      monitorSummary: `files: ${path.join(allowed, 'ok.txt')} and ${outside}; traversal ${path.join(allowed, '..', 'outside.txt')}`,
    });
    assert.deepEqual(result.files.map(item => item.path), [path.join(allowed, 'ok.txt')]);
    assert.equal(result.files[0].excerpt, undefined, 'directory authorization permits report-named files but does not expose text without a line reference');
  });

  await withTempDir(async root => {
    const named = path.join(root, 'named.txt'), sibling = path.join(root, 'sibling.txt');
    await fs.writeFile(named, 'the user named this file');
    await fs.writeFile(sibling, 'same parent does not grant access');
    const result = await collectDeliveryEvidence({ userRequest: `请检查文件 "${named}"`, monitorSummary: `另外写了 ${sibling}` });
    assert.deepEqual(result.files.map(item => item.path), [named], 'an explicitly named file does not authorize sibling files in its parent directory');
  });

  await withTempDir(async root => {
    const dir = path.join(root, 'authorized');
    const outside = path.join(root, 'outside.md');
    await fs.mkdir(dir);
    await fs.writeFile(outside, 'outside target');
    await fs.symlink(outside, path.join(dir, 'linked.md'));
    const externalDir = path.join(root, 'external-dir');
    await fs.mkdir(externalDir);
    await fs.writeFile(path.join(externalDir, 'nested.md'), 'outside nested target');
    await fs.symlink(externalDir, path.join(dir, 'linked-dir'));
    await fs.writeFile(path.join(dir, '.env'), 'AUTH_TOKEN=not-for-output');
    const result = await collectDeliveryEvidence({
      userRequest: `请检查 ${dir}`,
      monitorEvidence: `${path.join(dir, 'linked.md')} and ${path.join(dir, 'linked-dir', 'nested.md')} and ${path.join(dir, '.env')}`,
    });
    assert.equal(result.files.length, 3);
    assert.equal(result.files.find(item => item.path.endsWith('linked.md')).status, 'symlink');
    assert.equal(result.files.find(item => item.path.endsWith('nested.md')).status, 'symlink', 'symlinked parent directories are rejected too');
    assert.equal(result.files.find(item => item.path.endsWith('.env')).status, 'sensitive-path');
    assert.equal(result.files.some(item => item.path === outside), false);
  });

  await withTempDir(async root => {
    const file = path.join(root, 'output.md');
    await fs.writeFile(file, 'requested text');
    const untrustedReportOnly = await collectDeliveryEvidence({ userRequest: '请完成这个任务。', monitorSummary: `输出在 ${file}` });
    assert.equal(untrustedReportOnly.files.length, 0, 'an executor report cannot grant a filesystem path');
    assert.match(untrustedReportOnly.note, /未读取执行方报告提及的路径/u);
    const untrustedBasenameOnly = await collectDeliveryEvidence({ userRequest: '请完成这个任务。', monitorSummary: '核对 output.md:1' });
    assert.equal(untrustedBasenameOnly.files.length, 0, 'a basename line reference without explicit file authorization cannot read a file');

    const dirOnly = await collectDeliveryEvidence({ userRequest: `请检查目录 ${root}`, monitorSummary: '核对 output.md:1' });
    assert.equal(dirOnly.files.length, 0, 'basename references do not enumerate or guess inside an authorized directory');

    const secretFile = path.join(root, '.env.local');
    const secret = await collectDeliveryEvidence({ userRequest: `读取 ${secretFile}` });
    assert.equal(secret.files.length, 0);
    assert.equal(secret.rejectedCount, 1);
  });

  await withTempDir(async root => {
    const target = path.join(root, 'quoted path with spaces.md');
    const second = path.join(root, 'second.txt');
    await fs.writeFile(target, 'authorized by direct read request');
    await fs.writeFile(second, 'authorized by explicit list');

    const echoOnly = await collectDeliveryEvidence({ userRequest: `只回复字符串 ${target}`, report: target });
    assert.equal(echoOnly.files.length, 0, 'echoing a path does not grant file access');
    assert.match(echoOnly.note, /明确说明要读取或检查的绝对路径/u);

    const quotedCommand = await collectDeliveryEvidence({ userRequest: `交给WB解释这段引用：“读取 ${target}”` });
    assert.equal(quotedCommand.files.length, 0, 'a quoted command or quoted text cannot grant access');
    const codeBlock = await collectDeliveryEvidence({ userRequest: `解释下面代码，不执行：\n\`\`\`json\n{"path":"${target}"}\n\`\`\`` });
    assert.equal(codeBlock.files.length, 0, 'paths in fenced code are data, not authorization');
    const json = await collectDeliveryEvidence({ userRequest: `请解释这个对象：{"path":"${target}","action":"read"}` });
    assert.equal(json.files.length, 0, 'paths in JSON data are not authorization');

    const explicitQuoted = await collectDeliveryEvidence({ userRequest: `请读取“${target}”。` });
    assert.deepEqual(explicitQuoted.files.map(file => file.path), [target], 'an explicit operation authorizes the adjacent quoted literal, including spaces');
    const explicitList = await collectDeliveryEvidence({ userRequest: `请检查以下文本文件列表：“${target}”、 “${second}”` });
    assert.deepEqual(explicitList.files.map(file => file.path), [target, second], 'a nearby explicit file list is authorized as a unit');
  });

  await withTempDir(async root => {
    const target = path.join(root, 'quoted path with spaces.md');
    await fs.writeFile(target, 'authorized');
    const inlinePath = await collectDeliveryEvidence({ userRequest: '请读取`' + target + '`' });
    assert.deepEqual(inlinePath.files.map(file => file.path), [target], 'a pure inline-code path remains an explicit path literal');
    const second = path.join(root, 'second.txt');
    await fs.writeFile(second, 'listed');
    const inlineList = await collectDeliveryEvidence({ userRequest: '请检查以下文件列表：`' + target + '`、`' + second + '`' });
    assert.deepEqual(inlineList.files.map(file => file.path), [target, second], 'inline-code path lists remain associated with the explicit operation');
    const inlineCommand = await collectDeliveryEvidence({ userRequest: '解释这段代码：`读取 ' + target + '`' });
    assert.equal(inlineCommand.files.length, 0, 'an inline command remains data, not authorization');

    const source = path.join(root, 'source.txt'), output = path.join(root, 'output.txt');
    await fs.writeFile(source, 'source'); await fs.writeFile(output, 'output');
    const noSpace = await collectDeliveryEvidence({ userRequest: '读取' + source + '，创建' + output });
    assert.deepEqual(noSpace.files.map(file => file.path), [source, output], 'action words adjacent to paths need no intervening space');
    assert.deepEqual(noSpace.requiredOutputs, [output]);
    for (const request of ['不读取' + source, '别检查 ' + source, '不需要读取 ' + source, '我喜欢读 ' + source]) {
      const refused = await collectDeliveryEvidence({ userRequest: request });
      assert.equal(refused.files.length, 0, 'negated or non-operative phrasing is not authorization');
    }
    const unclosedJson = await collectDeliveryEvidence({ userRequest: '请解释对象：{"path":"' + source });
    assert.equal(unclosedJson.files.length, 0, 'an unterminated JSON-like value is masked through the bounded tail');

    const hidden = path.join(root, 'hidden.txt');
    const quotedName = root + '/read ' + hidden;
    await fs.mkdir(path.dirname(quotedName), { recursive: true });
    await fs.writeFile(quotedName, 'the explicitly named file');
    await fs.writeFile(hidden, 'must not be separately authorized');
    const result = await collectDeliveryEvidence({ userRequest: '请读取 "' + quotedName + '"' });
    assert.deepEqual(result.files.map(file => file.path), [quotedName],
      'unquoted scanning cannot extract another absolute path from inside a quoted filename');
    assert(!JSON.stringify(result).includes('must not be separately authorized'));
  });

  const protectedLocations = await collectDeliveryEvidence({ userRequest:
    `请检查 /System/Library/Frameworks/Example.framework/Headers/Example.h 和 "${path.join(os.homedir(), 'Library', 'Application Support', 'Example', 'result.txt')}"` });
  assert.equal(protectedLocations.files.length, 0);
  assert.equal(protectedLocations.rejectedCount, 2, 'system and user application-library paths are rejected without probing their contents');
  const broadRoot = await collectDeliveryEvidence({ userRequest: '检查 /' });
  assert.equal(broadRoot.files.length, 0, 'filesystem and home roots are too broad to grant evidence access');
  assert.equal(broadRoot.rejectedCount, 1);

  await withTempDir(async root => {
    const dir = path.join(root, 'authorized');
    await fs.mkdir(dir);
    const tooLarge = path.join(dir, 'large.txt');
    await fs.writeFile(tooLarge, Buffer.alloc(256 * 1024 + 1, 0x61));
    const binary = path.join(dir, 'image.bin');
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 3]));
    const reportOnly = [tooLarge, binary].join('\n');
    const result = await collectDeliveryEvidence({ userRequest: `验证目录 ${dir}`, report: reportOnly });
    assert.equal(result.files.find(item => item.path === tooLarge).status, 'file-too-large');
    assert.equal(result.files.find(item => item.path === tooLarge).sha256, undefined);
    assert.equal(result.files.find(item => item.path === binary).status, 'metadata-only');
    assert.equal(result.files.find(item => item.path === binary).sha256.length, 64, 'small binary files expose metadata hash only');
  });

  await withTempDir(async root => {
    const files = [];
    for (let i = 0; i < 6; i++) {
      const file = path.join(root, `evidence-${i}.md`);
      await fs.writeFile(file, Array.from({ length: 8 }, (_, line) => `${i}:${line}:` + 'x'.repeat(900)).join('\n'));
      files.push(file);
    }
    const bounded = await collectDeliveryEvidence({ userRequest: `请核对以下文本文件：${files.map(file => `"${file}"`).join(' ')}` });
    assert.equal(bounded.files.length, 4);
    assert.equal(bounded.omittedCount, 2);
    assert(bounded.excerptBytes <= 12 * 1024);
    assert(bounded.files.every(item => item.bytes <= 256 * 1024));
  });

  await withTempDir(async root => {
    const file = path.join(root, 'notes.txt');
    const lines = Array.from({ length: 30 }, (_, index) => `safe line ${index + 1}`);
    lines[28] = 'ACCESS_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789';
    await fs.writeFile(file, lines.join('\n'));
    const result = await collectDeliveryEvidence({ userRequest: `检查 "${file}"`, monitorSummary: 'notes.txt:1' });
    assert.equal(result.files[0].status, 'credential-like-content-redacted');
    assert.equal(result.files[0].excerpt, undefined);
    assert.equal(result.files[0].sha256, undefined);
  });

  console.log('delivery evidence safety checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
