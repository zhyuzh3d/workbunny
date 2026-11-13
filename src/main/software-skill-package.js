'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function interpretationKnowledge(packages){
 return packages.flatMap(pack=>{
  if(pack.interpretationSections===undefined)return [];
  const names=pack.interpretationSections;
  if(!Array.isArray(names)||!names.length||names.length>8||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!name.trim()||name.length>120))throw Error('任务含义章节声明无效：'+pack.id);
  const sections=String(pack.instructions||'').split(/(?=^## )/mu);
  const chosen=names.map(name=>{
   const matches=sections.filter(section=>section.split('\n',1)[0].trim()==='## '+name);
   if(matches.length!==1)throw Error('任务含义章节缺失或重复：'+pack.id+'/'+name);
   return matches[0].trim();
  }).join('\n\n');
  if(chosen.length>8000)throw Error('任务含义章节过长：'+pack.id);
  return [{packageId:pack.id,application:pack.application,origin:'innate',revision:pack.version,status:'bundled',instructions:chosen,purpose:'task-interpretation-not-authorization'}];
 });
}
function loadSoftwarePackages(root=path.join(__dirname,'../software-skills')){
 return ['workbuddy','wechat','common'].map(id=>{
  const directory=path.join(root,id),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.schema!=='bunny.software-skill/v1'||manifest.id!==id||!Number.isSafeInteger(manifest.version)||manifest.version<1||!Array.isArray(manifest.skills)||!Array.isArray(manifest.resources))throw Error('软件技能包清单无效：'+id);
  let instructions='';for(const resource of manifest.resources){
   if(!/^[a-zA-Z0-9_.-]+$/.test(resource.path))throw Error('技能资源路径无效');const file=path.join(directory,resource.path),stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>48000)throw Error('技能资源不是有效普通文件');const data=fs.readFileSync(file);
   if(crypto.createHash('sha256').update(data).digest('hex')!==resource.sha256)throw Error('技能资源内容发生变化：'+id+'/'+resource.path);
   if(resource.path.endsWith('.md'))instructions+=data.toString('utf8')+'\n';
  }const pack={...manifest,instructions};interpretationKnowledge([pack]);return pack;
 });
}
module.exports={loadSoftwarePackages,interpretationKnowledge};
