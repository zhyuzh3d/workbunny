import { ShaderChunk } from 'three';

// Evaluate the continuous outline of an elliptical area light with LTC shading.
// This replacement is applied only to the approved bunny materials, not globally.
const source = ShaderChunk.lights_physical_pars_fragment;
const start = source.indexOf('vec3 LTC_Evaluate(');
const end = source.indexOf('\n}', start) + 2;
if (start < 0 || end < 2) throw Error('Unsupported area-light shader');
const ellipse = `vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
  vec3 v1=rectCoords[1]-rectCoords[0],v2=rectCoords[3]-rectCoords[0];
  if(dot(cross(v1,v2),P-rectCoords[0])<0.0)return vec3(0.0);
  vec3 T1=normalize(V-N*dot(V,N)),T2=-cross(N,T1);
  mat3 mat=mInv*transposeMat3(mat3(T1,T2,N));
  vec3 center=(rectCoords[0]+rectCoords[2])*.5;
  vec3 halfWidth=(rectCoords[0]-rectCoords[1])*.5;
  vec3 halfHeight=(rectCoords[3]-rectCoords[0])*.5;
  vec3 previous=normalize(mat*(center+halfWidth-P)),sum=vec3(0.0);
  for(int i=1;i<=48;i++){
    float angle=6.28318530718*float(i)/48.0;
    vec3 point=center+halfWidth*cos(angle)-halfHeight*sin(angle);
    vec3 current=normalize(mat*(point-P));
    sum+=LTC_EdgeVectorFormFactor(previous,current);previous=current;
  }
  return vec3(LTC_ClippedSphereFormFactor(sum));
}`;
const ovalChunk = source.slice(0,start) + ellipse + source.slice(end);

export function installOvalAreaLighting(material) {
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', ovalChunk);
  };
  material.customProgramCacheKey = () => `${previousKey()}|bunny-oval-light-v1`;
  material.needsUpdate = true;
}
