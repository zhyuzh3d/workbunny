import * as THREE from 'three';

const light = (color,intensity,position,enabled=true) => ({type:'directional',enabled,color,intensity,position,target:[0,0,0],distance:0,decay:2,angle:45,penumbra:.35});
export const DEFAULT_LIGHTING = {
  version:1, multiplier:1, toneMapping:'none', exposure:1,
  ambient:{enabled:true,color:'#ffffff',intensity:1.9},
  hemisphere:{enabled:false,color:'#e3edff',groundColor:'#716657',intensity:.5},
  lights:{key:light('#fff6ec',2.1,[1.1,2.6,2.2]),rim:light('#bcc8ff',1.15,[-1.6,1.7,-1.6]),fill:light('#ffffff',.5,[0,.6,3]),top:light('#ffffff',.8,[0,3,0],false)},
  shadows:{enabled:false,mapSize:1024,bias:-.0003,normalBias:.02},
  material:{emissive:1,toony:null,shift:null,gi:null},
};
export const LIGHT_IDS = ['key','fill','rim','top'];
const toneMaps = {none:THREE.NoToneMapping,linear:THREE.LinearToneMapping,aces:THREE.ACESFilmicToneMapping,neutral:THREE.NeutralToneMapping};
const number = (value,fallback,min,max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
const color = (value,fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
const vector = (value,fallback) => fallback.map((n,i)=>number(value?.[i],n,-10,10));
const bool = (value,fallback) => typeof value === 'boolean' ? value : fallback;

export function normalizeLighting(value={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const d = DEFAULT_LIGHTING, ambient=value.ambient||{}, hemisphere=value.hemisphere||{}, shadows=value.shadows||{}, material=value.material||{};
  return {version:1,multiplier:number(value.multiplier,d.multiplier,0,3),toneMapping:Object.hasOwn(toneMaps,value.toneMapping)?value.toneMapping:d.toneMapping,exposure:number(value.exposure,1,.05,4),
    ambient:{enabled:bool(ambient.enabled,true),color:color(ambient.color,d.ambient.color),intensity:number(ambient.intensity,1.9,0,8)},
    hemisphere:{enabled:bool(hemisphere.enabled,false),color:color(hemisphere.color,d.hemisphere.color),groundColor:color(hemisphere.groundColor,d.hemisphere.groundColor),intensity:number(hemisphere.intensity,.5,0,8)},
    lights:Object.fromEntries(LIGHT_IDS.map(id=>{const v=value.lights?.[id]||{},base=d.lights[id];return [id,{type:['directional','point','spot'].includes(v.type)?v.type:base.type,enabled:bool(v.enabled,base.enabled),color:color(v.color,base.color),intensity:number(v.intensity,base.intensity,0,200),position:vector(v.position,base.position),target:vector(v.target,base.target),distance:number(v.distance,0,0,30),decay:number(v.decay,2,0,3),angle:number(v.angle,45,5,90),penumbra:number(v.penumbra,.35,0,1)}];})),
    shadows:{enabled:bool(shadows.enabled,false),mapSize:[512,1024,2048].includes(shadows.mapSize)?shadows.mapSize:1024,bias:number(shadows.bias,-.0003,-.02,.02),normalBias:number(shadows.normalBias,.02,0,.2)},
    material:{emissive:number(material.emissive,1,0,3),...Object.fromEntries([['toony',0,1],['shift',-1,1],['gi',0,1]].map(([k,min,max])=>[k,typeof material[k]==='number'?number(material[k],null,min,max):null]))},
  };
}
export function modelLighting(scale=1) {
  const config = normalizeLighting();
  config.ambient.intensity *= scale; config.hemisphere.intensity *= scale;
  for (const item of Object.values(config.lights)) item.intensity *= scale;
  return config;
}
export function createAvatarLighting(scene,renderer) {
  const group = new THREE.Group(); group.name='WorkbunnyLighting'; scene.add(group);
  const ambient = new THREE.AmbientLight(), hemisphere = new THREE.HemisphereLight();
  group.add(ambient,hemisphere);
  const slots = new Map(), baselines = new WeakMap();
  let model=null, current=normalizeLighting(), scale=1;
  function applyMaterials() {
    model?.traverse(mesh=>{
      if (!mesh.isMesh) return;
      if (!baselines.has(mesh)) baselines.set(mesh,{castShadow:mesh.castShadow,receiveShadow:mesh.receiveShadow});
      const baseMesh=baselines.get(mesh);
      mesh.castShadow=current.shadows.enabled || baseMesh.castShadow;
      mesh.receiveShadow=current.shadows.enabled || baseMesh.receiveShadow;
      for (const m of Array.isArray(mesh.material)?mesh.material:[mesh.material]) {
        if (!m) continue;
        if (!baselines.has(m)) baselines.set(m,{emissiveIntensity:m.emissiveIntensity,shadingToonyFactor:m.shadingToonyFactor,shadingShiftFactor:m.shadingShiftFactor,giEqualizationFactor:m.giEqualizationFactor});
        const original=baselines.get(m);
        if (typeof original.emissiveIntensity==='number') m.emissiveIntensity=original.emissiveIntensity*current.material.emissive;
        for (const [key,setting] of [['shadingToonyFactor','toony'],['shadingShiftFactor','shift'],['giEqualizationFactor','gi']]) if (typeof original[key]==='number') m[key]=current.material[setting]??original[key];
      }
    });
  }
  function apply(value=DEFAULT_LIGHTING,modelScale=1) {
    current=normalizeLighting(value); scale=number(modelScale,1,0,3);
    const intensity=current.multiplier*scale;
    ambient.visible=current.ambient.enabled; ambient.color.set(current.ambient.color); ambient.intensity=current.ambient.intensity*intensity;
    hemisphere.visible=current.hemisphere.enabled; hemisphere.color.set(current.hemisphere.color); hemisphere.groundColor.set(current.hemisphere.groundColor); hemisphere.intensity=current.hemisphere.intensity*intensity;
    for (const id of LIGHT_IDS) {
      const c=current.lights[id]; let item=slots.get(id);
      if (!item || item.userData.lightingType!==c.type) {
        if (item) {group.remove(item,item.target);item.shadow?.map?.dispose();}
        item=c.type==='point'?new THREE.PointLight():c.type==='spot'?new THREE.SpotLight():new THREE.DirectionalLight();
        item.name=id;item.userData.lightingType=c.type;slots.set(id,item);group.add(item);if(item.target)group.add(item.target);
      }
      item.visible=c.enabled;item.color.set(c.color);item.intensity=c.intensity*intensity;item.position.fromArray(c.position);
      if(item.target)item.target.position.fromArray(c.target);
      if(c.type!=='directional'){item.distance=c.distance;item.decay=c.decay;}
      if(c.type==='spot'){item.angle=THREE.MathUtils.degToRad(c.angle);item.penumbra=c.penumbra;}
      item.castShadow=current.shadows.enabled && c.enabled;
      if(item.shadow){
        const shadow=item.shadow;
        if(shadow.mapSize.x!==current.shadows.mapSize){shadow.map?.dispose();shadow.map=null;}
        shadow.mapSize.setScalar(current.shadows.mapSize);shadow.bias=current.shadows.bias;shadow.normalBias=current.shadows.normalBias;
        if(c.type==='directional')Object.assign(shadow.camera,{left:-2,right:2,top:3,bottom:-1,near:.05,far:20});
        shadow.camera.updateProjectionMatrix();
      }
    }
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=toneMaps[current.toneMapping];renderer.toneMappingExposure=current.exposure;
    renderer.shadowMap.enabled=current.shadows.enabled;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.needsUpdate=true;
    applyMaterials();group.updateMatrixWorld(true);
    return current;
  }
  apply();
  return {group,ambient,hemisphere,apply,getLight:id=>slots.get(id),snapshot:()=>structuredClone(current),setModel:root=>{model=root;applyMaterials();},dispose:()=>{scene.remove(group);for(const item of slots.values())item.shadow?.map?.dispose();model=null;}};
}
