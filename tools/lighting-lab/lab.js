import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {VRMLoaderPlugin,VRMUtils} from '@pixiv/three-vrm';
import {VRMAnimationLoaderPlugin,createVRMAnimationClip,VRMLookAtQuaternionProxy} from '@pixiv/three-vrm-animation';
import {createAvatarLighting,normalizeLighting,LIGHT_IDS} from '/avatar-lighting.mjs';
import {lightingForAvatar} from '/avatar-lighting-profiles.mjs';
import {makeRig,groundClip,soleHeight} from '/ground.js';
import {processMotionClip} from '/motion-quality.mjs';

const $=id=>document.getElementById(id), FORMAT='workbunny-lighting/v1', DRAFT='workbunny-lighting-lab/v1';
const labels={key:'主光',fill:'补光',rim:'轮廓光',top:'顶光'};
const state={models:[],profiles:{},revision:0,current:'',view:'bust',helpers:false,solo:null,comparing:false,dirty:false,loading:false,animated:false};
let vrm=null,mixer=null,modelBox=null,selectedLight='key',customURL=null,loadTicket=0,pendingModel=null,loading=false,dirtyFrame=true,resizePending=true;
const viewport=$('viewport'), renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,premultipliedAlpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x000000,0);viewport.prepend(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(28,1,.03,60);
const orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.dampingFactor=.1;orbit.minDistance=.15;orbit.maxDistance=18;orbit.target.set(0,1,0);
const rig=createAvatarLighting(scene,renderer),gizmo=new TransformControls(camera,renderer.domElement);gizmo.setSize(.75);gizmo.setSpace('world');scene.add(gizmo.getHelper());
const markers=new THREE.Group();scene.add(markers);const markerObjects=new Map();
for(const id of LIGHT_IDS){const mesh=new THREE.Mesh(new THREE.SphereGeometry(.065,12,8),new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false}));mesh.userData.lightId=id;mesh.renderOrder=100;markers.add(mesh);markerObjects.set(id,mesh);}
const targetLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineBasicMaterial({color:0x769c72,transparent:true,opacity:.7,depthTest:false}));markers.add(targetLine);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(12,12),new THREE.MeshStandardMaterial({color:0xe3e6e3,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.015;floor.receiveShadow=true;scene.add(floor);
const grid=new THREE.GridHelper(6,24,0xa8b6a7,0xc4cec1);grid.position.y=-.01;grid.material.transparent=true;grid.material.opacity=.22;scene.add(grid);
const loader=new GLTFLoader();loader.register(p=>new VRMLoaderPlugin(p));const animationLoader=new GLTFLoader();animationLoader.register(p=>new VRMAnimationLoaderPlugin(p));
const idle=animationLoader.loadAsync('/idle.vrma').then(g=>g.userData.vrmAnimations?.[0]).catch(()=>null);
const lookTarget=new THREE.Object3D();scene.add(lookTarget);
const clone=value=>structuredClone(value);
const currentModel=()=>state.models.find(m=>m.id===state.current);
const currentProfile=()=>state.profiles[state.current];
function get(object,path){return path.split('.').reduce((v,k)=>v?.[k],object);}
function set(object,path,value){const keys=path.split('.');let at=object;for(const key of keys.slice(0,-1))at=at[key];at[keys.at(-1)]=value;}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function status(text,error=false){$('status').textContent=text;$('status').parentElement.classList.toggle('error',error);}
function ensureProfile(model){return state.profiles[model.id]||=( {label:model.label,lighting:lightingForAvatar(model.id,model.scale||1)} );}
function rememberDraft(){try{localStorage.setItem(DRAFT,JSON.stringify({format:FORMAT,profiles:state.profiles,dirty:state.dirty,current:state.current,view:state.view,background:$('background').value}));}catch{status('浏览器草稿空间不足，请保存或导出参数。',true);}}
function changed(){state.dirty=true;rememberDraft();status('有未保存的调整 · 每个角色单独记录');}
function updateMarkers(){
  markers.visible=state.helpers;gizmo.getHelper().visible=state.helpers;
  for(const id of LIGHT_IDS){const source=rig.getLight(id),marker=markerObjects.get(id);marker.position.copy(source.position);marker.material.color.copy(source.color);marker.material.opacity=source.visible?1:.35;marker.material.transparent=true;marker.scale.setScalar(id===selectedLight?1.3:1);}
  const item=rig.getLight(selectedLight),target=item.target?.position||new THREE.Vector3(0,1,0),attribute=targetLine.geometry.attributes.position;
  attribute.setXYZ(0,...item.position.toArray());attribute.setXYZ(1,...target.toArray());attribute.needsUpdate=true;targetLine.geometry.computeBoundingSphere();
  if(state.helpers&&gizmo.object!==item)gizmo.attach(item);if(!state.helpers)gizmo.detach();
}
function apply(){
  if(!currentProfile())return;
  let config=state.comparing?lightingForAvatar(state.current,currentModel()?.scale||1):clone(currentProfile().lighting);
  if(state.solo&&!state.comparing){config.ambient.enabled=false;config.hemisphere.enabled=false;for(const id of LIGHT_IDS)config.lights[id].enabled=id===state.solo;}
  rig.apply(config);updateMarkers();dirtyFrame=true;
  $('previewBadge').textContent=state.comparing?'原版照明':state.solo?'单灯预览 · '+labels[state.solo]:'实时预览';
  document.body.dataset.comparing=String(state.comparing);
}
function selectLight(id){selectedLight=id;state.helpers=true;$('helpers').checked=true;updateMarkers();dirtyFrame=true;}
gizmo.addEventListener('dragging-changed',e=>{orbit.enabled=!e.value;});
gizmo.addEventListener('objectChange',()=>{
  if(state.loading||state.comparing||!gizmo.object)return;
  currentProfile().lighting.lights[selectedLight].position=gizmo.object.position.toArray().map(v=>Math.round(Math.max(-10,Math.min(10,v))*100)/100);
  syncControls();apply();changed();
});
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();renderer.domElement.addEventListener('pointerdown',e=>{
  if(!state.helpers||gizmo.dragging)return;const box=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-box.left)/box.width*2-1,-(e.clientY-box.top)/box.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects([...markerObjects.values()])[0];if(hit){selectLight(hit.object.userData.lightId);document.querySelector(`[data-light="${selectedLight}"]`).open=true;}
});
function card(title,open=false,id=''){
  const details=node('details','control-card');details.open=open;if(id)details.dataset.light=id;
  const summary=node('summary');summary.append(node('span','',title));const note=node('span','card-summary',id?'可单独开关':'');summary.append(note);const body=node('div','card-body');details.append(summary,body);$('controls').append(details);return body;
}
function toggle(parent,label,path,optional=false){
  const row=node('label','control-row toggle-row'),input=node('input');input.type='checkbox';input.setAttribute('role','switch');input.dataset.path=path;input.dataset.kind=optional?'optional':'boolean';input.setAttribute('aria-label',label);row.append(node('span','',label),input);parent.append(row);return input;
}
function range(parent,label,path,min,max,step,optional=false){
  const row=node('label','control-row');row.append(node('span','',label));
  for(const type of ['range','number']){const input=node('input');input.type=type;input.min=min;input.max=max;input.step=step;input.dataset.path=path;input.dataset.kind='number';input.setAttribute('aria-label',label+(type==='range'?'滑块':''));if(optional)input.dataset.nullable='true';row.append(input);}parent.append(row);return row;
}
function select(parent,label,path,values){const row=node('label','control-row select-row'),input=node('select');input.dataset.path=path;input.dataset.kind='select';input.setAttribute('aria-label',label);for(const [value,text]of values){const option=node('option','',text);option.value=value;input.append(option);}row.append(node('span','',label),input);parent.append(row);return input;}
function color(parent,label,path,presets=false){const row=node('label','control-row color-row');row.append(node('span','',label));for(const type of ['color','text']){const input=node('input',type==='text'?'hex-input':'');input.type=type;input.dataset.path=path;input.dataset.kind='color';input.setAttribute('aria-label',label+(type==='text'?'色值':''));if(type==='text')input.maxLength=7;row.append(input);}parent.append(row);if(presets){const buttons=node('div','color-presets');for(const [name,value]of [['暖白','#ffe5c8'],['自然','#ffffff'],['冷白','#c5d7ff']]){const button=node('button','',name);button.onclick=()=>edit(path,value);buttons.append(button);}parent.append(buttons);}}
function vector(parent,label,path){parent.append(node('div','mini-heading',label));for(const [index,name]of ['横向 X','高度 Y','前后 Z'].entries())range(parent,name,path+'.'+index,-6,6,.05);}
function buildControls(){
  const overall=card('整体',true);range(overall,'整体亮度','multiplier',0,3,.01);select(overall,'高光处理','toneMapping',[['none','保持原样'],['linear','线性'],['aces','电影柔化'],['neutral','中性色调']]);range(overall,'曝光','exposure',.05,4,.01);overall.append(node('p','tiny-note','选择高光处理后可调整曝光。'));
  const ambient=card('环境光');toggle(ambient,'开启环境光','ambient.enabled');range(ambient,'强度','ambient.intensity',0,8,.01);color(ambient,'颜色','ambient.color');toggle(ambient,'开启天空 / 地面光','hemisphere.enabled');range(ambient,'天空光强度','hemisphere.intensity',0,8,.01);color(ambient,'天空颜色','hemisphere.color');color(ambient,'地面颜色','hemisphere.groundColor');
  for(const id of LIGHT_IDS){const body=card(labels[id],id==='key',id),base='lights.'+id;
    toggle(body,'开启'+labels[id],base+'.enabled');select(body,'光源类型',base+'.type',[['directional','平行光'],['point','点光源'],['spot','聚光灯']]);
    range(body,'强度',base+'.intensity',0,12,.01);color(body,'颜色',base+'.color',true);vector(body,'灯光位置',base+'.position');
    const target=node('div','sub-controls');target.dataset.target=id;vector(target,'照向位置',base+'.target');body.append(target);
    const spot=node('div','sub-controls');spot.dataset.spot=id;range(spot,'光束角度',base+'.angle',5,90,1);range(spot,'边缘柔和',base+'.penumbra',0,1,.01);body.append(spot);
    const point=node('div','sub-controls');point.dataset.point=id;range(point,'照射范围',base+'.distance',0,30,.1);range(point,'距离衰减',base+'.decay',0,3,.05);body.append(point);
    const actions=node('div','lamp-actions'),move=node('button','','移动此灯'),face=node('button','','照向脸部'),solo=node('button','','单独看');
    move.onclick=()=>{selectLight(id);fit('lights');};face.onclick=()=>{const head=vrm?.humanoid?.getNormalizedBoneNode('head'),position=head?head.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(0,1.3,0);edit(base+'.target',position.toArray().map(n=>Math.round(n*100)/100));};
    solo.dataset.solo=id;solo.onclick=()=>{state.solo=state.solo===id?null:id;apply();syncControls();};actions.append(move,face,solo);body.append(actions);
  }
  const shadows=card('阴影');toggle(shadows,'开启模型阴影','shadows.enabled');select(shadows,'阴影清晰度','shadows.mapSize',[['512','轻量'],['1024','标准'],['2048','精细']]);range(shadows,'表面偏移','shadows.normalBias',0,.2,.001);range(shadows,'阴影偏移','shadows.bias',-.01,.01,.0001);
  const material=card('材质细节');range(material,'自发光亮度','material.emissive',0,3,.01);
  for(const [key,name,min,max]of [['toony','明暗硬度',0,1],['shift','亮面范围',-1,1],['gi','环境光均匀度',0,1]]){toggle(material,'调整'+name,'material.'+key,true);range(material,name,'material.'+key,min,max,.01,true);}
  $('controls').addEventListener('input',onControl);$('controls').addEventListener('change',e=>onControl(e,true));
}
function edit(path,value){if(!currentProfile()||state.loading||state.comparing)return;const previous=get(currentProfile().lighting,path);set(currentProfile().lighting,path,value);currentProfile().lighting=normalizeLighting(currentProfile().lighting);if(path.endsWith('.type')&&value!==previous){gizmo.detach();set(currentProfile().lighting,path.replace('.type','.intensity'),value==='directional'?lightingForAvatar(state.current,currentModel()?.scale||1).lights[path.split('.')[1]].intensity:30);}apply();syncControls();changed();}
function onControl(event,force=false){const input=event.target,path=input.dataset.path;if(!path)return;let value=input.value;
  if(input.dataset.kind==='boolean')value=input.checked;
  else if(input.dataset.kind==='optional'){const defaults={toony:.9,shift:0,gi:.9};value=input.checked?defaults[path.split('.').at(-1)]:null;}
  else if(input.dataset.kind==='number'||path==='shadows.mapSize'){if(value===''||!Number.isFinite(Number(value)))return;value=Number(value);}
  else if(input.dataset.kind==='color'&&!/^#[\da-f]{6}$/i.test(value)){if(force)syncControls(true);return;}
  edit(path,value);if(force)syncControls(true);
}
function syncControls(force=false){const config=currentProfile()?.lighting;if(!config)return;
  for(const input of $('controls').querySelectorAll('[data-path]')){const value=get(config,input.dataset.path);if(force||input!==document.activeElement){if(input.dataset.kind==='boolean')input.checked=!!value;else if(input.dataset.kind==='optional')input.checked=value!==null;else input.value=value??(input.min||0);}
    input.disabled=state.comparing||input.dataset.nullable==='true'&&value===null||input.dataset.path==='exposure'&&config.toneMapping==='none';
  }
  for(const id of LIGHT_IDS){const type=config.lights[id].type;document.querySelector(`[data-target="${id}"]`).hidden=type==='point';document.querySelector(`[data-point="${id}"]`).hidden=type==='directional';document.querySelector(`[data-spot="${id}"]`).hidden=type!=='spot';
    for(const input of $('controls').querySelectorAll(`[data-path="lights.${id}.intensity"]`)){input.max=type==='directional'?12:150;input.step=type==='directional'?.01:.1;}
    document.querySelector(`[data-solo="${id}"]`).textContent=state.solo===id?'退出单灯':'单独看';
  }
}
function fit(view=state.view){state.view=view;for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===view);if(!modelBox)return;
  const size=modelBox.getSize(new THREE.Vector3()),center=modelBox.getCenter(new THREE.Vector3()),height=size.y;
  if(view==='lights'){camera.position.set(5,3.5,6);orbit.target.set(0,1,0);}
  else{const aim=view==='face'?modelBox.max.y-height*.105:view==='bust'?modelBox.max.y-height*.3:center.y;const visible=view==='face'?height*.32:view==='bust'?height*.76:height*1.18;const distance=Math.max(visible/2/Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),size.x/(2*camera.aspect*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*(view==='full'?1.1:.6));camera.position.set(0,aim,distance);orbit.target.set(0,aim,0);}
  camera.lookAt(orbit.target);orbit.update();dirtyFrame=true;rememberDraft();
}
function soften(root){const samples=renderer.getContext().getParameter(renderer.getContext().SAMPLES);if(!samples)return;root.traverse(mesh=>{if(!mesh.isMesh)return;for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])if(m?.alphaTest>0&&!m.transparent){m.alphaToCoverage=true;m.needsUpdate=true;}});}
function dispose(root){if(root)VRMUtils.deepDispose(root);}
async function loadModel(id){
  state.current=id;const model=currentModel();if(!model)return;ensureProfile(model);$('model').value=id;const ticket=++loadTicket;
  if(loading){pendingModel=id;return;}
  loading=true;state.loading=true;$('loading').hidden=false;$('loading').textContent='正在载入 '+model.label+'…';$('controls').disabled=true;$('save').disabled=true;
  let candidate;
  try{
    const gltf=await loader.loadAsync(model.url);candidate=gltf.userData.vrm;if(!candidate)throw Error('文件没有可用的 VRM 模型');
    if(ticket!==loadTicket){dispose(candidate.scene);return;}
    if(candidate.meta?.metaVersion==='0')candidate.scene.rotation.y=Math.PI;candidate.scene.traverse(o=>{o.frustumCulled=false;});soften(candidate.scene);
    if(candidate.humanoid)candidate.humanoid.autoUpdateHumanBones=true;
    if(candidate.lookAt){candidate.lookAt.target=lookTarget;const proxy=new VRMLookAtQuaternionProxy(candidate.lookAt);proxy.name='VRMLookAtQuaternionProxy';candidate.scene.add(proxy);}
    const animation=await idle;if(ticket!==loadTicket){dispose(candidate.scene);return;}
    const nextMixer=new THREE.AnimationMixer(candidate.scene);
    if(animation){try{let clip=createVRMAnimationClip(animation,candidate);const fakeRig=makeRig(candidate);if(fakeRig)groundClip(clip,fakeRig,soleHeight(clip,fakeRig));processMotionClip(clip,{loop:true});nextMixer.clipAction(clip).play();nextMixer.setTime(1);}catch(error){console.warn('待机动作未载入，使用站姿',error.message);}}
    if(vrm){mixer?.stopAllAction();scene.remove(vrm.scene);dispose(vrm.scene);}
    vrm=candidate;mixer=nextMixer;scene.add(vrm.scene);vrm.update(0);vrm.scene.updateMatrixWorld(true);modelBox=new THREE.Box3().setFromObject(vrm.scene);rig.setModel(vrm.scene);
    state.loading=false;apply();syncControls(true);fit(state.view);lookTarget.position.copy(camera.position);vrm.update(0);dirtyFrame=true;$('modelTitle').textContent=model.label;$('controls').disabled=false;$('save').disabled=false;$('loading').hidden=true;document.body.dataset.ready='true';
    const count=new Set();vrm.scene.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m)count.add(m);});$('renderNote').textContent=`${count.size} 个材质 · 本地渲染`;
    status(state.dirty?'有未保存的调整 · 每个角色单独记录':'与 Bunny 当前灯光参数一致，可直接调整');rememberDraft();
  }catch(error){if(candidate&&candidate!==vrm)dispose(candidate.scene);$('loading').textContent='模型未能载入：'+error.message;status('模型未能载入，可重新选择或导入 VRM。',true);state.loading=false;$('save').disabled=false;}
  finally{loading=false;if(pendingModel){const next=pendingModel;pendingModel=null;void loadModel(next);}}
}
function modelOptions(){const value=state.current;$('model').replaceChildren(...state.models.map(m=>{const o=node('option','',m.label);o.value=m.id;return o;}));if(state.models.some(m=>m.id===value))$('model').value=value;}
function bundle(){return {format:FORMAT,revision:state.revision,profiles:clone(state.profiles)};}
async function api(url,options){const response=await fetch(url,options),data=await response.json();if(!response.ok)throw Error(data.error||'操作未完成');return data;}
function normalizeBundle(data){if(data?.format!==FORMAT||!data.profiles||typeof data.profiles!=='object'||Array.isArray(data.profiles)||Object.keys(data.profiles).length>64)throw Error('请选择本工作台导出的参数文件');return Object.fromEntries(Object.entries(data.profiles).filter(([id,row])=>!['__proto__','constructor','prototype'].includes(id)&&row?.lighting&&typeof row.lighting==='object').map(([id,row])=>[id,{label:String(row.label||id).slice(0,80),lighting:normalizeLighting(row.lighting)}]));}
$('model').onchange=()=>void loadModel($('model').value);
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>fit(button.dataset.view);
function background(value){$('background').value=value;viewport.style.backgroundColor=value;floor.material.color.set(value);dirtyFrame=true;rememberDraft();}
$('background').oninput=()=>background($('background').value);for(const b of document.querySelectorAll('[data-bg]'))b.onclick=()=>background(b.dataset.bg);
$('helpers').onchange=()=>{state.helpers=$('helpers').checked;updateMarkers();dirtyFrame=true;};$('floor').onchange=()=>{floor.visible=grid.visible=$('floor').checked;dirtyFrame=true;};$('animated').onchange=()=>{state.animated=$('animated').checked;dirtyFrame=true;};
function compare(value){state.comparing=value;apply();syncControls();$('compare').classList.toggle('comparing',value);}
$('compare').addEventListener('pointerdown',e=>{if(state.loading)return;e.preventDefault();$('compare').setPointerCapture(e.pointerId);compare(true);});for(const event of ['pointerup','pointercancel','lostpointercapture','blur'])$('compare').addEventListener(event,()=>compare(false));
$('compare').onkeydown=e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();compare(true);}};$('compare').onkeyup=()=>compare(false);window.addEventListener('blur',()=>{if(state.comparing)compare(false);});
$('reset').onclick=()=>{if(state.loading||!confirm('还原当前角色的灯光？其他角色的调整会保留。'))return;currentProfile().lighting=lightingForAvatar(state.current,currentModel()?.scale||1);state.solo=null;apply();syncControls(true);changed();};
for(const button of document.querySelectorAll('[data-preset]'))button.onclick=()=>{if(state.loading)return;const config=lightingForAvatar(state.current,currentModel()?.scale||1),mode=button.dataset.preset;
  if(mode==='soft'){config.ambient.intensity*=.42;config.lights.key.intensity*=.7;config.lights.fill.intensity*=.7;config.lights.rim.intensity*=.45;config.toneMapping='neutral';config.exposure=.95;}
  if(mode==='studio'){config.ambient.intensity*=.3;config.lights.key.position=[-1.5,2.3,2];config.lights.key.target=[0,1.15,0];config.lights.key.intensity*=.8;config.lights.fill.intensity*=.9;config.lights.rim.intensity*=.6;config.toneMapping='aces';}
  if(mode==='off'){config.ambient.enabled=false;config.hemisphere.enabled=false;for(const light of Object.values(config.lights))light.enabled=false;}
  currentProfile().lighting=normalizeLighting(config);state.solo=null;apply();syncControls(true);changed();
};
$('save').onclick=async()=>{state.solo=null;apply();syncControls();const snapshot=bundle();$('save').disabled=true;try{const result=await api('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});state.revision=result.revision;const edited=JSON.stringify(state.profiles)!==JSON.stringify(snapshot.profiles);if(!edited)state.profiles=result.profiles;state.dirty=edited;rememberDraft();status(edited?'上次调整已保存 · 新调整尚未保存':'参数已保存。调好后告诉我，即可按这份配置应用到 Bunny。');$('savedAt').textContent='保存于 '+new Date(result.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});}catch(error){status(error.message+'；可以先导出 JSON。',true);}finally{$('save').disabled=false;}};
$('download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(bundle(),null,2)+'\n'],{type:'application/json'})),a=node('a');a.href=url;a.download='workbunny-lighting.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('importSettings').onclick=()=>$('settingsFile').click();$('settingsFile').onchange=async()=>{try{const file=$('settingsFile').files[0];if(!file)return;if(file.size>512*1024)throw Error('参数文件不能超过512KB');const incoming=normalizeBundle(JSON.parse(await file.text()));state.profiles={...state.profiles,...incoming};apply();syncControls(true);changed();status('已导入参数，可继续调整并保存。');}catch(error){status(error.message,true);}finally{$('settingsFile').value='';}};
$('importModel').onclick=()=>$('vrmFile').click();$('vrmFile').onchange=async()=>{try{const file=$('vrmFile').files[0];if(!file)return;if(file.size>100*1024*1024)throw Error('请选择小于100MB的 VRM 文件');const data=await file.arrayBuffer();if(new DataView(data).getUint32(0,true)!==0x46546c67)throw Error('请选择有效的 VRM 文件');const digest=await crypto.subtle.digest('SHA-256',data),id='custom:'+Array.from(new Uint8Array(digest)).slice(0,8).map(n=>n.toString(16).padStart(2,'0')).join('');if(customURL)URL.revokeObjectURL(customURL);customURL=URL.createObjectURL(file);state.models=state.models.filter(m=>!m.personal);state.models.push({id,label:file.name.replace(/\.vrm$/i,''),scale:1,url:customURL,personal:true});modelOptions();void loadModel(id);}catch(error){status(error.message,true);}finally{$('vrmFile').value='';}};
new ResizeObserver(()=>{resizePending=true;dirtyFrame=true;}).observe(viewport);
function resize(){if(!resizePending)return;resizePending=false;const {width,height}=viewport.getBoundingClientRect();renderer.setSize(Math.max(1,Math.floor(width)),Math.max(1,Math.floor(height)),false);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();}
let last=performance.now();function frame(now){const dt=Math.min(.05,(now-last)/1000);last=now;resize();const moved=orbit.update();if(vrm){lookTarget.position.copy(camera.position);if(state.animated&&mixer){mixer.update(dt);vrm.update(dt);dirtyFrame=true;}else if(moved)vrm.update(0);}
  if(dirtyFrame||moved){updateMarkers();renderer.render(scene,camera);dirtyFrame=false;}requestAnimationFrame(frame);
}requestAnimationFrame(frame);
window.addEventListener('beforeunload',()=>{if(customURL)URL.revokeObjectURL(customURL);});
window.__lightingLab={state:()=>({model:state.current,ready:document.body.dataset.ready==='true',loading:state.loading,lighting:clone(currentProfile()?.lighting),rendered:rig.snapshot(),position:rig.getLight('key').position.toArray(),view:state.view,helpers:state.helpers}),capture:()=>{resize();renderer.render(scene,camera);return renderer.domElement.toDataURL('image/png');}};
async function init(){buildControls();const [{models},saved]=await Promise.all([api('/api/models'),api('/api/profiles')]);state.models=models;state.profiles=normalizeBundle(saved);state.revision=saved.revision;
  let draft;try{draft=JSON.parse(localStorage.getItem(DRAFT));if(draft?.dirty){state.profiles={...state.profiles,...normalizeBundle(draft)};state.dirty=true;}}catch{}
  modelOptions();for(const model of models)ensureProfile(model);if(draft?.view)state.view=['bust','full','face','lights'].includes(draft.view)?draft.view:'bust';if(/^#[\da-f]{6}$/i.test(draft?.background))background(draft.background);
  await loadModel(state.models.some(m=>m.id===draft?.current)?draft.current:models[0].id);
}
init().catch(error=>{status(error.message,true);$('loading').textContent='工作台未能启动，请刷新重试。';console.error(error);});
