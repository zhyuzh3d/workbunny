'use strict';
// Build a clean source snapshot without Git history, runtime data or withheld assets.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const bundle=path.join(root,'dist/workbunny.app/Contents/Resources/app');
const built=JSON.parse(fs.readFileSync(path.join(bundle,'resources-manifest.json')));
const stage=path.join(root,'dist',`workbunny-${version}-source`),archive=stage+'.zip';
fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});const files=new Set(built.files.map(f=>f.path));
function walk(dir){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
 const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile()&&!e.name.startsWith('.')&&/\.(js|cjs|mjs|py|sh|command|swift|json|md|txt|html|css)$/.test(p))files.add(p);
}}
for(const dir of ['tools','test','native','docs','licenses','.github'])walk(dir);
for(const p of ['README.md','res/README.md','package-lock.json','resources-manifest.json','.gitignore'])files.add(p);
const inventory=[];
for(const p of [...files].sort()){
 const source=path.join(root,p),out=path.join(stage,p),st=fs.lstatSync(source);
 if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid source: '+p);
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(source,out);
 inventory.push({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')});
}
for(const a of built.privateAssets||[])if(fs.existsSync(path.join(stage,a.path)))throw Error('Withheld asset entered source: '+a.path);
if(fs.existsSync(path.join(stage,'src/renderer/assets/models/58.vrm')))throw Error('Personal model entered source');
fs.writeFileSync(path.join(stage,'SOURCE-INVENTORY.json'),JSON.stringify({version,sourceCommit:built.sourceCommit,sourceDirty:built.sourceDirty,files:inventory,gitHistoryIncluded:false,personalDataIncluded:false},null,2)+'\n');
cp.execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',stage,archive]);
console.log(JSON.stringify({archive:path.relative(root,archive),files:inventory.length}));
