import * as THREE from 'three';

function reference(get) {
  const hand=get('Hand'),middle=get('MiddleProximal'),base=get('ThumbMetacarpal'),next=get('ThumbProximal');
  if (!hand||!middle||!base||!next) return null;
  hand.updateWorldMatrix(true,true);
  const p=node=>node.getWorldPosition(new THREE.Vector3());
  const forward=p(middle).sub(p(hand)).normalize(),direction=p(next).sub(p(base)).normalize();
  const inverse=base.getWorldQuaternion(new THREE.Quaternion()).invert();
  return {angle:direction.angleTo(forward),direction:direction.applyQuaternion(inverse).toArray(),forward:forward.applyQuaternion(inverse).toArray()};
}

export function captureThumbReference(vrm) {
  return Object.fromEntries(['left','right'].map(side=>[side,reference(part=>vrm.humanoid.getNormalizedBoneNode(side+part))]));
}

export async function sourceThumbReference(gltf) {
  const bones=gltf.parser.json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones||{},nodes=new Map();
  for(const side of ['left','right'])for(const part of ['Hand','MiddleProximal','ThumbMetacarpal','ThumbProximal']){
    const def=bones[side+part];if(def)nodes.set(side+part,await gltf.parser.getDependency('node',def.node));
  }
  gltf.scene.updateMatrixWorld(true);
  return Object.fromEntries(['left','right'].map(side=>[side,reference(part=>nodes.get(side+part))]));
}

/** Compensate only a demonstrated source/model bind-pose spread difference.
 * The animation's original thumb rotations and their timing remain intact. */
export function thumbPolicy(modelReference, sourceReference, label='') {
  if(/thumb|点赞|竖.*拇指|👍/i.test(label))return [];
  const result=[];
  for(const side of ['left','right']){
    const model=modelReference?.[side],source=sourceReference?.[side];if(!model||!source)continue;
    const difference=model.angle-source.angle;
    if(source.angle<THREE.MathUtils.degToRad(10)||source.angle>THREE.MathUtils.degToRad(65)||difference<THREE.MathUtils.degToRad(6)||difference>THREE.MathUtils.degToRad(35))continue;
    const direction=new THREE.Vector3().fromArray(model.direction),forward=new THREE.Vector3().fromArray(model.forward);
    const rotation=new THREE.Quaternion().setFromUnitVectors(direction,forward).slerp(new THREE.Quaternion(),1-difference/model.angle);
    result.push({side,quaternion:rotation.toArray(),modelAngle:THREE.MathUtils.radToDeg(model.angle),sourceAngle:THREE.MathUtils.radToDeg(source.angle)});
  }
  return result;
}

export function applyThumbAdaptation(vrm, policy) {
  const saved=[];
  for(const item of policy||[]){const node=vrm.humanoid.getNormalizedBoneNode(item.side+'ThumbMetacarpal');if(!node)continue;saved.push({node,quaternion:node.quaternion.clone()});node.quaternion.multiply(new THREE.Quaternion().fromArray(item.quaternion)).normalize();}
  return saved;
}

export function restoreThumbs(saved) {for(const item of saved||[])item.node.quaternion.copy(item.quaternion);}

// Bake the calibrated bind-pose offset into each clip so normal crossfades
// interpolate it with the animation and never modify the VRMA source data.
export function bakeThumbPolicy(clip, vrm, policy) {
  for (const item of policy || []) {
    const node = vrm.humanoid.getNormalizedBoneNode(item.side + 'ThumbMetacarpal');
    if (!node) continue;
    const name = node.name + '.quaternion';
    let track = clip.tracks.find(t => t.name === name);
    if (!track) { track = new THREE.QuaternionKeyframeTrack(name, [0, clip.duration], [0,0,0,1,0,0,0,1]); clip.tracks.push(track); }
    const offset = new THREE.Quaternion().fromArray(item.quaternion), q = new THREE.Quaternion();
    for (let i = 0; i < track.values.length; i += 4) q.fromArray(track.values, i).multiply(offset).normalize().toArray(track.values, i);
  }
  return clip;
}
