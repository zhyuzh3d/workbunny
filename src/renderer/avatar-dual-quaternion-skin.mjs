// Trusted host shader: volume-preserving dual-quaternion skin blending.
export function installDualQuaternionSkin(material){
 const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey();
 material.onBeforeCompile=(shader,renderer)=>{
  previous.call(material,shader,renderer);
  for (const part of ['skinning_pars_vertex','skinbase_vertex','skinnormal_vertex','skinning_vertex']) {
   if (!shader.vertexShader.includes(`#include <${part}>`)) throw new Error('Unsupported skin shader');
  }
  shader.vertexShader=shader.vertexShader.replace('#include <skinning_pars_vertex>',`#include <skinning_pars_vertex>
#ifdef USE_SKINNING
vec4 wbSkinQuat(mat4 m) {
 float t=m[0][0]+m[1][1]+m[2][2]; vec4 q;
 if(t>0.0){float s=sqrt(t+1.0)*2.0;q=vec4((m[1][2]-m[2][1])/s,(m[2][0]-m[0][2])/s,(m[0][1]-m[1][0])/s,.25*s);}
 else if(m[0][0]>m[1][1]&&m[0][0]>m[2][2]){float s=sqrt(1.0+m[0][0]-m[1][1]-m[2][2])*2.0;q=vec4(.25*s,(m[1][0]+m[0][1])/s,(m[2][0]+m[0][2])/s,(m[1][2]-m[2][1])/s);}
 else if(m[1][1]>m[2][2]){float s=sqrt(1.0+m[1][1]-m[0][0]-m[2][2])*2.0;q=vec4((m[1][0]+m[0][1])/s,.25*s,(m[2][1]+m[1][2])/s,(m[2][0]-m[0][2])/s);}
 else{float s=sqrt(1.0+m[2][2]-m[0][0]-m[1][1])*2.0;q=vec4((m[2][0]+m[0][2])/s,(m[2][1]+m[1][2])/s,.25*s,(m[0][1]-m[1][0])/s);}
 return normalize(q);
}
vec4 wbSkinMul(vec4 a,vec4 b){return vec4(a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),a.w*b.w-dot(a.xyz,b.xyz));}
vec3 wbSkinRotate(vec4 q,vec3 v){return v+2.0*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
#endif`);
  shader.vertexShader=shader.vertexShader.replace('#include <skinbase_vertex>',`#include <skinbase_vertex>
#ifdef USE_SKINNING
 mat4 bm0=bindMatrixInverse*boneMatX*bindMatrix, bm1=bindMatrixInverse*boneMatY*bindMatrix, bm2=bindMatrixInverse*boneMatZ*bindMatrix, bm3=bindMatrixInverse*boneMatW*bindMatrix;
 vec4 q0=wbSkinQuat(bm0),q1=wbSkinQuat(bm1),q2=wbSkinQuat(bm2),q3=wbSkinQuat(bm3);
 vec4 refq=skinWeight.x>0.00001?q0:(skinWeight.y>0.00001?q1:(skinWeight.z>0.00001?q2:q3));
 float s0=dot(refq,q0)<0.0?-1.0:1.0,s1=dot(refq,q1)<0.0?-1.0:1.0,s2=dot(refq,q2)<0.0?-1.0:1.0,s3=dot(refq,q3)<0.0?-1.0:1.0;
 vec4 bq=q0*(skinWeight.x*s0)+q1*(skinWeight.y*s1)+q2*(skinWeight.z*s2)+q3*(skinWeight.w*s3);
 vec4 bd=.5*(wbSkinMul(vec4(bm0[3].xyz,0.0),q0)*(skinWeight.x*s0)+wbSkinMul(vec4(bm1[3].xyz,0.0),q1)*(skinWeight.y*s1)+wbSkinMul(vec4(bm2[3].xyz,0.0),q2)*(skinWeight.z*s2)+wbSkinMul(vec4(bm3[3].xyz,0.0),q3)*(skinWeight.w*s3));
 float bl=max(length(bq),0.00001);bq/=bl;bd/=bl;bd-=bq*dot(bq,bd);
 vec3 bt=2.0*wbSkinMul(bd,vec4(-bq.xyz,bq.w)).xyz;
#endif`);
  shader.vertexShader=shader.vertexShader.replace('#include <skinnormal_vertex>',`#ifdef USE_SKINNING
 objectNormal=wbSkinRotate(bq,objectNormal);
 #ifdef USE_TANGENT
 objectTangent=wbSkinRotate(bq,objectTangent);
 #endif
#endif`);
  shader.vertexShader=shader.vertexShader.replace('#include <skinning_vertex>',`#ifdef USE_SKINNING
 transformed=wbSkinRotate(bq,transformed)+bt;
#endif`);
 };
 material.customProgramCacheKey=()=> previousKey+'|workbunny-dq-skin-v1';material.needsUpdate=true;
}
