'use strict';

const zlib = require('node:zlib');
const path=require('node:path');
const MAX_FILES=512,MAX_FILE_BYTES=64*1024*1024,MAX_TOTAL_BYTES=128*1024*1024;
function resourcePath(value){check(typeof value==='string'&&value.length>0&&value.length<=240&&!/[\\\u0000-\u001f\u007f:]/u.test(value)&&!value.startsWith('/')&&!value.endsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')&&path.posix.normalize(value)===value,'invalid resource path');return value;}
const metadata=name=>name.split('/').some(p=>p==='__MACOSX'||p==='.DS_Store'||p.startsWith('._'));
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function check(condition, message) { if (!condition) throw Error(message); }
function bounds(bytes, offset, length) { return offset >= 0 && length >= 0 && offset + length <= bytes.length; }
function nameOf(bytes,validatePath) {
  check(bytes.length > 0 && bytes.length <= 240,'invalid archive filename');
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('invalid archive filename encoding');}
  if (name === 'manifest.json') return name;
  if (name.endsWith('/')) {
    resourcePath(name.slice(0,-1));
    return name;
  }
  return validatePath(name);
}

// Reads files into memory without extracting paths to disk. Only ordinary,
// single-disk stored/deflated ZIPs are supported; malformed headers, links,
// duplicate paths and oversized entries fail before their contents are used.
function readResourceZip(bytes,{validatePath=resourcePath,allowRootFolder=false,manifestOptional=false,maxFiles=MAX_FILES,maxFileBytes=MAX_FILE_BYTES,maxTotalBytes=MAX_TOTAL_BYTES,maxArchiveBytes=MAX_ARCHIVE}={}) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= maxArchiveBytes, 'invalid archive size');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === SIGNATURE.end && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  check(end >= 0, 'missing ZIP directory');
  const disk = bytes.readUInt16LE(end + 4), directoryDisk = bytes.readUInt16LE(end + 6);
  const diskEntries = bytes.readUInt16LE(end + 8), count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  check(disk === 0 && directoryDisk === 0 && diskEntries === count && count > 0 && count <= maxFiles + 1 &&
    directoryOffset + directorySize === end, 'unsupported ZIP directory');
  let cursor = directoryOffset, total = 0;
  const entries = [], names = new Set(), spans = [];
  for (let i = 0; i < count; i++) {
    check(bounds(bytes, cursor, 46) && bytes.readUInt32LE(cursor) === SIGNATURE.central, 'invalid ZIP directory entry');
    const madeBy = bytes.readUInt16LE(cursor + 4), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const entryDisk = bytes.readUInt16LE(cursor + 34), external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    const endOfEntry = cursor + 46 + nameLength + extraLength + commentLength;
    check(endOfEntry <= end && entryDisk === 0 && (flags & ~0x080e) === 0 && (method === 0 || method === 8), 'unsupported ZIP entry');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = nameOf(rawName,validatePath), folded = name.normalize('NFC').toLowerCase();
    check(!names.has(folded), 'duplicate archive path'); names.add(folded);
    const mode = madeBy >>> 8 === 3 ? external >>> 16 : 0, type = mode & 0xf000;
    const directory = name.endsWith('/');
    check(directory ? (type === 0 || type === 0x4000) && size === 0 : type === 0 || type === 0x8000, 'archive entry is not a regular file');
    check(size <= (name === 'manifest.json'||name.endsWith('/manifest.json') ? MAX_MANIFEST : maxFileBytes), 'archive entry too large');
    total += size; check(total <= maxTotalBytes + MAX_MANIFEST, 'archive is too large');
    check(bounds(bytes, local, 30) && local < directoryOffset && bytes.readUInt32LE(local) === SIGNATURE.local, 'invalid ZIP local entry');
    const localFlags = bytes.readUInt16LE(local + 6), localMethod = bytes.readUInt16LE(local + 8);
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength, finish = start + compressed;
    check(localFlags === flags && localMethod === method && bounds(bytes, local + 30, localNameLength + localExtraLength) &&
      bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName) && finish <= directoryOffset, 'mismatched ZIP local entry');
    if (!(flags & 8)) check(bytes.readUInt32LE(local + 14) === crc && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === size, 'mismatched ZIP local sizes');
    check(!spans.some(span => local < span.end && finish > span.start), 'overlapping ZIP entries');
    spans.push({ start: local, end: finish });
    entries.push({ name, method, crc, compressed, size, start, finish, directory });
    cursor = endOfEntry;
  }
  check(cursor === end, 'invalid ZIP directory size');
  const files = new Map();
  for (const entry of entries) {
    const encoded = bytes.subarray(entry.start, entry.finish);
    let data;
    try { data = entry.method === 0 ? Buffer.from(encoded) : zlib.inflateRawSync(encoded, { maxOutputLength: Math.max(1, entry.size) }); }
    catch { throw Error('invalid compressed archive entry'); }
    check(data.length === entry.size && crc32(data) === entry.crc, 'invalid archive entry checksum');
    if (!entry.directory) files.set(entry.name, data);
  }
  if(allowRootFolder&&!files.has('manifest.json')){const roots=[...files.keys()].filter(n=>/^[^/]+\/manifest\.json$/u.test(n)&&!metadata(n));if(roots.length===1){const prefix=roots[0].slice(0,-'manifest.json'.length);check([...files.keys()].every(n=>n.startsWith(prefix)||metadata(n)),'multiple pack roots');for(const [n,data]of [...files]){files.delete(n);if(n.startsWith(prefix))files.set(n.slice(prefix.length),data);}}else if(!manifestOptional)throw Error('missing pack manifest');}
  if(manifestOptional&&!files.has('manifest.json')){
    const ordinary=[...files.keys()].filter(n=>!metadata(n)),roots=new Set(ordinary.map(n=>n.includes('/')?n.split('/')[0]:null));
    if(allowRootFolder&&roots.size===1&&!roots.has(null)){const prefix=ordinary[0].split('/')[0]+'/';for(const [name,data]of [...files]){files.delete(name);if(name.startsWith(prefix))files.set(name.slice(prefix.length),data);}}
    return {manifest:null,files};
  }
  check(files.has('manifest.json'),'missing pack manifest');
  const manifestBytes = files.get('manifest.json'); files.delete('manifest.json');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw Error('invalid pack manifest JSON'); }
  return { manifest, files };
}

module.exports={readResourceZip,resourcePath,metadata,crc32,MAX_ARCHIVE,MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES};
