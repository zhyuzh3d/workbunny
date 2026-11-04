'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {readResourceZip,crc32}=require('../src/main/resource-zip');
function archive(items) {
  const locals = [], central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data || ''), method = item.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(3 << 8 | 20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(data), 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE((item.mode || 0x8000) * 65536, 38); header.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(header, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const base=()=>[{name:'manifest.json',data:'{"schema":"fixture"}'},{name:'经验/方法.md',data:'保留实际依据，按情景判断。'}];
test('resource ZIP supports UTF-8 and one enclosing folder without extracting files',()=>{
 const input=base().map(r=>({...r,name:'资源包/'+r.name})),p=readResourceZip(archive(input),{allowRootFolder:true});assert.equal(p.manifest.schema,'fixture');assert.equal(p.files.get('经验/方法.md').toString(),'保留实际依据，按情景判断。');
 assert.throws(()=>readResourceZip(archive([...input,{name:'other.txt',data:'outside root'}]),{allowRootFolder:true}),/multiple pack roots/);
});
test('untrusted archives reject traversal, case collisions, links, corrupt data and size inflation',()=>{
 for(const extra of [{name:'../escape.txt',data:'x'},{name:'/absolute.txt',data:'x'},{name:'MANIFEST.JSON',data:'x'},{name:'tool.js',mode:0xa000,data:'link'}])assert.throws(()=>readResourceZip(archive([...base(),extra])));
 const bad=archive(base());bad[30+'manifest.json'.length]^=1;assert.throws(()=>readResourceZip(bad));
 const inflated=archive(base()),end=inflated.length-22,central=inflated.readUInt32LE(end+16);inflated.writeUInt32LE(0xffffffff,central+24);assert.throws(()=>readResourceZip(inflated));
});
