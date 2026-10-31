import * as THREE from 'three';
/* Conservative, model-specific hand-versus-torso correction on normalized VRM
 * bones. Call restore() before the animation mixer and apply() afterward. */
export function createBodyAvoidance(vrm) {
  const h=vrm.humanoid, chest=h?.getNormalizedBoneNode('upperChest')||h?.getNormalizedBoneNode('chest');
  if(!chest)return null;
  const arms=['left','right'].map(side=>({side,upper:h.getNormalizedBoneNode(side+'UpperArm'),lower:h.getNormalizedBoneNode(side+'LowerArm'),hand:h.getNormalizedBoneNode(side+'Hand'),rawHand:h.getRawBoneNode(side+'Hand')})).filter(a=>a.upper&&a.lower&&a.hand);
  const original=new Map();let adjusted=0;
  const p0=new THREE.Vector3(),p1=new THREE.Vector3(),p2=new THREE.Vector3(),local=new THREE.Vector3(),target=new THREE.Vector3();
  const worldQ=new THREE.Quaternion(),parentQ=new THREE.Quaternion(),deltaQ=new THREE.Quaternion(),localQ=new THREE.Quaternion();
  const hip=h.getNormalizedBoneNode('hips');const scale=Math.max(.6,Math.min(1.5,Math.abs(hip?.position.y||1)));
  function update(node){node.updateWorldMatrix(true,false)}
  function save(a){for(const bone of [a.upper,a.lower,a.hand])if(!original.has(bone))original.set(bone,bone.quaternion.clone())}
  function aim(joint,hand,goal,strength){
    update(joint);update(hand);joint.getWorldPosition(p0);hand.getWorldPosition(p1);
    p1.sub(p0);p2.copy(goal).sub(p0);if(p1.lengthSq()<1e-7||p2.lengthSq()<1e-7)return;
    deltaQ.setFromUnitVectors(p1.normalize(),p2.normalize());deltaQ.slerp(new THREE.Quaternion(),1-strength);
    if(joint.parent){joint.parent.getWorldQuaternion(parentQ);localQ.copy(parentQ).invert().multiply(deltaQ).multiply(parentQ)}else localQ.copy(deltaQ);
    joint.quaternion.premultiply(localQ).normalize();update(joint);
  }
  return {
    restore(){for(const [bone,q] of original)bone.quaternion.copy(q);original.clear()},
    apply(){adjusted=0;update(chest);
      for(const a of arms){
        // A lowered hand may enter the hip even when its rest pose is clear.
        // Work in hip coordinates so bending or turning the torso follows it.
        if(hip){
          update(hip);update(a.hand);a.hand.getWorldPosition(local);hip.worldToLocal(local);
          const sign=a.side==='left'?1:-1, x=sign*local.x/scale,y=local.y/scale,z=local.z/scale;
          const height=THREE.MathUtils.smoothstep(y,-.30,-.22)*(1-THREE.MathUtils.smoothstep(y,.02,.08));
          const depth=THREE.MathUtils.smoothstep(z,-.19,-.12)*(1-THREE.MathUtils.smoothstep(z,.15,.22));
          const sameSide=THREE.MathUtils.smoothstep(x,.03,.10);
          const strength=height*depth*sameSide, minSide=.255*scale;
          if(strength>.01&&sign*local.x<minSide){
            target.copy(local);target.x+=sign*(minSide-sign*local.x)*strength;hip.localToWorld(target);
            save(a);update(a.hand);a.hand.getWorldQuaternion(worldQ);
            for(let i=0;i<4;i++){aim(a.lower,a.hand,target,.8);aim(a.upper,a.hand,target,.8)}
            if(a.hand.parent){a.hand.parent.getWorldQuaternion(parentQ);a.hand.quaternion.copy(parentQ.invert().multiply(worldQ))}
            adjusted++;
          }
        }
        update(a.hand);a.hand.getWorldPosition(local);chest.worldToLocal(local);
        // Positive z is the front. Keep hands behind the body untouched.
        const x=Math.abs(local.x/scale),y=local.y/scale,z=local.z/scale;
        const sideFade=1-THREE.MathUtils.smoothstep(x,.16,.23);
        const bottomFade=THREE.MathUtils.smoothstep(y,-.26,-.20);
        const topFade=1-THREE.MathUtils.smoothstep(y,.08,.14);
        const frontFade=THREE.MathUtils.smoothstep(z,-.05,.03);
        const strength=sideFade*bottomFade*topFade*frontFade;
        const minFront=.27*scale;
        if(strength<.01||local.z>=minFront)continue;
        // Stay near the authored x/y and move the wrist toward the front.
        target.copy(local);target.z+=(minFront-local.z)*strength;chest.localToWorld(target);
        save(a);
        update(a.hand);a.hand.getWorldQuaternion(worldQ);
        for(let i=0;i<4;i++){aim(a.lower,a.hand,target,.8);aim(a.upper,a.hand,target,.8)}
        if(a.hand.parent){a.hand.parent.getWorldQuaternion(parentQ);a.hand.quaternion.copy(parentQ.invert().multiply(worldQ))}
        // The wrist can be outside the torso while the palm/fingertips still
        // point into it. Use the original rig's hand-end bone, when present,
        // to turn the hand toward the torso surface rather than through it.
        h.update();
        const tip=a.rawHand?.children.find(n=>/Hand_end/i.test(n.name));
        if(tip){
          update(a.rawHand);update(tip);
          const wrist=a.rawHand.getWorldPosition(new THREE.Vector3());
          const tipWorld=tip.getWorldPosition(new THREE.Vector3());
          const tipLocal=chest.worldToLocal(tipWorld.clone());
          if(tipLocal.z<.23*scale){
            tipLocal.z=.23*scale;
            const desired=chest.localToWorld(tipLocal);
            const from=tipWorld.sub(wrist).normalize(),to=desired.sub(wrist).normalize();
            deltaQ.setFromUnitVectors(from,to);
            if(a.hand.parent){a.hand.parent.getWorldQuaternion(parentQ);localQ.copy(parentQ).invert().multiply(deltaQ).multiply(parentQ)}else localQ.copy(deltaQ);
            a.hand.quaternion.premultiply(localQ).normalize();
          }
        }
        adjusted++;
      }return adjusted;
    }
  };
}
