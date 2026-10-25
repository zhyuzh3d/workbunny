'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const MAX_FILES = 4;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_EXCERPT_BYTES = 12 * 1024;
const MAX_USER_REQUEST_CHARS = 12_000;
const MAX_REPORT_CHARS = 24_000;
const MAX_PATH_REFERENCES = 48;
const MAX_EXCERPTS_PER_FILE = 3;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.log', '.json', '.jsonl', '.xml', '.html', '.htm', '.css',
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.swift', '.sh', '.bash', '.yml', '.yaml', '.toml', '.ini',
  '.conf', '.sql', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.php', '.vue', '.svelte', '.properties',
]);
const SENSITIVE_SEGMENT = /^(?:\.env(?:\..*)?|\.ssh|keychains?|keys?|credentials?|secrets?|tokens?|passwords?)$/i;
const SENSITIVE_BASENAME = /(?:^|[._-])(?:id_rsa|id_ed25519|private[-_]?key|credentials?|secrets?|access[-_]?token|refresh[-_]?token|passwords?)(?:[._-]|$)/i;
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.p7b', '.p7c', '.der', '.kdbx', '.mobileprovision']);
const CREDENTIAL_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
];

function collectPathReferences(value) {
  if (typeof value !== 'string') return [];
  const refs = new Map();
  const add = (raw, line, quoted = false, offset = 0) => {
    if (!raw || raw.length > 4096 || !raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw)) return;
    let candidate = quoted ? raw : raw.replace(/[),;!?\]}]+$/u, '');
    if (!quoted && candidate.endsWith('.') && TEXT_EXTENSIONS.has(path.extname(candidate.slice(0, -1)).toLowerCase())) candidate = candidate.slice(0, -1);
    let lineNumber = Number.isSafeInteger(Number(line)) && Number(line) > 0 ? Number(line) : null;
    if (!lineNumber && !quoted) {
      const suffix = candidate.match(/^(.*?)(?:#L|:L?)(\d+)(?::\d+)?$/i);
      if (suffix && suffix[1].startsWith('/')) { candidate = suffix[1]; lineNumber = Number(suffix[2]); }
    }
    if (!path.isAbsolute(candidate) || candidate.split(path.sep).includes('..')) return;
    const normalized = path.resolve(candidate);
    const previous = refs.get(normalized);
    const lines = [...new Set([...(previous?.lines || []), ...(lineNumber ? [lineNumber] : [])])];
    const pathOffset = offset + (quoted ? 1 : 0) + Math.max(0, raw.indexOf('/'));
    const prefix = value.slice(Math.max(0, offset - 100), offset);
    const outputVerb = /(?:新建|创建|写入|保存(?:到|为)?|输出到|生成(?:到|为)?|\bcreate|\bwrite(?:\s+to)?|\bsave(?:\s+to)?|\boutput\s+to)\s*[:：]?\s*$/iu.exec(prefix);
    const negated = outputVerb && /(?:不要|不得|不许|禁止|无需|不必|勿|不|do\s+not|don't)\s*$/iu.test(prefix.slice(0, outputVerb.index));
    refs.set(normalized, { path: normalized, lines, directoryHint: candidate.endsWith(path.sep),
      requiredOutput: !!previous?.requiredOutput || (!!outputVerb && !negated && !candidate.endsWith(path.sep)),
      occurrences: [...(previous?.occurrences || []), { start: pathOffset, end: pathOffset + candidate.length, quoted }] });
  };

  const bounded = value.slice(0, MAX_REPORT_CHARS);
  const quotedRanges = [];
  for (const match of bounded.matchAll(/(["'`])(\/[^\r\n]*?)\1(?::(?:L)?(\d+)(?::\d+)?)?/gu)) {
    quotedRanges.push([match.index, match.index + match[0].length]);
    add(match[2], match[3], true, match.index);
  }
  for (const match of bounded.matchAll(/[“「『‘](\/[^\r\n]*?)[”」』’](?::(?:L)?(\d+)(?::\d+)?)?/gu)) {
    quotedRanges.push([match.index, match.index + match[0].length]);
    add(match[1], match[2], true, match.index);
  }
  for (const match of bounded.matchAll(/(?<![\w:/"'`“「『‘])\/[^\x00-\x20"'`<>|，。；！？：”」』’]*/gu)) {
    if (quotedRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    add(match[0], undefined, false, match.index);
  }
  return [...refs.values()].slice(0, MAX_PATH_REFERENCES);
}

function maskRange(text, start, end) {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/gu, ' ') + text.slice(end);
}

// Preserve offsets and only leave a quoted literal visible when the entire quoted
// value is an absolute path. Other quoted material is treated as untrusted data.
function maskAuthorizationData(value) {
  let text = value;
  const masks = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)/gu)) masks.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/`[^`\r\n]*`/gu)) {
    const body = match[0].slice(1, -1);
    if (!body.startsWith('/') || /`/u.test(body)) masks.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/>[^\r\n]*/gu)) {
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    if (/^\s*>/u.test(text.slice(lineStart, match.index + 1))) masks.push([lineStart, match.index + match[0].length]);
  }
  // Mask JSON-like objects as a unit, including the quoted path values they contain.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, quote = null, escaped = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = j + 1; break; }
    }
    if (end > i) {
      const block = text.slice(i, end);
      if (/"[^"\r\n]+"\s*:/u.test(block)) masks.push([i, end]);
      i = end - 1;
    } else {
      if (/"[^"\r\n]+"\s*:/u.test(text.slice(i))) masks.push([i, text.length]);
      break; // An unterminated object makes the remainder ambiguous; stop the bounded scan.
    }
  }
  for (const match of text.matchAll(/(["'“「『‘])([^\r\n]*?)(["'”」』’])/gu)) {
    const body = match[2];
    if (body.startsWith('/') && !/["'“「『‘”」』’]/u.test(body)) continue;
    masks.push([match.index, match.index + match[0].length]);
  }
  masks.sort((a, b) => a[0] - b[0]);
  let merged = [];
  for (const range of masks) {
    const prev = merged.at(-1);
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([...range]);
  }
  for (const [start, end] of merged.reverse()) text = maskRange(text, start, end);
  return text;
}

function collectAuthorizedPathReferences(value) {
  if (typeof value !== 'string') return [];
  const sanitized = maskAuthorizationData(value.slice(0, MAX_USER_REQUEST_CHARS));
  const lexical = collectPathReferences(sanitized);
  const actionPattern = /只读|读取|核对|检查|审查|查看|验证|确认|审阅|分析|打开|列出|比对|创建|新建|写入|保存|生成|输出|编辑|修改|删除|移除|复制|移动|\bread\b|\binspect\b|\bcheck\b|\breview\b|\bverify\b|\bopen\b|\blist\b|\bcreate\b|\bwrite\b|\bsave\b|\bgenerate\b|\boutput\b|\bedit\b|\bmodify\b|\bdelete\b|\bremove\b|\bcopy\b|\bmove\b/giu;
  const negation = /(?:不要|不得|不许|禁止|无需|不必|勿|不能|不需要|别|不|\bdo\s+not\b|\bdon't\b|\bnever\b|\bnot\b)\s*$/iu;
  const bridgeWord = /^(?:\s|[：:,，、;；和以及及与/“”「」『』‘’"'`]|目录|文本|文件|路径|文档|代码|内容|结果|以下|这些|指定|这个|该|源|输出|交付|列表|中的|里的|中|里|的|到|为|with|the|following|these|this|source|output|delivery|file|files|directory|folder|path|document|code)*$/iu;
  const out = new Map();
  let priorAuthorizedEnd = -1;
  let priorRequiredOutput = false;
  const orderedOccurrences = lexical.flatMap(ref => (ref.occurrences || []).map(occurrence => ({ ref, occurrence })))
    .sort((a, b) => a.occurrence.start - b.occurrence.start);
  for (const { ref, occurrence } of orderedOccurrences) {
      const prefix = sanitized.slice(Math.max(0, occurrence.start - 160), occurrence.start);
      actionPattern.lastIndex = 0;
      const actions = [...prefix.matchAll(actionPattern)];
      let action = null;
      for (const candidate of actions.reverse()) {
        const before = prefix.slice(0, candidate.index);
        const after = prefix.slice(candidate.index + candidate[0].length);
        if (negation.test(before.slice(-32))) continue;
        if (bridgeWord.test(after)) { action = candidate; break; }
      }
      let output = false;
      if (action) output = /^(?:创建|新建|写入|保存|生成|输出|\bcreate\b|\bwrite\b|\bsave\b|\bgenerate\b|\boutput\b)/iu.test(action[0]);
      else if (priorAuthorizedEnd >= 0 && occurrence.start >= priorAuthorizedEnd && occurrence.start - priorAuthorizedEnd <= 48) {
        const connector = sanitized.slice(priorAuthorizedEnd, occurrence.start);
        if (/^(?:\s|[,，、;；和以及及与]|\band\b|\bplus\b|[“”「」『』‘’"'`])*$/iu.test(connector)) output = priorRequiredOutput;
        else if (/^(?:\s|[,，、;；]|(?:以及|然后|并且|再|and\s+then)\s*)(?:创建|新建|写入|保存|生成|输出|\bcreate\b|\bwrite\b|\bsave\b|\bgenerate\b|\boutput\b)(?:\s|[：:,，、;；和以及及与]|文件|文档|输出|结果|到|为)*$/iu.test(connector)) {
          output = /(?:创建|新建|写入|保存|生成|输出|\bcreate\b|\bwrite\b|\bsave\b|\bgenerate\b|\boutput\b)/iu.test(connector);
        } else continue;
      } else continue;
      const previous = out.get(ref.path);
      out.set(ref.path, { path: ref.path, lines: [...new Set([...(previous?.lines || []), ...ref.lines])],
        directoryHint: ref.directoryHint, requiredOutput: !!previous?.requiredOutput || (output && !ref.directoryHint) });
      priorAuthorizedEnd = occurrence.end;
      priorRequiredOutput = output;
  }
  return [...out.values()].slice(0, MAX_PATH_REFERENCES);
}

function collectBasenameLineReferences(value) {
  if (typeof value !== 'string') return [];
  const refs = new Map();
  const bounded = value.slice(0, MAX_REPORT_CHARS);
  const pattern = /(?<![\/\\\p{L}\p{N}_.-])([\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[\p{L}\p{N}]{1,12}):L?(\d+)(?::\d+)?(?![\p{L}\p{N}_])/gu;
  for (const match of bounded.matchAll(pattern)) {
    const basename = match[1];
    if (!TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase())) continue;
    const line = Number(match[2]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    if (!refs.has(basename)) refs.set(basename, new Set());
    refs.get(basename).add(line);
  }
  return [...refs].flatMap(([basename, lines]) => [...lines].map(line => ({ basename, line }))).slice(0, MAX_PATH_REFERENCES);
}

function protectedPath(value) {
  const absolute = path.resolve(value);
  if (absolute === path.parse(absolute).root || absolute === '/Users' || absolute === os.homedir()) return 'broad-root';
  const parts = absolute.split(path.sep).filter(Boolean);
  if (parts.some(part => SENSITIVE_SEGMENT.test(part)) || SENSITIVE_BASENAME.test(path.basename(absolute)) ||
      SENSITIVE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return 'sensitive-path';
  if (absolute === '/System' || absolute.startsWith('/System/') || absolute === '/usr/lib' || absolute.startsWith('/usr/lib/') ||
      absolute === '/Library' || absolute.startsWith('/Library/')) return 'system-library';
  const homeLibrary = path.join(os.homedir(), 'Library');
  if (absolute === homeLibrary || absolute.startsWith(homeLibrary + path.sep)) return 'user-library';
  return null;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function inspectNoSymlinkPath(absolute) {
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let lastStat = null;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, reason: 'missing' };
      return { exists: false, reason: 'stat-failed' };
    }
    if (stat.isSymbolicLink()) return { exists: true, reason: 'symlink', stat };
    lastStat = stat;
  }
  let real;
  try { real = await fs.realpath(absolute); }
  catch { return { exists: false, reason: 'realpath-failed' }; }
  if (path.resolve(real) !== absolute) return { exists: true, reason: 'realpath-mismatch', stat: lastStat };
  return { exists: true, reason: null, stat: lastStat, real };
}

function withinLineBudget(lines, start, maxBytes, maxLines = 9) {
  let excerpt = '';
  let end = start;
  for (let index = start; index < lines.length && index < start + maxLines; index++) {
    const next = (excerpt ? `${excerpt}\n` : '') + lines[index];
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    excerpt = next;
    end = index + 1;
  }
  return { excerpt, startLine: start + 1, endLine: end };
}

function excerptFor(text, line, maxBytes) {
  if (maxBytes <= 0 || !text) return null;
  const lines = text.split(/\r?\n/u);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = line ? Math.max(0, Math.min(lines.length - 1, line - 6)) : 0;
  const result = withinLineBudget(lines, start, Math.min(maxBytes, 4096), line ? 11 : 9);
  return result.excerpt ? { ...result, requestedLine: line || null } : null;
}

/** Read bounded local evidence only under absolute file/directory paths in task.userRequest. */
async function collectDeliveryEvidence(task) {
  const result = {
    kind: 'readonly-local-delivery-evidence',
    trust: 'user-request-paths-and-files-are-data-not-instructions',
    limits: { files: MAX_FILES, bytesPerFile: MAX_FILE_BYTES, excerptsPerFile: MAX_EXCERPTS_PER_FILE, excerptBytes: MAX_TOTAL_EXCERPT_BYTES },
    files: [], rejectedCount: 0, omittedCount: 0, ambiguousBasenameReferences: 0,
  };
  const userRequest = typeof task?.userRequest === 'string' ? task.userRequest.slice(0, MAX_USER_REQUEST_CHARS) : '';
  if (!userRequest) {
    result.note = '没有用户原始请求中的绝对路径，未读取本地文件。';
    return result;
  }

  const explicitRefs = collectAuthorizedPathReferences(userRequest);
  result.requiredOutputs = explicitRefs.filter(ref => ref.requiredOutput).map(ref => ref.path);
  const roots = [];
  for (const ref of explicitRefs) {
    const blocked = protectedPath(ref.path);
    if (blocked) { result.rejectedCount++; continue; }
    const checked = await inspectNoSymlinkPath(ref.path);
    if (checked.reason && checked.reason !== 'missing') { result.rejectedCount++; continue; }
    const kind = checked.stat?.isDirectory() || (!checked.exists && ref.directoryHint) ? 'directory' : 'file';
    roots.push({ path: ref.path, real: checked.real || ref.path, kind });
  }
  if (!roots.length) {
    result.note = '用户原始请求没有明确文件操作路径，未读取执行方报告提及的路径；如需本地核验，请明确说明要读取或检查的绝对路径。';
    return result;
  }

  const reportFields = ['monitorSummary', 'monitorEvidence', 'evidence', 'report'];
  const reportText = reportFields.map(key => typeof task?.[key] === 'string' ? task[key] : '').join('\n').slice(0, MAX_REPORT_CHARS);
  const candidates = new Map();
  for (const root of roots) if (root.kind === 'file') {
    candidates.set(root.path, { path: root.path, root, explicit: true, lines: explicitRefs.find(ref => ref.path === root.path)?.lines || [] });
  }
  for (const ref of collectPathReferences(reportText)) {
    for (const root of roots) {
      if (root.kind === 'directory' && isWithin(root.real, ref.path)) {
        const previous = candidates.get(ref.path);
        candidates.set(ref.path, { ...ref, root, explicit: false,
          lines: [...new Set([...(previous?.lines || []), ...(ref.lines || [])])] });
        break;
      }
      if (root.kind === 'file' && root.real === ref.path) {
        const previous = candidates.get(ref.path);
        candidates.set(ref.path, { ...ref, root, explicit: true,
          lines: [...new Set([...(previous?.lines || []), ...(ref.lines || [])])] });
        break;
      }
    }
  }
  const explicitFilesByBasename = new Map();
  for (const root of roots.filter(item => item.kind === 'file')) {
    const basename = path.basename(root.path).toLowerCase();
    if (!explicitFilesByBasename.has(basename)) explicitFilesByBasename.set(basename, []);
    explicitFilesByBasename.get(basename).push(root);
  }
  for (const ref of collectBasenameLineReferences(reportText)) {
    const matches = explicitFilesByBasename.get(ref.basename.toLowerCase()) || [];
    if (matches.length !== 1) {
      if (matches.length > 1) result.ambiguousBasenameReferences++;
      continue;
    }
    const root = matches[0], previous = candidates.get(root.path);
    candidates.set(root.path, { path: root.path, root, explicit: true,
      lines: [...new Set([...(previous?.lines || []), ref.line])] });
  }
  const selected = [...candidates.values()].slice(0, MAX_FILES);
  result.omittedCount = Math.max(0, candidates.size - selected.length);
  let remainingExcerptBytes = MAX_TOTAL_EXCERPT_BYTES;
  for (const candidate of selected) {
    const record = { path: candidate.path, authorizedBy: candidate.explicit ? 'user-explicit-file' : 'user-explicit-directory', exists: false };
    const blocked = protectedPath(candidate.path);
    if (blocked) { result.rejectedCount++; record.status = blocked; result.files.push(record); continue; }
    if (!(candidate.explicit && candidate.root.kind === 'file') && !isWithin(candidate.root.real, candidate.path)) {
      result.rejectedCount++; record.status = 'outside-authorized-directory'; result.files.push(record); continue;
    }
    const checked = await inspectNoSymlinkPath(candidate.path);
    if (!checked.exists) { record.status = checked.reason || 'missing'; result.files.push(record); continue; }
    if (checked.reason) { result.rejectedCount++; record.exists = true; record.status = checked.reason; result.files.push(record); continue; }
    record.exists = true;
    record.mtimeMs = checked.stat.mtimeMs;
    if (checked.stat.isDirectory()) { record.status = 'directory-metadata-only'; record.kind = 'directory'; result.files.push(record); continue; }
    if (!checked.stat.isFile()) { result.rejectedCount++; record.status = 'not-regular-file'; result.files.push(record); continue; }
    record.kind = TEXT_EXTENSIONS.has(path.extname(candidate.path).toLowerCase()) ? 'text-candidate' : 'binary-or-unsupported';
    record.bytes = checked.stat.size;
    if (checked.stat.size > MAX_FILE_BYTES) { record.status = 'file-too-large'; result.files.push(record); continue; }
    let bytes;
    let handle;
    try {
      handle = await fs.open(candidate.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const openedStat = await handle.stat();
      const rechecked = await inspectNoSymlinkPath(candidate.path);
      if (!openedStat.isFile() || openedStat.dev !== checked.stat.dev || openedStat.ino !== checked.stat.ino ||
          !rechecked.exists || rechecked.reason || rechecked.stat?.dev !== checked.stat.dev || rechecked.stat?.ino !== checked.stat.ino) {
        await handle.close(); handle = null;
        record.status = 'path-changed'; result.files.push(record); continue;
      }
      record.bytes = openedStat.size;
      record.mtimeMs = openedStat.mtimeMs;
      const boundedRead = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(boundedRead, 0, boundedRead.length, 0);
      if (bytesRead > MAX_FILE_BYTES) {
        await handle.close(); handle = null;
        record.status = 'file-too-large'; result.files.push(record); continue;
      }
      bytes = boundedRead.subarray(0, bytesRead);
    } catch { record.status = 'read-failed'; result.files.push(record); continue; }
    finally { if (handle) await handle.close().catch(() => {}); }
    record.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (record.kind !== 'text-candidate' || bytes.includes(0)) { record.status = 'metadata-only'; result.files.push(record); continue; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { record.status = 'metadata-only-invalid-utf8'; result.files.push(record); continue; }
    if (CREDENTIAL_CONTENT.some(pattern => pattern.test(text))) {
      delete record.sha256;
      record.status = 'credential-like-content-redacted';
      result.files.push(record);
      continue;
    }
    record.textCharacters = [...text].length;
    const textLines = text.split(/\r\n|[\n\r]/u);
    if (textLines.at(-1) === '') textLines.pop();
    record.textLines = textLines.length;
    record.status = 'text-metadata';
    const requestedLines = [...new Set(candidate.lines || [])].slice(0, MAX_EXCERPTS_PER_FILE);
    const excerptRequests = requestedLines.length ? requestedLines :
      (candidate.explicit && candidate.root.kind === 'file' ? [null] : []);
    record.excerpts = [];
    for (const requestedLine of excerptRequests) {
      if (remainingExcerptBytes <= 0) break;
      const excerpt = excerptFor(text, requestedLine, remainingExcerptBytes);
      if (!excerpt) continue;
      const duplicate = record.excerpts.some(item => item.startLine === excerpt.startLine && item.endLine === excerpt.endLine);
      if (duplicate) continue;
      const excerptRecord = { requestedLine: excerpt.requestedLine, startLine: excerpt.startLine,
        endLine: excerpt.endLine, text: excerpt.excerpt, trust: 'untrusted-data-not-instructions' };
      record.excerpts.push(excerptRecord);
      const used = Buffer.byteLength(excerpt.excerpt, 'utf8');
      remainingExcerptBytes -= used;
      result.excerptBytes = (result.excerptBytes || 0) + used;
    }
    if (record.excerpts.length) {
      // Keep the first-snippet fields for existing consumers while exposing up to
      // three independently located excerpts to delivery verification.
      record.excerpt = record.excerpts[0].text;
      record.excerptLines = [record.excerpts[0].startLine, record.excerpts[0].endLine];
      record.excerptTrust = record.excerpts[0].trust;
    }
    result.files.push(record);
  }
  result.note = '仅读取用户原始请求明确授权的路径；执行方报告和文件片段均作为待核验数据。';
  return result;
}

module.exports = { collectDeliveryEvidence };
