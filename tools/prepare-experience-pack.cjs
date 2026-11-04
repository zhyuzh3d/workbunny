'use strict';
// Authoring helper only: hashes ordinary resources and validates the same
// contract used by the app. It never executes tools inside a resource pack.
const fs=require('node:fs'),path=require('node:path');
const {resourcePath,metadata}=require('../src/main/resource-zip'),{normalize,hash}=require('../src/main/experience-pack');
const root=fs.realpathSync(process.argv[2]||'.'),file=path.join(root,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8')),files=new Map();let total=0;
function visit(directory,prefix=''){for(const name of fs.readdirSync(directory)){const relative=prefix+name;if(relative==='manifest.json'||metadata(relative))continue;resourcePath(relative);const actual=path.join(directory,name),stat=fs.lstatSync(actual);if(stat.isSymbolicLink())throw Error('symbolic links are not permitted');if(stat.isDirectory()){visit(actual,relative+'/');continue;}if(!stat.isFile()||stat.size>16*1024*1024||files.size>=500)throw Error('resource limit exceeded');total+=stat.size;if(total>128*1024*1024)throw Error('pack is too large');files.set(relative,fs.readFileSync(actual));}}
visit(root);manifest.resources=[...files].map(([name,data])=>({path:name,bytes:data.length,sha256:hash(data)}));const result=normalize(manifest,files);fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({id:result.pack.id,version:result.pack.version,experiences:result.pack.experiences.length,tools:result.pack.tools.length,files:files.size}));
