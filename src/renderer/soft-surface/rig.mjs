/* Two three-segment, four-bone ear rigs: one skinned head, driven by world-space springs. */
import * as T from 'three';
import { installDualQuaternionSkin } from '../avatar-dual-quaternion-skin.mjs';
// Blend rigid bone transforms as dual quaternions. Unlike linear matrix
// blending, this keeps the cross-section full when an ear bends toward the face.
class SoftAppendageRig {
 constructor(group,geometry,rest,material){
  this.group=group;this.geometry=geometry;this.rest=rest;this.segments=3;this.ready=false;
  installDualQuaternionSkin(material);
  this.mesh=new T.SkinnedMesh(geometry,material);this.mesh.frustumCulled=false;group.add(this.mesh);
  this.root=new T.Bone();this.root.name='head';this.mesh.add(this.root);
  const bones=[this.root];this.boneChains=[];
  this.chains=[-1,1].map((side,sideIndex)=>{
   const chain=[],boneChain=[];
   for(let i=0;i<=this.segments;i++){
    const u=i/this.segments,y=.55+1.68*u;
    const restPoint=new T.Vector3(side*(.47+.115*(y-.78)),y,-.02);
    const parent=i?boneChain[i-1]:this.root,bone=new T.Bone();
    bone.name=(sideIndex?'right':'left')+'_ear_'+i;
    bone.position.copy(restPoint);if(i)bone.position.sub(chain[i-1].rest);
    parent.add(bone);bones.push(bone);boneChain.push(bone);
    chain.push({rest:restPoint,anchor:new T.Vector3(),previousAnchor:new T.Vector3(),subAnchor:new T.Vector3(),p:new T.Vector3(),v:new T.Vector3(),d:new T.Vector3()});
   }
   this.boneChains.push(boneChain);return chain;
  });
  // Two internal lower-body bones gently squash the base in alternating steps.
  // They are inside the same continuous head; no visible legs are added.
  this.feet=[];
  for(const side of [-1,1]){
   const foot=new T.Bone();foot.name=side<0?'left_step':'right_step';foot.position.set(side*.52,-.62,0);
   this.root.add(foot);bones.push(foot);this.feet.push(foot);
  }
  const leftBase=1,rightBase=1+(this.segments+1),footBase=1+2*(this.segments+1);
  const count=rest.length/3,indices=new Uint16Array(count*4),weights=new Float32Array(count*4);
  for(let i=0;i<count;i++){
   const x=rest[3*i],y=rest[3*i+1],u=Math.max(0,Math.min(1,(y-.55)/1.68));
   const v=u*this.segments,blend=Math.max(0,Math.min(1,(x+.20)/.40)),k=i*4;
   if(y<-.30){
    const u=Math.max(0,Math.min(1,(-y-.30)/.60)),w=.72*u*u*(3-2*u);
    const side=Math.max(0,Math.min(1,(x+.30)/.60));
    indices[k]=0;weights[k]=1-w;indices[k+1]=footBase;weights[k+1]=w*(1-side);indices[k+2]=footBase+1;weights[k+2]=w*side;
   } else if(v<1){
    const rise=Math.max(0,Math.min(1,(y-.42)/1.13)),separate=Math.max(0,Math.min(1,(y-.90)/.21)),lateralHead=Math.max(0,Math.min(1,Math.abs(x)/.30));
    const centerRelease=(1-separate*separate*(3-2*separate))*(1-lateralHead*lateralHead*(3-2*lateralHead));
    const w=rise*rise*(3-2*rise)*(1-.65*centerRelease),side=x<0?leftBase:rightBase,other=x<0?rightBase:leftBase;
    const dominant=Math.max(blend,1-blend),otherSide=Math.min(blend,1-blend);
    const lateral=Math.max(0,Math.min(1,Math.abs(x)/.20)),rootShare=(1-v)*lateral*lateral*(3-2*lateral);
    indices[k]=0;weights[k]=1-w;indices[k+1]=side;weights[k+1]=w*dominant*rootShare;
    indices[k+2]=side+1;weights[k+2]=w*dominant*(1-rootShare);indices[k+3]=other+1;weights[k+3]=w*otherSide;
   } else {
    const j=Math.min(this.segments-1,Math.floor(v)),f=v-j,along=f*f*(3-2*f);
    const rise=Math.max(0,Math.min(1,(y-.42)/1.13)),weight=rise*rise*(3-2*rise),side=x<0?leftBase:rightBase;
    if(y<1.55){indices[k]=0;weights[k]=1-weight;indices[k+1]=side+j;weights[k+1]=weight*(1-along);indices[k+2]=side+j+1;weights[k+2]=weight*along}
    else {
     // A cubic B-spline across the four ear bones removes the visible change
     // in curvature at each joint while the root remains attached to the head.
     const smooth=Math.max(0,Math.min(1,(y-1.55)/.35)),mix=smooth*smooth*(3-2*smooth),p=f*f*f;
     const base=[0,0,0,0],spline=[0,0,0,0];base[j]+=1-along;base[j+1]+=along;
     const bs=[(1-f)**3/6,(3*p-6*f*f+4)/6,(-3*p+3*f*f+3*f+1)/6,p/6];
     for(let n=0;n<4;n++)spline[Math.max(0,Math.min(3,j+n-1))]+=bs[n];
     for(let n=0;n<4;n++){indices[k+n]=side+n;weights[k+n]=base[n]*(1-mix)+spline[n]*mix}
    }
   }
  }
  geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute(indices,4));
  geometry.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
  this.mesh.updateMatrixWorld(true);this.mesh.bind(new T.Skeleton(bones));
  // Match the shader on the CPU for raycasting, collision sampling and review.
  this.dualBones=bones.map(()=>({q:new T.Quaternion(),d:[0,0,0,0]}));
  this.skinMatrix=new T.Matrix4();this.skinQuaternion=new T.Quaternion();
  this.mesh.getVertexPosition=(index,target)=>this.getSkinnedVertex(index,target);
  this.updateDualBones();
  this.tmp=new T.Vector3();this.target=new T.Vector3();this.gesture=new T.Vector3();
  this.restDir=new T.Vector3();this.newDir=new T.Vector3();this.worldPoint=new T.Vector3();
  this.curveNext=new T.Vector3();this.curveSide=new T.Vector3();
  this.oldPosition=new T.Vector3();this.parentDirection=new T.Vector3();this.restDirection=new T.Vector3();
  this.ikChains=Array.from({length:2},()=>Array.from({length:this.segments+1},()=>new T.Vector3()));
  this.ikTarget=new T.Vector3();this.ikRoot=new T.Vector3();this.ikWork=new T.Vector3();this.ikPrev=new T.Vector3();
  this.ikSource=Array.from({length:this.segments},()=>new T.Vector3());this.ikAxis=new T.Vector3();this.ikTangent=new T.Vector3();this.ikDesired=new T.Vector3();this.ikParent=new T.Vector3();
  // Frequency and damping ratio fall from the firm root toward the softer tip.
  this.jointTuning=[null,{hz:5.5,damping:.88,maxAngle:.22,drive:.18},{hz:3.1,damping:.55,maxAngle:.50,drive:.48},{hz:1.9,damping:.40,maxAngle:.70,drive:.82}];
  this.groupQ=new T.Quaternion();this.parentQ=new T.Quaternion();this.worldQ=new T.Quaternion();this.earTwist=new T.Quaternion();
  // Draw the actual bone origins and links as an x-ray overlay so the rig can
  // be inspected through the single opaque skinned surface.
  this.debugRoot=new T.Group();this.debugRoot.name='ear-rig-visualization';group.add(this.debugRoot);
  this.debug=[];this.debugUp=new T.Vector3(0,1,0);this.debugVector=new T.Vector3();
  const jointGeometry=new T.SphereGeometry(.035,16,12),linkGeometry=new T.CylinderGeometry(.012,.012,1,10);
  for(let side=0;side<2;side++){
   const material=new T.MeshBasicMaterial({color:side===0?0x00e1dd:0xffd240,depthTest:false,depthWrite:false,toneMapped:false});
   const joints=[],links=[];
   for(let j=0;j<=this.segments;j++){
    const joint=new T.Mesh(jointGeometry,material);joint.renderOrder=1001;this.debugRoot.add(joint);joints.push(joint);
   }
   // The first link connects the actual head root to the first ear bone.
   for(let j=0;j<=this.segments;j++){
    const link=new T.Mesh(linkGeometry,material);link.renderOrder=1000;this.debugRoot.add(link);links.push(link);
   }
   this.debug.push({joints,links});
  }
  this.stepDebug=[];
  for(let i=0;i<2;i++){
   const material=new T.MeshBasicMaterial({color:i===0?0xff88a8:0xa1f17c,depthTest:false,depthWrite:false,toneMapped:false});
   const joint=new T.Mesh(jointGeometry,material),link=new T.Mesh(linkGeometry,material);
   joint.renderOrder=1001;link.renderOrder=1000;this.debugRoot.add(link,joint);this.stepDebug.push({joint,link});
  }
  this.headMarker=new T.Mesh(new T.SphereGeometry(.044,16,12),new T.MeshBasicMaterial({color:0xffffff,depthTest:false,depthWrite:false,toneMapped:false}));
  this.headMarker.renderOrder=1002;this.debugRoot.add(this.headMarker);this.debugRoot.visible=true;
 }
 updateDualBones(){
  const skeleton=this.mesh.skeleton,m=this.skinMatrix,bind=this.mesh.bindMatrix,inv=this.mesh.bindMatrixInverse;
  for(let i=0;i<skeleton.bones.length;i++){
   m.multiplyMatrices(skeleton.bones[i].matrixWorld,skeleton.boneInverses[i]).premultiply(inv).multiply(bind);
   const b=this.dualBones[i],q=b.q.setFromRotationMatrix(m).normalize(),e=m.elements,x=e[12],y=e[13],z=e[14];
   b.d[0]=.5*(x*q.w+y*q.z-z*q.y);b.d[1]=.5*(-x*q.z+y*q.w+z*q.x);
   b.d[2]=.5*(x*q.y-y*q.x+z*q.w);b.d[3]=-.5*(x*q.x+y*q.y+z*q.z);
  }
 }
 getSkinnedVertex(index,target){
  const ii=this.geometry.attributes.skinIndex.array,ww=this.geometry.attributes.skinWeight.array,k=index*4;
  let ref=null,x=0,y=0,z=0,w=0,dx=0,dy=0,dz=0,dw=0;
  for(let n=0;n<4;n++){
   const weight=ww[k+n];if(weight<=1e-8)continue;
   const bone=this.dualBones[ii[k+n]],q=bone.q;if(!ref)ref=q;
   const a=weight*(ref.dot(q)<0?-1:1);x+=q.x*a;y+=q.y*a;z+=q.z*a;w+=q.w*a;
   dx+=bone.d[0]*a;dy+=bone.d[1]*a;dz+=bone.d[2]*a;dw+=bone.d[3]*a;
  }
  const inv=1/(Math.hypot(x,y,z,w)||1);x*=inv;y*=inv;z*=inv;w*=inv;dx*=inv;dy*=inv;dz*=inv;dw*=inv;
  const dot=x*dx+y*dy+z*dz+w*dw;dx-=x*dot;dy-=y*dot;dz-=z*dot;dw-=w*dot;
  const tx=2*(-dw*x+dx*w-dy*z+dz*y),ty=2*(-dw*y+dx*z+dy*w-dz*x),tz=2*(-dw*z-dx*y+dy*x+dz*w);
  this.skinQuaternion.set(x,y,z,w);const a=this.rest,j=index*3;
  return target.set(a[j],a[j+1],a[j+2]).applyQuaternion(this.skinQuaternion).add(this.tmp.set(tx,ty,tz));
 }
 setDebug(visible){this.debugRoot.visible=visible}
 poseSteps(step){
  const amount=Math.max(-1,Math.min(1,step||0));
  for(let i=0;i<2;i++){
   const side=i===0?-1:1,foot=this.feet[i],phase=amount*side;
   foot.position.set(side*.52+phase*.035,-.62+phase*.085,phase*.10);
   foot.rotation.set(phase*.10,0,-phase*.14);
  }
 }
 kick(side,amount=1){
  if(!this.ready)return;
  for(let s=0;s<2;s++)if(side===0||side===(s===0?-1:1))for(let j=1;j<=this.segments;j++){
   const strength=j/this.segments,n=this.chains[s][j];n.v.x+=(s===0?-1:1)*amount*strength*2.2;n.v.z+=amount*strength*.9;
  }
 }
 step(dt,leftGesture,rightGesture,frozen=0){
  const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps;
  this.group.updateWorldMatrix(true,true);this.group.getWorldQuaternion(this.groupQ);
  for(const chain of this.chains)for(const n of chain){
   n.previousAnchor.copy(n.anchor);n.anchor.copy(n.rest);this.group.localToWorld(n.anchor);
   if(!this.ready){n.previousAnchor.copy(n.anchor);n.p.copy(n.anchor);n.v.set(0,0,0)}
  }
  this.ready=true;
  for(let step=0;step<steps;step++)for(let side=0;side<2;side++){
   const chain=this.chains[side],input=side===0?leftGesture:rightGesture;
   const gestureX=typeof input==='number'?input:(input?.x||0),gestureZ=typeof input==='number'?0:(input?.z||0);
   const fraction=(step+1)/steps;
   for(const n of chain)n.subAnchor.lerpVectors(n.previousAnchor,n.anchor,fraction);
   chain[0].p.copy(chain[0].subAnchor);chain[0].v.set(0,0,0);
   for(let j=1;j<=this.segments;j++){
    const node=chain[j],parent=chain[j-1],tuning=this.jointTuning[j];
    const length=node.subAnchor.distanceTo(parent.subAnchor);
    this.restDirection.copy(node.subAnchor).sub(parent.subAnchor).normalize();
    if(j===1)this.parentDirection.copy(this.restDirection);
    else this.parentDirection.copy(parent.p).sub(chain[j-2].p).normalize();
    // Each joint seeks its parent's direction with a smaller rest-orientation pull.
    // This propagates delayed curvature from root to tip instead of pinning the tip.
    const inherit=j===1?0:j===2?.48:.65;
    this.target.copy(this.restDirection).multiplyScalar(1-inherit).addScaledVector(this.parentDirection,inherit);
    this.gesture.set(gestureX*tuning.drive,0,gestureZ*tuning.drive).applyQuaternion(this.groupQ);
    this.target.add(this.gesture).normalize().multiplyScalar(length).add(parent.p);
    const omega=2*Math.PI*tuning.hz;
    this.oldPosition.copy(node.p);
    node.v.add(this.tmp.copy(this.target).sub(node.p).multiplyScalar(omega*omega*h));
    node.v.multiplyScalar(Math.exp(-2*tuning.damping*omega*h));
    node.p.addScaledVector(node.v,h);
    // Project the simulated tail back onto its bone-length sphere and limit
    // adjacent joint angles to avoid visible pinches in the skinned surface.
    this.curveNext.copy(node.p).sub(parent.p);
    if(this.curveNext.lengthSq()<1e-12)this.curveNext.copy(this.restDirection);
    this.curveNext.normalize();
    const reference=j===1?this.restDirection:this.parentDirection;
    const dot=Math.max(-1,Math.min(1,reference.dot(this.curveNext))),cosLimit=Math.cos(tuning.maxAngle);
    if(dot<cosLimit){
     this.curveSide.copy(this.curveNext).addScaledVector(reference,-dot);
     if(this.curveSide.lengthSq()>1e-10)this.curveNext.copy(this.curveSide.normalize().multiplyScalar(Math.sin(tuning.maxAngle))).addScaledVector(reference,cosLimit);
     else this.curveNext.copy(reference);
    }
    node.p.copy(parent.p).addScaledVector(this.curveNext,length);
    // Constraint correction is included in velocity, so the next step starts
    // from the visible constrained state instead of a hidden unconstrained one.
    node.v.copy(node.p).sub(this.oldPosition).multiplyScalar(1/h);
   }
  }
  // A deliberate hand-like gesture can temporarily steer either ear in front
  // of the face. FABRIK preserves the same three segment lengths; the solved
  // positions are fed back into the spring state, so release remains continuous.
  const inputs=[leftGesture,rightGesture];
  for(let side=0;side<2;side++){
   const input=typeof inputs[side]==='number'?{}:(inputs[side]||{});
   const cover=Math.max(0,input.cover||0),clap=Math.max(0,input.clap||0),heart=Math.max(0,input.heart||0),sum=cover+clap+heart;
   const weight=Math.max(0,Math.min(1,sum));if(weight<.001)continue;
   const chain=this.chains[side],q=this.ikChains[side],sign=side===0?-1:1,inv=1/sum;
   const c=cover*inv,a=clap*inv,h=heart*inv;
   this.ikRoot.copy(chain[0].rest);
   this.ikTarget.set(sign*(.38*c+.28*a+.08*h),-.26*c+2.12*a+1.70*h,1.10*c+.20*a+.22*h);
   q[0].copy(this.ikRoot);
   q[1].copy(this.ikRoot).add(this.ikWork.set(sign*(-.04*a+.18*h),.10*c+.55*a+.50*h,.52*c+.07*a+.08*h));
   q[2].copy(this.ikRoot).add(this.ikWork.set(-sign*.04*c-sign*.12*a+sign*.15*h,-.17*c+1.10*a+1.00*h,.98*c+.14*a+.15*h));
   q[3].copy(this.ikTarget);
   for(let iteration=0;iteration<16;iteration++){
    q[this.segments].copy(this.ikTarget);
    for(let j=this.segments-1;j>=0;j--){const length=chain[j+1].rest.distanceTo(chain[j].rest);this.ikWork.copy(q[j]).sub(q[j+1]).normalize();q[j].copy(q[j+1]).addScaledVector(this.ikWork,length)}
    q[0].copy(this.ikRoot);
    for(let j=1;j<=this.segments;j++){const length=chain[j].rest.distanceTo(chain[j-1].rest);this.ikWork.copy(q[j]).sub(q[j-1]).normalize();q[j].copy(q[j-1]).addScaledVector(this.ikWork,length)}
   }
   // Blend segment directions on the sphere, instead of blending absolute
   // joint positions. That avoids a sudden intermediate fold or axial flip.
   for(let j=1;j<=this.segments;j++){
    this.ikSource[j-1].copy(chain[j].p);this.group.worldToLocal(this.ikSource[j-1]);
    this.ikParent.copy(chain[j-1].p);this.group.worldToLocal(this.ikParent);this.ikSource[j-1].sub(this.ikParent).normalize();
    this.ikDesired.copy(chain[j].rest).sub(chain[j-1].rest).normalize();
    this.ikSource[j-1].lerp(this.ikDesired,Math.min(1,weight*5)).normalize();
   }
   this.ikPrev.copy(this.ikRoot);
   for(let j=1;j<=this.segments;j++){
    const n=chain[j],length=n.rest.distanceTo(chain[j-1].rest),source=this.ikSource[j-1];
    this.ikDesired.copy(q[j]).sub(q[j-1]).normalize();
    const dot=Math.max(-1,Math.min(1,source.dot(this.ikDesired))),angle=Math.acos(dot);
    this.ikAxis.crossVectors(source,this.ikDesired);
    if(this.ikAxis.lengthSq()<1e-10){this.ikAxis.set(1,0,0);if(Math.abs(source.x)>.9)this.ikAxis.set(0,0,1);this.ikAxis.addScaledVector(source,-this.ikAxis.dot(source))}
    this.ikAxis.normalize();this.ikTangent.crossVectors(this.ikAxis,source);
    this.ikWork.copy(source).multiplyScalar(Math.cos(angle*weight)).addScaledVector(this.ikTangent,Math.sin(angle*weight));
    this.ikWork.multiplyScalar(length).add(this.ikPrev);this.ikPrev.copy(this.ikWork);
    this.group.localToWorld(this.ikWork);n.p.copy(this.ikWork);n.v.multiplyScalar(1-.65*weight);
   }
  }
  // Ice locks the ear rig to the head instead of allowing its spring tips
  // to swing through the block during a fall.
  const freeze=Math.max(0,Math.min(1,frozen));
  if(freeze>0)for(const chain of this.chains)for(let j=1;j<=this.segments;j++){
   const n=chain[j],parent=chain[j-1],length=n.anchor.distanceTo(parent.anchor);
   n.p.lerp(n.anchor,freeze);this.ikWork.copy(n.p).sub(parent.p);
   if(this.ikWork.lengthSq()>1e-10)n.p.copy(parent.p).addScaledVector(this.ikWork.normalize(),length);
   n.v.multiplyScalar(1-freeze);
  }
  for(const chain of this.chains)for(const n of chain){
   n.d.copy(n.p);this.group.worldToLocal(n.d);n.d.sub(n.rest);
  }
  for(let side=0;side<2;side++){
   const chain=this.chains[side],bones=this.boneChains[side];
   for(let j=0;j<=this.segments;j++){
    const node=chain[j],bone=bones[j],parent=bone.parent;
    this.worldPoint.copy(node.rest).add(node.d);
    this.group.localToWorld(this.worldPoint);parent.worldToLocal(this.worldPoint);bone.position.copy(this.worldPoint);
    // Aim each bone along the deformed centerline, retaining continuous skin rotation.
    const a=Math.max(0,j-1),b=Math.min(this.segments,j+1);
    this.restDir.copy(chain[b].rest).sub(chain[a].rest).normalize();
    this.newDir.copy(chain[b].rest).add(chain[b].d).sub(chain[a].rest).sub(chain[a].d).normalize();
    this.worldQ.setFromUnitVectors(this.restDir,this.newDir).premultiply(this.groupQ);
    // On a clap each coloured inner surface turns toward its partner. The
    // twist increases gradually from the firm root to the soft ear tip.
    const clapInput=typeof inputs[side]==='number'?0:Math.max(0,Math.min(1,Math.max(inputs[side]?.turn||0,inputs[side]?.clap||0)));
    const twist=(side===0?1:-1)*clapInput*Math.PI*.5*[.16,.52,.86,1][j];
    this.earTwist.setFromAxisAngle(this.restDir,twist);this.worldQ.multiply(this.earTwist);
    parent.getWorldQuaternion(this.parentQ);bone.quaternion.copy(this.parentQ.invert()).multiply(this.worldQ);
    bone.updateWorldMatrix(false,true);
   }
  }
  this.mesh.updateMatrixWorld(true);this.mesh.skeleton.update();this.updateDualBones();
  if(this.debugRoot.visible){
   this.root.getWorldPosition(this.worldPoint);this.group.worldToLocal(this.worldPoint);this.headMarker.position.copy(this.worldPoint);
   for(let i=0;i<2;i++){
    const {joint,link}=this.stepDebug[i];this.feet[i].getWorldPosition(this.worldPoint);this.group.worldToLocal(this.worldPoint);joint.position.copy(this.worldPoint);
    this.debugVector.copy(joint.position).sub(this.headMarker.position);const length=this.debugVector.length();
    link.position.copy(this.headMarker.position).add(joint.position).multiplyScalar(.5);link.scale.set(1,length,1);
    if(length>1e-7)link.quaternion.setFromUnitVectors(this.debugUp,this.debugVector.multiplyScalar(1/length));
   }
   for(let side=0;side<2;side++){
    const {joints,links}=this.debug[side],bones=this.boneChains[side];
    for(let j=0;j<=this.segments;j++){
     bones[j].getWorldPosition(this.worldPoint);this.group.worldToLocal(this.worldPoint);joints[j].position.copy(this.worldPoint);
    }
    for(let j=0;j<=this.segments;j++){
     const from=j===0?this.headMarker.position:joints[j-1].position,to=joints[j].position,link=links[j];
     this.debugVector.copy(to).sub(from);const length=this.debugVector.length();
     link.position.copy(from).add(to).multiplyScalar(.5);link.scale.set(1,length,1);
     if(length>1e-7)link.quaternion.setFromUnitVectors(this.debugUp,this.debugVector.multiplyScalar(1/length));
    }
   }
  }
 }
}
export { SoftAppendageRig };
