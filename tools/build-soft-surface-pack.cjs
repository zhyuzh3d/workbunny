'use strict';
// Build the official data-only package from the original, locally maintained preview.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { crc32 } = require('../src/main/avatar-pack-zip');
const source = process.argv[2] || path.resolve(__dirname, '../../Workbunny-designs/bunny-3d');
const output = process.argv[3] || path.resolve(__dirname, '../src/renderer/assets/avatar-packs/soft-bunny.wbavatar');
global.window = {}; require(path.join(source,'model-data.js')); require(path.join(source,'performances.js'));
const original = global.window.BunnyPerformances.list;
const categories = [ ['idle','待机'],['greet','见面与交流'],['cheer','开心与庆祝'],['shy','喜欢与害羞'],['think','好奇与思考'],['surprise','惊讶与害怕'],['sorry','难过与安慰'],['angry','愤怒与发火'],['refuse','拒绝与和好'],['tired','放松与休息'] ];
const group = new Map(categories.map(([id,label])=>[label,id]));
const stableId = p => 'act_' + crypto.createHash('sha256').update(p.name).digest('hex').slice(0,16);
const pose = (p, id) => ({ id, duration:p.duration, frames:p.frames.map(([t,v,e])=>e ? [t,v,e] : [t,v]), flights:p.flights.map(({from,to,y0,y1})=>({from,to,y0,y1})), ballFlights:p.ballFlights.map(({from,to,y0,y1})=>({from,to,y0,y1})), fx:p.fx || '', vfx:p.vfx || '', orbit:!!p.orbit, ballSpec:p.ballSpec || null, countdown:!!p.countdown, turns:p.turns || {}, comic:p.comic || null,
 autoBlink:['见面与交流','好奇与思考','难过与安慰','放松与休息'].includes(p.group) && p.duration > 2.05 && !p.frames.some(f=>['wl','wr','heart','star','diamond','joy'].some(k=>(f[1][k]||0)>.08)), idea:p.name==='灵光一闪', smokeBoost:p.name==='气到冒烟' });
const idle = { id:0,duration:3,frames:[[0,{}],[.5,{squash:.06,earTurn:.035}],[1,{}]],flights:[],ballFlights:[],fx:'',vfx:'',orbit:false,ballSpec:null,countdown:false,turns:{},comic:null,autoBlink:true,idea:false,smokeBoost:false };
const actions = { categories:categories.map(([id,label])=>({id,label,description:`用于表达${label}`})), actions:[{id:'idle',category:'idle',label:'平静呼吸',use:'平静自然待机',duration:idle.duration,loop:true,idle:true}, ...original.map(p=>({id:stableId(p),category:group.get(p.group),label:p.name,use:`${p.intent}；${p.description}`,duration:p.duration,loop:false}))] };
const graph = {palette:{base:'#9250d6',inner:'#ff759b'},defaultPalette:'plum',palettes:[
 {id:'plum',label:'葡萄紫',base:'#9250d6',inner:'#ff759b'}, {id:'rose',label:'莓果粉',base:'#ed4986',inner:'#ffa5c8'},
 {id:'lilac',label:'天空蓝',base:'#397cd6',inner:'#ff91b3'}, {id:'cream',label:'蜜橘黄',base:'#f0a72b',inner:'#f46e78'},
 {id:'black',label:'黑色',base:'#16141c',inner:'#e782a3'}, {id:'white',label:'白色',base:'#f6f4f5',inner:'#f493b1'}
],actions:[{id:'idle',loop:true,performance:idle},...original.map(p=>({id:stableId(p),loop:false,performance:pose(p,p.id)}))]};
const lines = {
 '你叫我吗': {text:'嗯？我在呢。',emotion:'happy'}, '开心蹦起来': {text:'哇，好开心！',emotion:'happy'},
 '笑得直不起腰': {text:'哈哈哈，好痒呀！',emotion:'happy'}, '谢谢你': {text:'谢谢你呀！',emotion:'happy'},
 '单耳快速招手': {text:'你好呀！',emotion:'happy'}, '左右耳接力': {text:'看我的小耳朵！',emotion:'happy'},
 '耳朵捂脸': {text:'哎呀，好害羞！',emotion:'relaxed'}, '耳朵鼓掌': {text:'好耶，鼓掌！',emotion:'happy'},
};
const byName = name => { const item=original.find(p=>p.name===name); if(!item || !lines[name])throw Error(`Missing ${name}`); return {action:stableId(item),speech:lines[name]}; };
const regions = [{id:'head',label:'头',pool:'head',priority:1,hitVolumes:[{type:'ellipsoid',anchor:'head',center:[0,0,0],size:[1.05,.86,.9]}]}];
for(const side of ['left','right']) regions.push({id:side+'_ear',label:side==='left'?'左耳':'右耳',pool:'ear',priority:5,hitVolumes:[0,1,2].map(i=>({type:'capsule',anchor:`${side}_ear_${i}`,center:[0,.27,0],size:[.20,.54,.20]}))});
const interactions={regions,pools:{head:['你叫我吗','开心蹦起来','笑得直不起腰','谢谢你'].map(byName),ear:['单耳快速招手','左右耳接力','耳朵捂脸','耳朵鼓掌'].map(byName)}};
const json=x=>Buffer.from(JSON.stringify(x)), files=new Map([['model.json',json(window.BUNNY_MODEL)],['actions.json',json(actions)],['graph.json',json(graph)],['interactions.json',json(interactions)]]);
const manifest={format:'workbunny.avatar-pack',formatVersion:1,id:'soft_bunny',version:'1.1.0',character:{id:'main',name:'bunny',model:'model.json'},requires:{runtime:'soft-surface-v1',features:['soft-surface-v1','hit-volumes-v1']},actions:'actions.json',graph:'graph.json',interactions:'interactions.json',defaultIdle:'idle',assets:[...files].map(([file,bytes])=>({path:file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}))};
files.set('manifest.json',json(manifest));
const chunks=[], central=[];let offset=0;
for(const [file,data] of files){const name=Buffer.from(file), local=Buffer.alloc(30),entry=Buffer.alloc(46),crc=crc32(data);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);chunks.push(local,name,data);central.push(entry,name);offset+=local.length+name.length+data.length;}
const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.concat([...chunks,dir,end]));console.log(`Wrote ${output} (${original.length} authored actions)`);
