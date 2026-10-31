/* Props and effects are bound to a performance; ball physics is local and deterministic. */
import * as T from 'three';
// Smooth value noise at several scales gives the particles a shared,
// continuously changing turbulence instead of a repeated sine-wave wiggle.
function fireNoise(x){
 const i=Math.floor(x),f=x-i,u=f*f*(3-2*f);
 const hash=n=>{n=Math.imul(n^(n>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);return ((n^(n>>>16))>>>0)/2147483648-1};
 return hash(i)*(1-u)+hash(i+1)*u;
}
function fireFbm(x){return fireNoise(x)*.57+fireNoise(x*2.03+17)*.29+fireNoise(x*4.07+43)*.14}
function variedParticleSizes(geometry,material,count,seed=1){
 const sizes=new Float32Array(count),alpha=new Float32Array(count);for(let i=0;i<count;i++){sizes[i]=.55+((i*37+seed*19)%101)/100*1.65;alpha[i]=1}
 geometry.setAttribute('particleSize',new T.Float32BufferAttribute(sizes,1));geometry.setAttribute('particleAlpha',new T.Float32BufferAttribute(alpha,1));
 material.onBeforeCompile=shader=>{
  shader.vertexShader='attribute float particleSize; attribute float particleAlpha; varying float vParticleAlpha;\n'+shader.vertexShader.replace('gl_PointSize = size;','vParticleAlpha = particleAlpha; gl_PointSize = size * particleSize;');
  if(shader.fragmentShader)shader.fragmentShader='varying float vParticleAlpha;\n'+shader.fragmentShader.replace('#include <map_particle_fragment>','#include <map_particle_fragment>\n diffuseColor.a *= vParticleAlpha;');
 };
 material.customProgramCacheKey=()=> 'bunny-soft-varied-particles-v2';return material;
}
// Text is drawn as an intentionally legible comic overlay, not an emoji or
// an image of a word. The canvas remains local and needs no network fonts.
function comicWordTexture(label,kind,fallback){
 const canvas=document.createElement('canvas');canvas.width=768;canvas.height=256;const c=canvas.getContext('2d');
 if(!c||typeof c.fillText!=='function')return fallback;
 c.clearRect(0,0,768,256);c.save();c.translate(384,128);c.rotate(kind==='sleep'?.055:-.085);
 c.textAlign='center';c.textBaseline='middle';c.lineJoin='round';c.font=(label.length>5?'italic 900 132px ':'italic 900 164px ')+"'Arial Black',Impact,sans-serif";
 // A second offset copy produces a crisp shadow with no outline or blur.
 c.fillStyle='rgba(46,35,59,.48)';c.fillText(label,8,10,690);
 c.fillStyle='#ffffff';c.fillText(label,0,0,690);c.restore();const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;return texture;
}
// Frost is concentrated at the edges, leaving the character's eyes legible.
function iceTexture(fallback){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const c=canvas.getContext('2d');
 if(!c||typeof c.createLinearGradient!=='function'||typeof c.arc!=='function')return fallback;
 c.fillStyle='#f3fcff';c.fillRect(0,0,512,512);
 for(let edge=0;edge<4;edge++){
  c.save();c.translate(256,256);c.rotate(edge*Math.PI/2);const g=c.createLinearGradient(0,-256,0,-140);
  g.addColorStop(0,'rgba(126,201,224,.84)');g.addColorStop(.42,'rgba(203,239,249,.43)');g.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle=g;c.fillRect(-256,-256,512,116);
  for(let i=0;i<18;i++){const x=-245+i*29+Math.sin(i*21+edge)*10,y=-250+Math.sin(i*7+edge)*5,length=14+(i*17+edge*7)%62;
   c.strokeStyle=i%3?'rgba(255,255,255,.38)':'rgba(255,255,255,.28)';c.lineWidth=i%4===0?2.4:1;c.beginPath();c.moveTo(x,y);c.lineTo(x+Math.sin(i*2.3)*8,y+length);c.stroke();}
  c.restore();
 }
 // Fine branching cracks and trapped bubbles read as ice rather than a glass box.
 for(let i=0;i<13;i++){
  const side=i%2?-1:1,x=256+side*(150+(i*37)%94),y=36+(i*83)%440;
  c.strokeStyle='rgba(255,255,255,.34)';c.lineWidth=1+(i%3)*.5;c.beginPath();c.moveTo(x,y);c.lineTo(x-side*18,y+11);c.lineTo(x-side*32,y+8);c.lineTo(x-side*45,y+25);c.moveTo(x-side*18,y+11);c.lineTo(x-side*24,y+24);c.stroke();
 }
 // Angular faults use translucent white without a coloured outline.
 const cracks=[[[18,72],[71,99],[90,132],[138,145],[155,173]],[[494,54],[448,83],[421,125],[374,137],[359,169]],[[17,355],[61,340],[85,374],[129,382],[146,415]],[[495,372],[450,347],[425,369],[390,374],[361,411]],[[62,15],[83,53],[124,66],[135,94]],[[448,494],[416,458],[382,449],[367,422]]];
 for(const path of cracks){
  for(const [offset,color,width] of [[0,'rgba(255,255,255,.20)',2.5],[0,'rgba(255,255,255,.43)',1.3]]){
   c.strokeStyle=color;c.lineWidth=width;c.beginPath();path.forEach(([x,y],i)=>i?c.lineTo(x+offset,y+offset):c.moveTo(x+offset,y+offset));
   const [x,y]=path[2];c.moveTo(x+offset,y+offset);c.lineTo(x+offset+(x<256?21:-21),y+offset-18);c.stroke();
  }
 }
 for(let i=0;i<34;i++){const x=26+(i*137)%460,y=25+(i*79)%462,r=1+(i*7)%4;c.strokeStyle='rgba(255,255,255,.36)';c.lineWidth=1;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.stroke()}
 const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;return texture;
}
// Transparent, high-contrast fracture layer: the clear centre keeps the
// face readable while the perimeter has broad crystalline facets and cracks.
function iceFractureTexture(){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;const c=canvas.getContext('2d');
 if(!c||typeof c.beginPath!=='function'||typeof c.closePath!=='function')return null;
 c.clearRect(0,0,1024,1024);c.lineJoin='round';c.lineCap='round';
 const facets=[
  {color:'rgba(171,229,248,.42)',p:[[0,0],[370,0],[286,82],[205,124],[146,192],[0,159]]},
  {color:'rgba(238,252,255,.31)',p:[[1024,0],[654,0],[745,76],[817,145],[892,194],[1024,158]]},
  {color:'rgba(132,211,239,.30)',p:[[0,150],[144,194],[187,297],[122,363],[0,329]]},
  {color:'rgba(201,246,255,.30)',p:[[1024,165],[890,194],[843,302],[912,360],[1024,323]]},
  {color:'rgba(217,250,255,.38)',p:[[0,1024],[372,1024],[283,943],[195,904],[136,838],[0,864]]},
  {color:'rgba(142,217,245,.34)',p:[[1024,1024],[648,1024],[745,944],[829,905],[886,838],[1024,868]]}
 ];
 for(const facet of facets){c.beginPath();facet.p.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=facet.color;c.fill()}
 const cracks=[
  [[4,85],[142,132],[208,207],[317,226],[383,301]],
  [[1020,112],[915,137],[856,190],[767,178],[716,257],[653,270]],
  [[1,351],[117,365],[161,438],[260,465],[315,526]],
  [[1023,390],[919,406],[879,467],[795,466],[745,527],[700,542]],
  [[0,877],[134,837],[204,781],[285,791],[330,724]],
  [[1024,900],[925,855],[866,800],[781,816],[734,748],[687,733]],
  [[111,1],[147,77],[213,107],[251,173]],
  [[894,0],[858,67],[787,93],[756,155]],
  [[111,1023],[153,956],[214,930],[255,868]],
  [[934,1023],[883,952],[823,940],[793,879],[757,858]]
 ];
 for(const [pathIndex,path] of cracks.entries()){
  // Layer only semi-transparent white; avoid a coloured outline.
  for(const [color,width] of [['rgba(255,255,255,.14)',15],['rgba(255,255,255,.42)',6],['rgba(255,255,255,.18)',2]]){
   c.strokeStyle=color;c.lineWidth=width;c.beginPath();path.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.stroke();
  }
  for(let k=1;k<path.length-1;k++){
   const [x,y]=path[k],direction=x<512?1:-1,up=(pathIndex+k)%3===0?1:-1,branch=[[x,y],[x+direction*(18+7*k),y+up*(17+4*k)],[x+direction*(39+6*k),y+up*(22+3*k)]];
   c.strokeStyle='rgba(255,255,255,.14)';c.lineWidth=7;c.beginPath();branch.forEach(([a,b],i)=>i?c.lineTo(a,b):c.moveTo(a,b));c.stroke();
   c.strokeStyle='rgba(255,255,255,.42)';c.lineWidth=2.5;c.beginPath();branch.forEach(([a,b],i)=>i?c.lineTo(a,b):c.moveTo(a,b));c.stroke();
  }
 }
 for(let i=0;i<36;i++){
  const side=i%2?1:-1,x=512+side*(335+(i*47)%150),y=35+(i*113)%954,length=14+(i*29)%46;
  c.strokeStyle=i%3?'rgba(255,255,255,.41)':'rgba(255,255,255,.25)';c.lineWidth=i%4?2:4;c.beginPath();c.moveTo(x,y);c.lineTo(x-side*length*.55,y+length);c.stroke();
 }
 const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;return texture;
}
function comicIconTexture(kind,fallback){
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const c=canvas.getContext('2d');
 if(!c||typeof c.bezierCurveTo!=='function')return fallback;
 c.clearRect(0,0,256,256);c.save();c.translate(128,128);c.lineJoin='round';c.shadowColor=kind==='love'?'rgba(255,78,143,.42)':'rgba(255,193,75,.45)';c.shadowBlur=22;
 c.beginPath();
 if(kind==='love'){
  c.moveTo(0,72);c.bezierCurveTo(-18,54,-78,13,-78,-27);c.bezierCurveTo(-78,-77,-24,-82,0,-48);c.bezierCurveTo(24,-82,78,-77,78,-27);c.bezierCurveTo(78,13,18,54,0,72);c.closePath();
 }else if(kind==='anger'){
  c.moveTo(-64,-65);c.quadraticCurveTo(-2,-56,0,-5);c.quadraticCurveTo(4,-56,65,-65);c.quadraticCurveTo(55,-2,7,0);c.quadraticCurveTo(55,5,65,65);c.quadraticCurveTo(3,56,0,6);c.quadraticCurveTo(-4,56,-64,65);c.quadraticCurveTo(-55,3,-6,0);c.quadraticCurveTo(-56,-4,-64,-65);c.closePath();
 }else{
  c.moveTo(0,-93);c.quadraticCurveTo(13,-18,27,-20);c.quadraticCurveTo(48,-15,87,0);c.quadraticCurveTo(24,12,21,25);c.quadraticCurveTo(11,43,0,91);c.quadraticCurveTo(-12,30,-24,23);c.quadraticCurveTo(-38,12,-88,0);c.quadraticCurveTo(-28,-13,-22,-24);c.quadraticCurveTo(-11,-43,0,-93);c.closePath();
 }
 c.lineWidth=8;c.strokeStyle='rgba(255,255,255,.92)';c.stroke();c.fillStyle=kind==='love'?'#ff5f98':kind==='anger'?'#ec4549':'#fff6c8';c.fill();c.restore();const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;return texture;
}
function speedTexture(fallback){
 const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96;const c=canvas.getContext('2d');
 if(!c||typeof c.bezierCurveTo!=='function')return fallback;
 c.clearRect(0,0,512,96);const g=c.createLinearGradient(0,0,512,0);g.addColorStop(0,'rgba(255,255,255,0)');g.addColorStop(.25,'rgba(171,225,255,.18)');g.addColorStop(.66,'rgba(232,251,255,.9)');g.addColorStop(1,'rgba(255,255,255,0)');
 c.fillStyle=g;c.shadowColor='rgba(129,204,255,.7)';c.shadowBlur=12;c.beginPath();c.moveTo(0,48);c.bezierCurveTo(130,33,300,25,500,48);c.bezierCurveTo(300,71,130,63,0,48);c.closePath();c.fill();
 const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.minFilter=T.LinearFilter;texture.generateMipmaps=false;return texture;
}
class StageEffects {
 constructor(scene,bunny,ears,camera){
  this.bunny=bunny;this.ears=ears;this.camera=camera;this.lastKind='';this.lastPiece=-1;this.ballSide=1;this.ballState=null;
  this.tmp=new T.Vector3();this.tmp2=new T.Vector3();this.local=new T.Vector3();this.normal=new T.Vector3();this.boneA=new T.Vector3();this.boneB=new T.Vector3();
  this.ball=new T.Group();scene.add(this.ball);
  const ballBody=new T.Mesh(new T.SphereGeometry(.36,32,24),new T.MeshStandardMaterial({color:0xff694f,roughness:.27}));this.ball.add(ballBody);
  const spot=new T.Mesh(new T.SphereGeometry(.095,20,14),new T.MeshStandardMaterial({color:0xffe9b2,roughness:.4}));spot.position.set(-.08,.09,.318);spot.scale.z=.4;this.ball.add(spot);this.ball.visible=false;
  // Soft-edged translucent disks: near, middle and distant snow layers.
  const spriteCanvas=document.createElement('canvas');spriteCanvas.width=spriteCanvas.height=128;
  const spriteContext=spriteCanvas.getContext('2d'),gradient=spriteContext.createRadialGradient(64,64,2,64,64,63);
  gradient.addColorStop(0,'rgba(255,255,255,0.98)');gradient.addColorStop(.38,'rgba(255,255,255,0.83)');gradient.addColorStop(.76,'rgba(255,255,255,0.22)');gradient.addColorStop(1,'rgba(255,255,255,0)');
  spriteContext.fillStyle=gradient;spriteContext.fillRect(0,0,128,128);
  const softSprite=new T.CanvasTexture(spriteCanvas);
  const snowCanvas=document.createElement('canvas');snowCanvas.width=snowCanvas.height=128;
  const snowContext=snowCanvas.getContext('2d'),snowGradient=snowContext.createRadialGradient(64,64,2,64,64,63);
  snowGradient.addColorStop(0,'rgba(255,255,255,1)');snowGradient.addColorStop(.28,'rgba(255,255,255,.95)');snowGradient.addColorStop(.68,'rgba(201,227,245,.48)');snowGradient.addColorStop(1,'rgba(143,181,212,0)');snowContext.fillStyle=snowGradient;snowContext.fillRect(0,0,128,128);
  const snowSprite=new T.CanvasTexture(snowCanvas);
  this.snow=new T.Group();this.snow.visible=false;scene.add(this.snow);this.snowLayers=[];
  this.wordTextures=new Map();this.word=new T.Sprite(new T.SpriteMaterial({map:softSprite,transparent:true,opacity:0,depthTest:false,depthWrite:false,toneMapped:false}));this.word.visible=false;this.word.renderOrder=30;scene.add(this.word);
  this.sleepTrail=[];for(let i=0;i<2;i++){const sprite=new T.Sprite(new T.SpriteMaterial({map:softSprite,transparent:true,opacity:0,depthTest:false,depthWrite:false,toneMapped:false}));sprite.visible=false;sprite.renderOrder=29;scene.add(sprite);this.sleepTrail.push(sprite)}
  this.iconTextures={spark:comicIconTexture('spark',softSprite),love:comicIconTexture('love',softSprite),anger:comicIconTexture('anger',softSprite)};
  this.motifs=[];for(let i=0;i<5;i++){const sprite=new T.Sprite(new T.SpriteMaterial({map:this.iconTextures.spark,transparent:true,opacity:0,depthWrite:false,toneMapped:false}));sprite.visible=false;scene.add(sprite);this.motifs.push(sprite)}
  this.comicProjection=new T.Vector3();this.comicDepth=new T.Vector3();
  this.speedSprites=[];const speedMap=speedTexture(softSprite);for(let i=0;i<6;i++){const sprite=new T.Sprite(new T.SpriteMaterial({map:speedMap,color:0x83bcff,transparent:true,opacity:0,depthWrite:false,toneMapped:false}));sprite.visible=false;scene.add(sprite);this.speedSprites.push(sprite)}
  this.fxPrevPosition=new T.Vector3();this.fxVelocity=new T.Vector3();this.fxPreviousTime=0;this.fxInitialized=false;


  for(const [count,size,opacity,depth] of [[70,.16,.75,-1.8],[55,.27,.82,-.2],[34,.40,.70,1.6]]){
   const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(count*3),3));
   const material=variedParticleSizes(geometry,new T.PointsMaterial({size,map:snowSprite,color:0xffffff,transparent:true,opacity,depthWrite:false,sizeAttenuation:true,toneMapped:false}),count,17);
   const sizes=geometry.attributes.particleSize.array;for(let i=0;i<count;i++)sizes[i]=.68+((i*37)%67)/100;
   const points=new T.Points(geometry,material);points.frustumCulled=false;this.snow.add(points);this.snowLayers.push({points,count,depth});
  }
  // Expressive, soft-edged particles with individually varied sizes.
  const accentCount=84,accentGeo=new T.BufferGeometry(),accentPositions=new Float32Array(accentCount*3),accentColors=new Float32Array(accentCount*3);
  accentGeo.setAttribute('position',new T.Float32BufferAttribute(accentPositions,3));accentGeo.setAttribute('color',new T.Float32BufferAttribute(accentColors,3));
  this.accents=new T.Points(accentGeo,variedParticleSizes(accentGeo,new T.PointsMaterial({map:softSprite,size:.12,vertexColors:true,transparent:true,opacity:.88,depthWrite:false,sizeAttenuation:true,toneMapped:false}),accentCount));this.accents.frustumCulled=false;this.accents.visible=false;scene.add(this.accents);this.accentColor=new T.Color();
  this.clapFlash=new T.Sprite(new T.SpriteMaterial({map:softSprite,color:0xffef96,transparent:true,opacity:.85,depthWrite:false,toneMapped:false}));this.clapFlash.visible=false;scene.add(this.clapFlash);
  this.glow=new T.Mesh(new T.PlaneGeometry(3.2,3.2),new T.MeshBasicMaterial({map:softSprite,color:0xffbbdf,transparent:true,opacity:.16,depthWrite:false,toneMapped:false}));this.glow.visible=false;scene.add(this.glow);
  const streakGeometry=new T.BufferGeometry();streakGeometry.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(72),3));
  this.streaks=new T.LineSegments(streakGeometry,new T.LineBasicMaterial({color:0xff8d46,transparent:true,opacity:.65,depthWrite:false,toneMapped:false}));this.streaks.frustumCulled=false;this.streaks.visible=false;scene.add(this.streaks);
  this.tears=[];const tearMaterial=new T.MeshStandardMaterial({color:0x39afea,roughness:.24});
  for(const side of [-1,1]){const tear=new T.Mesh(new T.SphereGeometry(1,20,14),tearMaterial);tear.visible=false;tear.userData.side=side;bunny.add(tear);this.tears.push(tear)}
  // Solid rounded segments make real 3D numbers, not text painted on screen.
  this.digit=new T.Group();this.digit.position.set(1.65,2.2,.55);this.digit.visible=false;scene.add(this.digit);
  const numberMaterial=new T.MeshStandardMaterial({color:0xffffff,emissive:0x202028,roughness:.3}),horizontal=new T.CapsuleGeometry(.075,.40,4,10),vertical=new T.CapsuleGeometry(.075,.40,4,10);
  const positions=[[0,.55,0],[.28,.28,0],[.28,-.28,0],[0,-.55,0],[-.28,-.28,0],[-.28,.28,0],[0,0,0]];this.digitSegments=[];
  for(let i=0;i<7;i++){const segment=new T.Mesh(i===0||i===3||i===6?horizontal:vertical,numberMaterial);if(i===0||i===3||i===6)segment.rotation.z=Math.PI/2;segment.position.set(...positions[i]);this.digit.add(segment);this.digitSegments.push(segment)}
  // A glass bulb, filament and metal socket tell the idea beat in 3D.
  this.ideaBulb=new T.Group();this.ideaBulb.visible=false;scene.add(this.ideaBulb);
  const profile=[[.115,-.20],[.13,-.12],[.21,-.035],[.28,.09],[.285,.20],[.235,.31],[.14,.38],[0,.405]].map(([x,y])=>({x,y}));
  this.bulbGlass=new T.Mesh(new T.LatheGeometry(profile,32),new T.MeshPhysicalMaterial({color:0xfff5d1,emissive:0x302000,emissiveIntensity:.2,roughness:.20,clearcoat:1,clearcoatRoughness:.13,transparent:true,opacity:.42,depthWrite:false}));this.bulbGlass.renderOrder=1;this.ideaBulb.add(this.bulbGlass);
  const socket=new T.Mesh(new T.CylinderGeometry(.12,.105,.19,24),new T.MeshStandardMaterial({color:0xc5a66e,metalness:.65,roughness:.28}));socket.position.y=-.22;this.ideaBulb.add(socket);
  for(let i=0;i<3;i++){const ring=new T.Mesh(new T.TorusGeometry(.112,.012,8,28),new T.MeshStandardMaterial({color:0xffe7a7,metalness:.55,roughness:.3}));ring.rotation.x=Math.PI/2;ring.position.y=-.16-i*.055;this.ideaBulb.add(ring)}
  // Four solid segments make a readable W inside the glass, including on
  // displays where WebGL lines are restricted to a single pixel.
  this.bulbFilament=new T.Group();this.ideaBulb.add(this.bulbFilament);
  this.filamentMaterial=new T.MeshBasicMaterial({color:0xffc858,transparent:true,opacity:.55,depthWrite:false,depthTest:false,toneMapped:false});
  this.filamentOff=new T.Color(0xa95c18);this.filamentOn=new T.Color(0xffc52d);
  const wirePoints=[[-.16,.19,.025],[-.085,.035,.025],[0,.135,.025],[.085,.035,.025],[.16,.19,.025]],axis=new T.Vector3(0,1,0);
  const wire=(a,b,radius)=>{const start=new T.Vector3(...a),end=new T.Vector3(...b),direction=end.clone().sub(start),segment=new T.Mesh(new T.CylinderGeometry(radius,radius,direction.length(),10),this.filamentMaterial);segment.position.copy(start).add(end).multiplyScalar(.5);segment.quaternion.setFromUnitVectors(axis,direction.normalize());segment.renderOrder=3;this.bulbFilament.add(segment)};
  for(let i=0;i<wirePoints.length-1;i++)wire(wirePoints[i],wirePoints[i+1],.014);
  wire([-.16,.19,.025],[-.075,-.14,.025],.006);wire([.16,.19,.025],[.075,-.14,.025],.006);
  this.filamentGlows=[];for(const [x,y,z] of wirePoints){const glow=new T.Sprite(new T.SpriteMaterial({map:softSprite,color:0xffdb68,transparent:true,opacity:0,depthWrite:false,depthTest:false,toneMapped:false}));glow.position.set(x,y,z+.015);glow.scale.set(.17,.17,1);glow.renderOrder=2;this.bulbFilament.add(glow);this.filamentGlows.push(glow)}
  this.bulbHalo=new T.Sprite(new T.SpriteMaterial({map:softSprite,color:0xffdc72,transparent:true,opacity:0,depthWrite:false,toneMapped:false}));this.bulbHalo.scale.set(1.45,1.45,1);this.bulbHalo.position.set(0,.1,-.16);this.ideaBulb.add(this.bulbHalo);
  const bulbRays=[];for(let i=0;i<8;i++){const a=i*Math.PI/4;bulbRays.push(Math.cos(a)*.39,.10+Math.sin(a)*.39,0,Math.cos(a)*.54,.10+Math.sin(a)*.54,0)}
  const bulbRayGeo=new T.BufferGeometry();bulbRayGeo.setAttribute('position',new T.Float32BufferAttribute(bulbRays,3));this.bulbRays=new T.LineSegments(bulbRayGeo,new T.LineBasicMaterial({color:0xffe5a0,transparent:true,opacity:0,depthWrite:false,toneMapped:false}));this.ideaBulb.add(this.bulbRays);
  const count=8*28,sparkGeometry=new T.BufferGeometry(),sparkPositions=new Float32Array(count*3),colors=new Float32Array(count*3);
  for(let i=0;i<count;i++){const color=new T.Color([0xff527d,0xffc038,0x56cceb,0xd478fb][i%4]);colors[i*3]=color.r;colors[i*3+1]=color.g;colors[i*3+2]=color.b}
  sparkGeometry.setAttribute('position',new T.Float32BufferAttribute(sparkPositions,3));sparkGeometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
  this.sparks=new T.Points(sparkGeometry,variedParticleSizes(sparkGeometry,new T.PointsMaterial({map:this.iconTextures.spark,size:.16,vertexColors:true,transparent:true,opacity:.95,depthWrite:false,sizeAttenuation:true,toneMapped:false}),count,3));this.sparks.frustumCulled=false;this.sparks.visible=false;scene.add(this.sparks);
  const rayGeometry=new T.BufferGeometry(),rayPositions=new Float32Array(count*6),rayColors=new Float32Array(count*6);
  for(let i=0;i<count;i++)for(let j=0;j<2;j++){rayColors[i*6+j*3]=colors[i*3];rayColors[i*6+j*3+1]=colors[i*3+1];rayColors[i*6+j*3+2]=colors[i*3+2]}
  rayGeometry.setAttribute('position',new T.Float32BufferAttribute(rayPositions,3));rayGeometry.setAttribute('color',new T.Float32BufferAttribute(rayColors,3));
  this.rays=new T.LineSegments(rayGeometry,new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.65,depthWrite:false}));this.rays.frustumCulled=false;this.rays.visible=false;scene.add(this.rays);
  this.portal=new T.Mesh(new T.TorusGeometry(.82,.045,10,64),new T.MeshBasicMaterial({color:0xc77cf0,transparent:true,opacity:.7,depthWrite:false}));this.portal.visible=false;scene.add(this.portal);
  // Real particle fields: soft outer glow, rising flame particles and small
  // sparks. Each particle has its own birth, velocity, lifetime and fade.
  const fireCanvas=document.createElement('canvas');fireCanvas.width=fireCanvas.height=128;
  const fctx=fireCanvas.getContext('2d'),fg=fctx.createRadialGradient(64,64,1,64,64,63);
  fg.addColorStop(0,'rgba(255,255,255,.92)');fg.addColorStop(.18,'rgba(255,255,255,.72)');fg.addColorStop(.48,'rgba(255,255,255,.30)');fg.addColorStop(.78,'rgba(255,255,255,.045)');fg.addColorStop(1,'rgba(255,255,255,0)');
  fctx.fillStyle=fg;fctx.fillRect(0,0,128,128);const fireSprite=new T.CanvasTexture(fireCanvas);
  this.fireFields=[
   this.createFireField(scene,fireSprite,{kind:'glow',count:500,rate:720,size:1.16,opacity:.27,lifeMin:.40,lifeMax:.63,seed:31}),
   this.createFireField(scene,fireSprite,{kind:'flame',count:1200,rate:1500,size:.82,opacity:.52,lifeMin:.38,lifeMax:.62,seed:41}),
   this.createFireField(scene,fireSprite,{kind:'core',count:500,rate:550,size:.75,opacity:.35,lifeMin:.34,lifeMax:.53,seed:47}),
   this.createFireField(scene,fireSprite,{kind:'ember',count:120,rate:95,size:.10,opacity:.78,lifeMin:.34,lifeMax:.58,seed:53})
  ];
  this.flames=this.fireFields[1].points;this.fireTime=null;this.fireSeed=0x6d2b79f5;this.fireColor=new T.Color();
  this.firePalette={white:new T.Color(0xfff9b8),yellow:new T.Color(0xffd637),hot:new T.Color(0xffaa22),orange:new T.Color(0xff6010),red:new T.Color(0xe02d0c),dark:new T.Color(0x9d1b11),ember:new T.Color(0xffe171),smokeDark:new T.Color(0x716a70),smokeLight:new T.Color(0xb5aeb0)};
  // Smoke is born from the upper edge of live flames, not from a separate
  // world-space plume. It follows the head and fades before reaching the tips.
  this.smokeField=this.createFireField(scene,fireSprite,{kind:'smoke',count:220,rate:220,size:.32,opacity:.24,lifeMin:.22,lifeMax:.38,seed:61});
  this.smoke=this.smokeField.points;this.smokeSources=[];
  // A translucent rounded ice block is a real 3D prop attached to the head.
  this.ice=new T.Group();this.ice.position.y=.76;this.ice.visible=false;bunny.add(this.ice);
  const box=new T.BoxGeometry(2.84,3.40,2.25,8,8,8),verts=box.attributes.position.array,half=[1.42,1.70,1.125],radius=.22;
  for(let i=0;i<verts.length;i+=3){const x=verts[i],y=verts[i+1],z=verts[i+2],cx=Math.max(-half[0]+radius,Math.min(half[0]-radius,x)),cy=Math.max(-half[1]+radius,Math.min(half[1]-radius,y)),cz=Math.max(-half[2]+radius,Math.min(half[2]-radius,z)),dx=x-cx,dy=y-cy,dz=z-cz,len=Math.hypot(dx,dy,dz)||1;
   // A restrained irregular edge catches light like chipped ice; duplicate
   // face vertices receive the same offset so the shell stays watertight.
   const edge=(Math.abs(x)>half[0]-.01?1:0)+(Math.abs(y)>half[1]-.01?1:0)+(Math.abs(z)>half[2]-.01?1:0),chip=edge>1?.009*(1+Math.sin(x*8+y*6+z*9)):0;
   verts[i]=(cx+dx/len*radius)*(1-chip);verts[i+1]=(cy+dy/len*radius)*(1-chip);verts[i+2]=(cz+dz/len*radius)*(1-chip);
  }
  box.computeVertexNormals();const frostMap=iceTexture(null),iceMaterial=new T.MeshPhysicalMaterial({color:0xb7ecff,map:frostMap,transparent:true,opacity:.23,roughness:.13,metalness:.02,clearcoat:1,clearcoatRoughness:.11,depthWrite:false,side:T.DoubleSide});this.iceSurface=new T.Mesh(box,iceMaterial);this.ice.add(this.iceSurface);
  const edgeGeometry=new T.EdgesGeometry(new T.BoxGeometry(2.70,3.26,2.11));const edges=new T.LineSegments(edgeGeometry,new T.LineBasicMaterial({color:0xe6faff,transparent:true,opacity:.45,depthWrite:false}));this.iceEdges=edges;this.ice.add(edges);
  // Angular fractures lie on the front and sides of the block so they turn
  // with it; the centre stays clear enough to read the rabbit's eyes.
  const iceLines=[],frontCracks=[
   [[-1.28,1.40],[-1.05,1.22],[-.98,1.02],[-.75,.91],[-.65,.72]],
   [[1.27,1.39],[1.03,1.24],[.94,1.05],[.70,.94],[.62,.76]],
   [[-1.31,.52],[-1.15,.38],[-1.19,.20],[-.97,.08],[-.93,-.12]],
   [[1.29,.56],[1.14,.43],[1.17,.25],[.96,.12],[.91,-.04]],
   [[-1.28,-1.42],[-1.08,-1.24],[-.86,-1.29],[-.70,-1.11]],
   [[1.28,-1.41],[1.08,-1.25],[.87,-1.30],[.68,-1.13]]
  ];
  for(const path of frontCracks)for(let i=1;i<path.length;i++)iceLines.push(path[i-1][0],path[i-1][1],1.126,path[i][0],path[i][1],1.126);
  for(const side of [-1,1])for(const path of [[[-.90,1.38],[-.55,1.17],[-.42,.93],[-.12,.82]],[[.90,-1.38],[.62,-1.15],[.38,-1.18],[.15,-.98]]])for(let i=1;i<path.length;i++)iceLines.push(side*1.421,path[i-1][1],path[i-1][0],side*1.421,path[i][1],path[i][0]);
  const crackGeometry=new T.BufferGeometry();crackGeometry.setAttribute('position',new T.Float32BufferAttribute(iceLines,3));
  this.iceCracks=new T.LineSegments(crackGeometry,new T.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.35,depthWrite:false,toneMapped:false}));this.iceCracks.renderOrder=2;this.ice.add(this.iceCracks);
  const fractureMap=iceFractureTexture();this.iceFractureMaterial=null;this.iceFractureFaces=[];
  if(fractureMap){
   this.iceFractureMaterial=new T.MeshBasicMaterial({map:fractureMap,transparent:true,opacity:.94,depthWrite:false,toneMapped:false});
   const addFace=(width,height,x,z,rotation)=>{const face=new T.Mesh(new T.PlaneGeometry(width,height),this.iceFractureMaterial);face.position.set(x,0,z);face.rotation.y=rotation;face.renderOrder=3;this.ice.add(face);this.iceFractureFaces.push(face)};
   addFace(2.50,3.04,0,1.129,0);addFace(2.50,3.04,0,-1.129,Math.PI);
   addFace(1.84,3.04,1.423,0,Math.PI/2);addFace(1.84,3.04,-1.423,0,-Math.PI/2);
  }
  this.bodyVelocity=new T.Vector3();this.previousBody=new T.Vector3();this.bodyCenter=new T.Vector3();this.fxRight=new T.Vector3(1,0,0);this.fxUp=new T.Vector3(0,1,0);this.fxToward=new T.Vector3(0,0,1);
  this.buildCollisionSurface();
 }
 createFireField(scene,map,config){
  const count=config.count,geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(count*3),3));geometry.setAttribute('color',new T.Float32BufferAttribute(new Float32Array(count*3),3));
  const material=variedParticleSizes(geometry,new T.PointsMaterial({map,size:config.size,vertexColors:true,transparent:true,opacity:config.opacity,depthWrite:false,sizeAttenuation:true,toneMapped:false}),count,config.seed);
  // Local-space particles stay on the crown even while the head turns or jumps.
  const points=new T.Points(geometry,material);points.frustumCulled=false;points.visible=false;this.bunny.add(points);
  const age=new Float32Array(count);age.fill(-1);geometry.attributes.particleAlpha.array.fill(0);
  return {config,points,age,life:new Float32Array(count),velocity:new Float32Array(count*3),seed:new Float32Array(count),baseSize:new Float32Array(count),carry:0,cursor:0,active:0};
 }
 fireRandom(){this.fireSeed=(Math.imul(this.fireSeed,1664525)+1013904223)>>>0;return this.fireSeed/4294967296}
 resetFire(){
  this.fireSeed=0x6d2b79f5;this.fireTime=null;
  for(const f of [...this.fireFields,this.smokeField]){f.age.fill(-1);f.points.geometry.attributes.particleAlpha.array.fill(0);f.points.geometry.attributes.particleAlpha.needsUpdate=true;f.points.visible=false;f.carry=0;f.cursor=0;f.active=0}
 }
 spawnFireParticle(f,index){
  const {config}=f,r=()=>this.fireRandom(),positions=f.points.geometry.attributes.position.array,velocity=f.velocity,k=index*3;
  if(config.kind==='smoke'){
   const flame=this.fireFields[1],source=flame.points.geometry.attributes.position.array;
   if(!this.smokeSources.length)return;
   const sourceIndex=this.smokeSources[Math.floor(r()*this.smokeSources.length)];
   const j=sourceIndex*3;positions[k]=source[j];positions[k+1]=source[j+1]+.025;positions[k+2]=source[j+2]-.09;
   velocity[k]=(r()-.5)*.16;velocity[k+1]=.06+r()*.12;velocity[k+2]=(r()-.5)*.10;
   f.age[index]=0;f.life[index]=config.lifeMin+r()*(config.lifeMax-config.lifeMin);f.seed[index]=r()*1000;f.baseSize[index]=.75+r()*.55;return;
  }
  const core=config.kind==='core',spread=core?.36:.68,offset=(r()-.5)*2*spread;
  positions[k]=offset;positions[k+1]=.87+r()*.14;positions[k+2]=.20+r()*.34;
  // Short, buoyant paths keep the fire close to the crown rather than sending
  // the particles high above the ears.
  velocity[k]=(r()-.5)*.55-offset*.24;
  velocity[k+1]=config.kind==='ember'?1.1+r()*.60:.90+r()*.55;
  velocity[k+2]=(r()-.5)*.32;
  f.age[index]=0;f.life[index]=config.lifeMin+r()*(config.lifeMax-config.lifeMin);f.seed[index]=r()*1000;f.baseSize[index]=.72+r()*.80;
 }
 updateFire(piece,time,pose,changed){
  if(piece.vfx!=='fire'){if(this.fireTime!==null)this.resetFire();return}
  if(changed)this.resetFire();const delta=this.fireTime===null?0:Math.max(0,Math.min(.06,time-this.fireTime));this.fireTime=time;
  const strength=Math.max(0,Math.min(1,pose.fire||0)),steps=Math.max(1,Math.ceil(delta*60)),dt=delta/steps;
  for(const f of [...this.fireFields,this.smokeField]){
   const {config,age,life,velocity,seed,baseSize}=f,geo=f.points.geometry,pos=geo.attributes.position.array,colors=geo.attributes.color.array,alpha=geo.attributes.particleAlpha.array,size=geo.attributes.particleSize.array;
   if(config.kind==='smoke'){
    const flame=this.fireFields[1],source=flame.points.geometry.attributes.position.array;this.smokeSources.length=0;
    for(let n=0;n<flame.config.count;n++)if(flame.age[n]>=0){const q=flame.age[n]/flame.life[n],j=n*3;if(q>.62&&q<.90&&Math.abs(source[j])<.30&&source[j+1]>1.25&&source[j+1]<1.49)this.smokeSources.push(n)}
   }
   for(let step=0;step<steps;step++){
    f.carry+=config.rate*strength*(config.kind==='smoke'&&piece.smokeBoost===true?1.4:1)*dt;let spawn=Math.floor(f.carry);f.carry-=spawn;
    while(spawn-->0){let tries=0;while(tries<config.count&&age[f.cursor]>=0){f.cursor=(f.cursor+1)%config.count;tries++}if(tries===config.count)break;this.spawnFireParticle(f,f.cursor);f.cursor=(f.cursor+1)%config.count}
    for(let i=0;i<config.count;i++)if(age[i]>=0){
     age[i]+=dt;if(age[i]>=life[i]){age[i]=-1;alpha[i]=0;continue}
     const k=i*3,field=pos[k+1]*2.2-time*2.8+seed[i]*.013,swirl=fireFbm(field),cross=fireFbm(field+29.7);
     const smoke=config.kind==='smoke';velocity[k]+=swirl*(smoke?.26:.95)*dt;velocity[k+2]+=cross*(smoke?.18:.68)*dt;velocity[k+1]+=(smoke?.04:config.kind==='ember'?.38:.24)*dt;
     const drag=Math.exp(-.25*dt);velocity[k]*=drag;velocity[k+2]*=drag;
     pos[k]+=velocity[k]*dt;pos[k+1]+=velocity[k+1]*dt;pos[k+2]+=velocity[k+2]*dt;
    }
   }
   let active=0;
   for(let i=0;i<config.count;i++){
    if(age[i]<0){alpha[i]=0;continue}active++;const q=Math.max(0,Math.min(1,age[i]/life[i])),k=i*3;
    const birth=Math.min(1,q*8),fade=Math.pow(1-q,config.kind==='glow'?1.45:1.15),flicker=.78+.22*Math.sin(time*12+seed[i]);
    alpha[i]=birth*fade*flicker;size[i]=baseSize[i]*(config.kind==='smoke'?.70+.55*q:config.kind==='ember'?.55+.45*(1-q):.70+.65*Math.sin(Math.PI*q));
    if(config.kind==='smoke')this.fireColor.copy(this.firePalette.smokeDark).lerp(this.firePalette.smokeLight,q);
    else if(config.kind==='core'&&q<.42)this.fireColor.copy(this.firePalette.white).lerp(this.firePalette.yellow,q/.42);
    else if(config.kind==='core'&&q<.78)this.fireColor.copy(this.firePalette.yellow).lerp(this.firePalette.hot,(q-.42)/.36);
    else if(config.kind==='core')this.fireColor.copy(this.firePalette.hot).lerp(this.firePalette.orange,(q-.78)/.22);
    else if(config.kind==='ember')this.fireColor.copy(this.firePalette.ember).lerp(this.firePalette.red,q);
    else if(q<.30)this.fireColor.copy(this.firePalette.hot).lerp(this.firePalette.orange,q/.30);
    else if(q<.72)this.fireColor.copy(this.firePalette.orange).lerp(this.firePalette.red,(q-.30)/.42);
    else this.fireColor.copy(this.firePalette.red).lerp(this.firePalette.dark,(q-.72)/.28);
    colors[k]=this.fireColor.r;colors[k+1]=this.fireColor.g;colors[k+2]=this.fireColor.b;
   }
   f.active=active;f.points.visible=active>0;f.points.material.opacity=config.opacity*Math.max(0,Math.min(1,(piece.duration-time)/.22));geo.attributes.position.needsUpdate=true;geo.attributes.color.needsUpdate=true;geo.attributes.particleAlpha.needsUpdate=true;geo.attributes.particleSize.needsUpdate=true;
  }
 }
 getWordTexture(label,kind){
  const key=label+'|'+kind;if(!this.wordTextures.has(key))this.wordTextures.set(key,comicWordTexture(label,kind,this.clapFlash.material.map));return this.wordTextures.get(key);
 }
 updateIdea(piece,time){
  if(!piece.idea){this.ideaBulb.visible=false;return}
  const phase=Math.max(0,Math.min(1,time/piece.duration)),frames=piece.frames,index=frames.findIndex(f=>(f[1].star||0)>.5);
  const onset=index>0?frames[index-1][0]:.45,lit=Math.max(0,Math.min(1,(phase-onset)/.07)),presence=Math.max(0,Math.min(1,(phase-.14)/.08,(.97-phase)/.10));
  this.ideaBulb.visible=presence>.01;if(!this.ideaBulb.visible)return;
  this.ideaBulb.position.copy(this.bunny.position).addScaledVector(this.fxRight,1.05).addScaledVector(this.fxUp,2.35).addScaledVector(this.fxToward,.38);
  if(this.camera){
   this.comicProjection.copy(this.ideaBulb.position).project(this.camera);this.comicProjection.x=Math.max(-.82,Math.min(.82,this.comicProjection.x));this.comicProjection.y=Math.max(-.78,Math.min(.78,this.comicProjection.y));
   this.ideaBulb.position.copy(this.comicProjection.unproject(this.camera));this.ideaBulb.quaternion.copy(this.camera.quaternion);
  }
  const pop=.80+.20*presence+.10*Math.exp(-Math.max(0,phase-onset)*15)*Math.sin(Math.max(0,phase-onset)*55)*lit;
  this.ideaBulb.scale.setScalar(pop);this.bulbGlass.material.opacity=presence*(.27+.16*lit);this.bulbGlass.material.emissiveIntensity=.12+.65*lit;
  this.filamentMaterial.opacity=presence*(.58+.42*lit);this.filamentMaterial.color.copy(this.filamentOff).lerp(this.filamentOn,lit);
  for(const glow of this.filamentGlows)glow.material.opacity=presence*lit*.48;
  this.bulbHalo.material.opacity=presence*lit*(.48+.07*Math.sin(time*9));this.bulbRays.material.opacity=presence*lit*.95;
 }
 updateComic(piece,time,pose,countdownEnd){
  const spec=piece.comic,phase=Math.max(0,Math.min(1,time/piece.duration));let amount=0;
  if(spec){
   if(spec.kind==='impact'){
    const hit=this.ballState;const age=hit&&hit.firstImpact===spec.hit&&hit.impactTime!=null?time-hit.impactTime:-1;
    if(age>=0&&age<.78)amount=Math.min(1,age/.075)*Math.min(1,(.78-age)/.20);
   }else if(spec.kind==='clap')amount=Math.max(0,Math.min(1,((pose.earClap||0)-.55)/.35));
   else if(spec.kind==='fireworks'){const age=time-countdownEnd;if(age>=0&&age<1.15)amount=Math.min(1,age/.12)*Math.min(1,(1.15-age)/.22)}
   else{
    const start=spec.kind==='sleep'?.35:.14,end=spec.kind==='sleep'?.96:.86;
    const window=Math.max(0,Math.min(1,(phase-start)/.08,(end-phase)/.11));
    const signal=spec.kind==='sleep'?Math.max(pose.sleepy||0,Math.min(pose.wl||0,pose.wr||0)):spec.kind==='joy'?Math.max(pose.joy||0,pose.giggle||0):spec.kind==='fire'?(pose.fire||0):spec.kind==='anger'?(pose.angry||0):spec.kind==='love'?Math.max(pose.heart||0,(pose.blush||0)*.8):spec.kind==='speed'?Math.max(Math.abs(pose.step||0),Math.abs(pose.z||0)/5,pose.flash||0):spec.kind==='ice'?(pose.frost||0):spec.kind==='refuse'?(pose.angry||0):spec.kind==='wonder'?Math.max(pose.wide||0,Math.abs(pose.gx||0)*3):Math.max(pose.wide||0,pose.star||0);
    amount=window*Math.max(0,Math.min(1,signal*2));
   }
  }
  const wasVisible=this.word.visible&&this.wordPiece===piece.id&&time>=(this.wordPreviousTime??0);
  this.word.visible=!!spec&&amount>.015;if(this.word.visible&&!wasVisible)this.wordStarted=time;this.wordPiece=piece.id;this.wordPreviousTime=time;for(const z of this.sleepTrail)z.visible=false;
  if(!this.word.visible)return;
  const material=this.word.material,texture=this.getWordTexture(spec.text,spec.kind);if(material.map!==texture){material.map=texture;material.needsUpdate=true}
  if(this.camera){this.camera.updateMatrixWorld();this.fxRight.set(1,0,0).applyQuaternion(this.camera.quaternion);this.fxUp.set(0,1,0).applyQuaternion(this.camera.quaternion);this.fxToward.set(0,0,1).applyQuaternion(this.camera.quaternion)}
  const side=spec.text==='OUCH!'||spec.kind==='fire'||piece.idea===true?-1:1,short=spec.text==='?'||spec.text==='!?';
  const age=Math.max(0,time-(this.wordStarted??time));
  const width=(spec.kind==='sleep'?1.55:short?1.25:2.15)*(this.camera?Math.min(1,Math.max(.72,this.camera.aspect)):1),pop=spec.kind==='sleep'?.82+.18*amount:Math.max(.45,Math.min(1.13,1-Math.exp(-age*14)*Math.cos(age*21)));
  this.word.position.copy(this.bunny.position).addScaledVector(this.fxRight,side*1.65).addScaledVector(this.fxUp,1.65+(spec.kind==='sleep'?.12*Math.sin(time*2):0)).addScaledVector(this.fxToward,.55);
  if(this.camera){
   const depth=Math.max(.1,-this.comicDepth.copy(this.word.position).applyMatrix4(this.camera.matrixWorldInverse).z),tangent=Math.tan(this.camera.fov*Math.PI/360);
   const xLimit=Math.max(.12,1-width*pop/(2*depth*tangent*this.camera.aspect)-.04),yLimit=Math.max(.12,1-width*pop/(6*depth*tangent)-.04);
   this.comicProjection.copy(this.word.position).project(this.camera);this.comicProjection.x=Math.max(-xLimit,Math.min(xLimit,this.comicProjection.x));this.comicProjection.y=Math.max(-yLimit,Math.min(yLimit,this.comicProjection.y));this.word.position.copy(this.comicProjection.unproject(this.camera));
  }
  this.word.scale.set(width*pop,width*pop/3,1);material.opacity=amount;material.rotation=(side<0?-.07:.07)+.025*Math.sin(time*6);
  if(spec.kind==='sleep')for(let i=0;i<this.sleepTrail.length;i++){
   const z=this.sleepTrail[i],step=(time*.42+i*.38)%1;z.visible=true;z.material.map=this.getWordTexture('Z','sleep');z.material.opacity=amount*(1-step)*.72;
   z.position.copy(this.word.position).addScaledVector(this.fxRight,.36+step*.34).addScaledVector(this.fxUp,.22+step*.60);const size=.42+step*.18;z.scale.set(size,size/3,1);
  }
 }
 updateMotifs(effect,intensity,time){
  const kind=effect==='love'?'love':effect==='anger'?'anger':effect==='spark'||effect==='ice'?'spark':'';
  for(let i=0;i<this.motifs.length;i++){
   const sprite=this.motifs[i];sprite.visible=!!kind&&intensity>.03;if(!sprite.visible)continue;
   const phase=(time*(kind==='anger'?1.4:.7)+i*.23)%1,side=i%2?1:-1;
   sprite.material.map=this.iconTextures[kind];sprite.material.color.setHex(effect==='ice'?0x83cfff:0xffffff);sprite.material.opacity=intensity*Math.sin(Math.PI*phase)*.88;
   sprite.position.copy(this.bunny.position).addScaledVector(this.fxRight,side*(1.15+.46*phase)).addScaledVector(this.fxUp,.30+phase*1.8).addScaledVector(this.fxToward,.2);
   const size=(kind==='anger'?.43:kind==='love'?.32:.29)*(1+.18*Math.sin(time*4+i));sprite.scale.set(size,size,1);sprite.material.rotation=(i-2)*.19+time*.3;
  }
 }
 updateSpeed(effect,intensity,time,changed){
  const delta=time-this.fxPreviousTime;
  if(!this.fxInitialized||changed||delta<=0||delta>.12)this.fxVelocity.set(0,0,0);
  else this.fxVelocity.copy(this.bunny.position).sub(this.fxPrevPosition).multiplyScalar(1/delta);
  this.fxPrevPosition.copy(this.bunny.position);this.fxPreviousTime=time;this.fxInitialized=true;
  const vx=this.fxVelocity.dot(this.fxRight),vy=this.fxVelocity.dot(this.fxUp),speed=Math.hypot(vx,vy),angle=Math.atan2(vy,vx),dx=Math.cos(angle),dy=Math.sin(angle);
  for(let i=0;i<this.speedSprites.length;i++){
   const sprite=this.speedSprites[i];sprite.visible=effect==='speed'&&intensity>.04&&speed>.35;if(!sprite.visible)continue;
   const phase=(time*2.2+i*.19)%1,spread=(i%2?1:-1)*(.32+(i%3)*.23),back=.8+phase*1.1;
   sprite.position.copy(this.bunny.position).addScaledVector(this.fxRight,-dx*back-dy*spread).addScaledVector(this.fxUp,.42-dy*back+dx*spread).addScaledVector(this.fxToward,-.85);
   sprite.material.rotation=angle;sprite.material.opacity=intensity*(1-phase)*.70;
   sprite.scale.set(1.0+phase*.9,.12+(i%3)*.025,1);
  }
 }
 resetBall(piece){const spec=piece.ballSpec;this.ballState={id:piece.id,time:spec.delay||0,position:new T.Vector3(...spec.position),velocity:new T.Vector3(...spec.velocity),lastCollision:''};this.previousBody.copy(this.bunny.position)}
 buildCollisionSurface(){
  // Spatial cells hold triangles of the actual skinned mesh. This is a broad
  // phase only: the contact itself is measured against deformed triangles.
  const geo=this.ears.mesh.geometry,xyz=geo.attributes.position.array,idx=geo.index.array,map=new Map(),size=.12;
  for(let i=0;i<idx.length;i+=3){
   const a=idx[i],b=idx[i+1],c=idx[i+2],x=(xyz[a*3]+xyz[b*3]+xyz[c*3])/3,y=(xyz[a*3+1]+xyz[b*3+1]+xyz[c*3+1])/3,z=(xyz[a*3+2]+xyz[b*3+2]+xyz[c*3+2])/3;
   const key=[Math.floor(x/size),Math.floor(y/size),Math.floor(z/size)].join(',');let cell=map.get(key);
   if(!cell){cell={index:a,triangles:[],position:new T.Vector3(),previous:new T.Vector3(),velocity:new T.Vector3()};map.set(key,cell)}
   cell.triangles.push(a,b,c);
  }
  this.surfaceCells=[...map.values()];this.surfaceXYZ=new Float32Array(xyz.length);this.surfaceStamp=new Int32Array(xyz.length/3);this.stamp=0;
  this.triangle=new T.Triangle();this.trianglePoint=new T.Vector3();this.bestPoint=new T.Vector3();this.bestNormal=new T.Vector3();this.bestVelocity=new T.Vector3();this.surfaceTemp=new T.Vector3();this.lastBallPosition=new T.Vector3();
 }
 updateCollisionSurface(dt,reset){
  this.stamp++;const mesh=this.ears.mesh;
  for(const cell of this.surfaceCells){
   cell.previous.copy(cell.position);this.ears.getSkinnedVertex(cell.index,cell.position).applyMatrix4(mesh.matrixWorld);
   if(reset||dt<=0)cell.velocity.set(0,0,0);else cell.velocity.copy(cell.position).sub(cell.previous).multiplyScalar(1/dt).clampLength(0,18);
  }
 }
 surfaceVertex(index,target){
  const k=index*3;if(this.surfaceStamp[index]!==this.stamp){
   this.ears.getSkinnedVertex(index,this.surfaceTemp).applyMatrix4(this.ears.mesh.matrixWorld);
   this.surfaceXYZ[k]=this.surfaceTemp.x;this.surfaceXYZ[k+1]=this.surfaceTemp.y;this.surfaceXYZ[k+2]=this.surfaceTemp.z;this.surfaceStamp[index]=this.stamp;
  }
  return target.set(this.surfaceXYZ[k],this.surfaceXYZ[k+1],this.surfaceXYZ[k+2]);
 }
 resolveBall(position,velocity,dt){
  const radius=.36,scale=Math.max(this.bunny.scale.x,this.bunny.scale.y,this.bunny.scale.z),broad=(radius+.23*scale)**2;
  let best=radius*radius,kind='',found=false;const tri=this.triangle,rest=this.ears.rest;
  for(const cell of this.surfaceCells){
   if(cell.position.distanceToSquared(position)>broad)continue;
   const ids=cell.triangles;
   for(let i=0;i<ids.length;i+=3){
    this.surfaceVertex(ids[i],tri.a);this.surfaceVertex(ids[i+1],tri.b);this.surfaceVertex(ids[i+2],tri.c);
    tri.closestPointToPoint(position,this.trianglePoint);const d=position.distanceToSquared(this.trianglePoint);
    if(d<best){best=d;found=true;this.bestPoint.copy(this.trianglePoint);this.bestVelocity.copy(cell.velocity);tri.getNormal(this.bestNormal);
     const midY=(rest[ids[i]*3+1]+rest[ids[i+1]*3+1]+rest[ids[i+2]*3+1])/3,midX=(rest[ids[i]*3]+rest[ids[i+1]*3]+rest[ids[i+2]*3])/3;kind=midY>.72&&Math.abs(midX)>.22?'ear':'head';}
   }
  }
  if(!found)return '';
  // The surface normal resolves accidental deep contact outward; otherwise the
  // vector from the closest point to the centre yields an exact sphere contact.
  this.normal.copy(position).sub(this.bestPoint);const distance=Math.sqrt(best);
  if(distance>1e-7){this.normal.multiplyScalar(1/distance);if(this.normal.dot(this.bestNormal)<0)this.normal.copy(this.bestNormal)}else this.normal.copy(this.bestNormal);
  position.copy(this.bestPoint).addScaledVector(this.normal,radius+.001);
  if(velocity){const incoming=this.tmp.copy(velocity).sub(this.bestVelocity).dot(this.normal);if(incoming<0)velocity.addScaledVector(this.normal,-1.78*incoming)}
  return kind;
 }
 update(piece,time,pose){
  const kind=piece.fx||'',changed=piece.id!==this.lastPiece||time<this.lastTime;this.lastPiece=piece.id;this.lastTime=time;this.lastKind=kind;
  this.ball.visible=kind==='ball'&&time>=(piece.ballSpec?.delay||0);this.snow.visible=kind==='snow';if(!this.ball.visible)this.activeBallId=null;
  const countdownEnd=piece.countdown?(piece.flights[0]?.from*piece.duration||2):0;
  const fireTime=Math.max(0,time-countdownEnd),showFireworks=kind==='fireworks'&&(!piece.countdown||time>=countdownEnd);
  this.sparks.visible=showFireworks;this.rays.visible=showFireworks;
  this.digit.visible=!!piece.countdown&&time<countdownEnd;
  if(this.digit.visible){const part=Math.min(2,Math.floor(time/(countdownEnd/3))),digit=3-part,segments={3:[0,1,2,3,6],2:[0,1,3,4,6],1:[1,2]}[digit];this.digitSegments.forEach((m,i)=>m.visible=segments.includes(i));this.digit.position.x=digit===1?1.37:1.65;const progress=(time%(countdownEnd/3))/(countdownEnd/3),s=.74+.18*Math.sin(Math.PI*progress);this.digit.scale.setScalar(s)}
  if(this.ball.visible){
   const justAppeared=changed||this.activeBallId!==piece.id;this.activeBallId=piece.id;
   const surfaceDt=justAppeared?0:Math.max(0,Math.min(.08,time-(this.previousSurfaceTime??time)));this.updateCollisionSurface(surfaceDt,justAppeared);this.previousSurfaceTime=time;
   this.bunny.getWorldPosition(this.bodyCenter);
   if(piece.ballSpec){
    if(justAppeared||!this.ballState||this.ballState.id!==piece.id)this.resetBall(piece);
    const state=this.ballState,delta=Math.max(0,Math.min(.08,time-state.time));
    this.bodyVelocity.copy(this.bodyCenter).sub(this.previousBody).multiplyScalar(delta>1e-5?1/delta:0);this.previousBody.copy(this.bodyCenter);
    const count=Math.max(1,Math.ceil(delta*120)),h=delta/count;
    for(let step=0;step<count;step++){
     state.velocity.y-=6*h;state.position.addScaledVector(state.velocity,h);
     if(state.position.y<-.53){state.position.y=-.53;if(state.velocity.y<-.18)state.velocity.y=-state.velocity.y*(piece.ballSpec.restitution??.68);else state.velocity.y=0;state.velocity.x*=Math.exp(-.15*h);state.velocity.z*=Math.exp(-.15*h)}
     for(let pass=0;pass<2;pass++){const hit=this.resolveBall(state.position,state.velocity,h);if(!hit)break;if(state.impactTime==null){state.impactTime=time;state.firstImpact=hit}state.lastCollision=hit}
    }
    state.time=time;this.ball.position.copy(state.position);
   }else{
    this.ball.position.set(pose.bx,Math.max(-.53,pose.by),pose.bz);
    for(let pass=0;pass<2;pass++)if(!this.resolveBall(this.ball.position,null,0))break;
   }
   if(justAppeared)this.lastBallPosition.copy(this.ball.position);else{const dx=this.ball.position.x-this.lastBallPosition.x,dz=this.ball.position.z-this.lastBallPosition.z;this.ball.rotation.z-=dx/.36;this.ball.rotation.x+=dz/.36;this.lastBallPosition.copy(this.ball.position)}
  }
  if(this.snow.visible){
   for(let layer=0;layer<this.snowLayers.length;layer++){
    const {points,count,depth}=this.snowLayers[layer],array=points.geometry.attributes.position.array;
    for(let i=0;i<count;i++){
     const seed=(i*71+layer*19)%count,phase=(seed/count*5.2+time*(.48+layer*.12+(i%4)*.04))%5.2;
     array[i*3]=((i*89+layer*37)%199)/199*6.5-3.25+Math.sin(time*.65+i*1.7)*(.08+layer*.045);
     array[i*3+1]=3.9-phase;array[i*3+2]=depth+Math.sin(i*13.3)*.35;
    }
    points.geometry.attributes.position.needsUpdate=true;
   }
  }
  if(this.camera){this.camera.updateMatrixWorld();this.fxRight.set(1,0,0).applyQuaternion(this.camera.quaternion);this.fxUp.set(0,1,0).applyQuaternion(this.camera.quaternion);this.fxToward.set(0,0,1).applyQuaternion(this.camera.quaternion)}
  const effect=piece.vfx||'',strength=effect==='fire'?(pose.fire||0):effect==='ice'?(pose.frost||0):effect==='anger'?(pose.angry||0):effect==='love'?Math.max(pose.heart||0,(pose.blush||0)*.8):effect==='spark'?Math.max(pose.star||0,(pose.joy||0)*.8,(pose.wide||0)*.55):effect==='shock'?(pose.wide||0):effect==='speed'?Math.max(pose.flash||0,Math.abs(pose.step||0)*.7,Math.abs(pose.z||0)/5):0;
  const intensity=Math.max(0,Math.min(1,strength*1.6));this.accents.visible=!!effect&&effect!=='fire'&&intensity>.02;this.accents.material.opacity=.34*intensity;
  if(this.accents.visible){
   const positions=this.accents.geometry.attributes.position.array,colors=this.accents.geometry.attributes.color.array,alphas=this.accents.geometry.attributes.particleAlpha.array;
   const palette=effect==='fire'?[0xffd450,0xff7528,0xff425c,0xffeb86]:effect==='ice'?[0xb5efff,0x70bdff,0xffffff,0xc9d5ff]:effect==='anger'?[0xff633f,0xffbb50]:effect==='love'?[0xff5a91,0xffb5c7]:effect==='shock'?[0x84ccff,0xffed8a]:[0xffdb56,0xf892f0,0x76d9fa];
   for(let i=0;i<84;i++){
    const seed=(i*29)%84,cycle=(time*(effect==='anger'||effect==='fire'?2.7:1.5)+seed/84)%1,angle=i*2.399;
    const radius=.85+cycle*(effect==='anger'||effect==='fire'?1.35:.95),side=Math.cos(angle),vertical=Math.sin(angle);
    const active=i<28&&cycle<.76;positions[i*3]=active?this.bunny.position.x+(effect==='anger'?(i%2?1:-1)*(.9+.16*cycle):side*radius):100;
    positions[i*3+1]=active?this.bunny.position.y+(effect==='anger'?1.35+cycle*.85:.70+vertical*radius*.85):100;
    positions[i*3+2]=this.bunny.position.z-.15+(i%3)*.28;
    this.accentColor.setHex(palette[i%palette.length]);const fade=Math.sin(Math.PI*Math.min(1,cycle/.76));
    alphas[i]=active?fade:0;colors[i*3]=this.accentColor.r*(.55+.45*fade);colors[i*3+1]=this.accentColor.g*(.55+.45*fade);colors[i*3+2]=this.accentColor.b*(.55+.45*fade);
   }
   this.accents.geometry.attributes.position.needsUpdate=true;this.accents.geometry.attributes.color.needsUpdate=true;this.accents.geometry.attributes.particleAlpha.needsUpdate=true;
  }
  this.glow.visible=intensity>.02&&(effect==='love'||effect==='spark'||effect==='fire'||effect==='ice');
  if(this.glow.visible){this.glow.position.set(this.bunny.position.x,this.bunny.position.y+.65,this.bunny.position.z-1.1);this.glow.material.color.setHex(effect==='love'?0xff8bb8:effect==='fire'?0xff6a24:effect==='ice'?0x83cfff:0xffd36b);this.glow.material.opacity=(effect==='fire'?.10:.15)*intensity}
  this.streaks.visible=intensity>.02&&effect==='shock';this.streaks.material.opacity=.65*intensity;
  if(this.streaks.visible){
   this.streaks.material.color.setHex(effect==='anger'||effect==='fire'?0xff7d4d:effect==='shock'?0xffdd78:0x94d9ff);
   const line=this.streaks.geometry.attributes.position.array;
   for(let i=0;i<12;i++){
    const cycle=(time*2.2+i/12)%1,angle=i*Math.PI/6,r=.95+cycle*.45,length=.15+.20*(1-cycle),k=i*6;
    const dx=effect==='speed'?(i%2?1:-1):Math.cos(angle),dy=effect==='speed'?0:Math.sin(angle);
    const x=this.bunny.position.x+Math.cos(angle)*r,y=this.bunny.position.y+.72+Math.sin(angle)*r*.80,z=this.bunny.position.z-.15;
    line[k]=x;line[k+1]=y;line[k+2]=z;line[k+3]=x+dx*length;line[k+4]=y+dy*length;line[k+5]=z;
   }
   this.streaks.geometry.attributes.position.needsUpdate=true;
  }
  this.updateMotifs(effect,intensity,time);this.updateSpeed(effect,intensity,time,changed);this.updateComic(piece,time,pose,countdownEnd);this.updateIdea(piece,time);
  const clap=Math.max(0,Math.min(1,((pose.earClap||0)-.82)/.18));this.clapFlash.visible=clap>.01;
  if(this.clapFlash.visible){this.ears.boneChains[0][2].getWorldPosition(this.boneA);this.ears.boneChains[1][2].getWorldPosition(this.boneB);this.clapFlash.position.copy(this.boneA).add(this.boneB).multiplyScalar(.5);this.clapFlash.material.opacity=.85*clap;this.clapFlash.scale.setScalar(.35+.35*clap)}
  this.updateFire(piece,time,pose,changed);
  const frost=Math.max(0,Math.min(1,pose.frost||0));this.ice.visible=effect==='ice'&&frost>.02;this.iceSurface.material.opacity=.25*frost;this.iceEdges.material.opacity=.45*frost;this.iceCracks.material.opacity=.35*frost;if(this.iceFractureMaterial)this.iceFractureMaterial.opacity=.94*frost;
  for(const tear of this.tears){const amount=Math.max(0,Math.min(1,pose.cry||0));tear.visible=amount>.01;if(tear.visible){const y=-.28-((time*.35)% .20);tear.position.set(tear.userData.side*.39,y,.96);tear.scale.set(.055*amount,.095*amount,.035)}}
  const flash=Math.max(0,Math.min(1,pose.flash||0));this.portal.visible=flash>.01;if(this.portal.visible){this.portal.position.set(this.bunny.position.x,this.bunny.position.y+.55,this.bunny.position.z+.9);this.portal.scale.setScalar(.8+.3*flash);this.portal.material.opacity=.55*flash}
  if(showFireworks){const a=this.sparks.geometry.attributes.position.array,alpha=this.sparks.geometry.attributes.particleAlpha.array,ray=this.rays.geometry.attributes.position.array,rayColor=this.rays.geometry.attributes.color.array;
   const palette=[0xff527d,0xffc038,0x56cceb,0xd478fb];
   for(let i=0;i<224;i++){
    const burst=Math.floor(i/28),j=i%28,phase=(fireTime*.65+burst*.13)%1,life=phase/.72,active=life<1;
    const angle=(j/28)*Math.PI*2+burst*.37+Math.sin(j*5.17+burst)*.055;
    const radius=active?(.10+1.60*(1-Math.exp(-3.8*life))*(.82+((j*37)%17)/50)):0,cx=(burst%4-1.5)*1.35,cy=1.65+Math.floor(burst/4);
    const fade=active?Math.min(1,life*8)*Math.pow(1-life,1.35):0,k=i*3;
    alpha[i]=fade;a[k]=active?cx+Math.cos(angle)*radius:100;a[k+1]=active?cy+Math.sin(angle)*radius-life*life*.46:100;a[k+2]=-.5+Math.sin(j*2.7)*.35;
    const q=i*6,tail=.18*(1-life);ray[q]=a[k];ray[q+1]=a[k+1];ray[q+2]=a[k+2];ray[q+3]=active?a[k]-Math.cos(angle)*tail:100;ray[q+4]=active?a[k+1]-Math.sin(angle)*tail:100;ray[q+5]=a[k+2];
    this.accentColor.setHex(palette[i%4]);for(let t=0;t<2;t++){rayColor[q+t*3]=this.accentColor.r*fade;rayColor[q+t*3+1]=this.accentColor.g*fade;rayColor[q+t*3+2]=this.accentColor.b*fade}
   }
   this.sparks.geometry.attributes.position.needsUpdate=true;this.sparks.geometry.attributes.particleAlpha.needsUpdate=true;this.rays.geometry.attributes.position.needsUpdate=true;this.rays.geometry.attributes.color.needsUpdate=true;
  }
 }
}
export { StageEffects };
