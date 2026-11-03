'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function loadSoftwarePackages(root=path.join(__dirname,'../software-skills')){
 return ['workbuddy','wechat'].map(id=>{
  const directory=path.join(root,id),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.schema!=='bunny.software-skill/v1'||manifest.id!==id||!Number.isSafeInteger(manifest.version)||manifest.version<1||!Array.isArray(manifest.skills)||!Array.isArray(manifest.resources))throw Error('软件技能包清单无效：'+id);
  let instructions='';for(const resource of manifest.resources){
   if(!/^[a-zA-Z0-9_.-]+$/.test(resource.path))throw Error('技能资源路径无效');const file=path.join(directory,resource.path),stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>48000)throw Error('技能资源不是有效普通文件');const data=fs.readFileSync(file);
   if(crypto.createHash('sha256').update(data).digest('hex')!==resource.sha256)throw Error('技能资源内容发生变化：'+id+'/'+resource.path);
   if(resource.path.endsWith('.md'))instructions+=data.toString('utf8')+'\n';
  }return {...manifest,instructions};
 });
}
module.exports={loadSoftwarePackages};
