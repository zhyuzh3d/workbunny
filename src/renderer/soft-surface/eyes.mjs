/* Pupil-free black eyelids: capsule at rest, continuously sculpted by emotion. */
import * as T from 'three';
class SurfaceEyes {
 constructor(group,black,rim){
  this.items=[];
  for(const side of [-1,1]){
   const root=new T.Group();group.add(root);
   const item={side,root,width:.105,height:.205,arch:0,slope:0,gaze:0,y:-.025,shape:3.2,meshes:[]};
   for(const material of [rim,black]){
    const rings=8,steps=64,positions=new Float32Array((rings+1)*(steps+1)*3),indices=[];
    for(let r=0;r<rings;r++)for(let j=0;j<steps;j++){
     const a=r*(steps+1)+j,b=a+steps+1;indices.push(a,b,a+1,b,b+1,a+1);
    }
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(positions,3));geo.setIndex(indices);
    const mesh=new T.Mesh(geo,material);root.add(mesh);item.meshes.push({mesh,rings,steps});
   }
   this.items.push(item);
  }
 }
 update(_mood,_t,dt,expression={}){
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  for(const e of this.items){
   const side=e.side,heart=clamp(expression.heart||0,0,1),star=clamp(expression.star||0,0,1),diamond=clamp(expression.diamond||0,0,1),special=Math.max(heart,star,diamond),joy=clamp(expression.joy||0,0,1)*(1-.75*special),angry=clamp(expression.angry||0,0,1),sad=clamp(expression.sad||0,0,1),sleepy=clamp(expression.sleepy||0,0,1),wide=clamp(expression.wide||0,0,1);
   let width=.108+.075*wide,height=.210+.095*wide,arch=0,slope=0,shape=3.2-1.2*wide;
   height*=1-.78*joy;arch+=.125*joy;width+=.055*joy;shape-=.8*joy;
   // Laughing is not a static smile: the lids pulse slightly out of phase
   // while the head performs the larger chuckle beats.
   const laughter=clamp(expression.laughter||0,0,1),pulse=Math.sin(_t*Math.PI*7.2+(side<0?0:.16));
   height*=1+laughter*.22*pulse;arch+=laughter*.018*pulse;width+=laughter*.008*pulse;
   height*=1-.52*angry;slope+=side*.13*angry;arch-=.018*angry;width+=.02*angry;
   height*=1-.40*sad;slope-=side*.065*sad;arch-=.060*sad;width+=.01*sad;
   height*=1-.78*sleepy;arch-=.025*sleepy;
   width=width*(1-special)+.16*special;height=height*(1-special)+.18*special;
   const wink=clamp(side<0?(expression.wl||0):(expression.wr||0),0,1);height*=1-.94*wink;
   const gaze=clamp((expression.gx||0)*.42,-.09,.09),y=-.025+clamp((expression.gy||0)*.30,-.065,.065);
   for(const [key,val] of Object.entries({width,height,arch,slope,gaze,y,shape})){const closing=key==='height'&&val<e[key];const rate=closing?40:(key==='gaze'||key==='y'?34:27);e[key]+=(val-e[key])*(1-Math.exp(-dt*rate));}
   e.root.position.set(side*.38+e.gaze,e.y,.96);
   for(let m=0;m<e.meshes.length;m++){
    const {mesh,rings,steps}=e.meshes[m],a=mesh.geometry.attributes.position.array;
    const scale=m===0?1.28:1,zOffset=m===0?.002:.014;
    for(let r=0;r<=rings;r++)for(let j=0;j<=steps;j++){
     const u=r/rings,angle=j/steps*Math.PI*2,rawC=Math.cos(angle),rawS=Math.sin(angle),power=2/e.shape;
     let c=Math.sign(rawC)*Math.pow(Math.abs(rawC),power),sn=Math.sign(rawS)*Math.pow(Math.abs(rawS),power);
     if(star>0){const rad=.76+.24*Math.cos(5*angle);c=c*(1-star)+rawC*rad*star;sn=sn*(1-star)+rawS*rad*star}
     if(diamond>0){const norm=Math.max(.001,Math.abs(rawC)+Math.abs(rawS));c=c*(1-diamond)+(rawC/norm)*diamond;sn=sn*(1-diamond)+(rawS/norm)*diamond}
     if(heart>0){const phi=Math.PI/2-angle,hx=Math.pow(Math.sin(phi),3),hy=(13*Math.cos(phi)-5*Math.cos(2*phi)-2*Math.cos(3*phi)-Math.cos(4*phi))/17;c=c*(1-heart)+hx*heart;sn=sn*(1-heart)+hy*heart}
     const x=e.width*scale*u*c;
     const yy=e.arch*scale*(1-u*u*c*c)+e.slope*scale*u*c+e.height*scale*u*sn+(expression.wavy||0)*.05*Math.sin(2*Math.PI*u*c-_t*7)*u;
     const gx=e.root.position.x+x,gy=e.root.position.y+yy,p=2.25,fw=1.10*(1-.11*clamp(gy,-1,1));
     const z=.98*Math.pow(Math.max(.02,1-Math.pow(Math.abs(gx/fw),p)-Math.pow(Math.abs(gy/.91),p)),1/p);
     const bulge=.009*Math.sqrt(Math.max(0,1-u*u)),k=(r*(steps+1)+j)*3;
     a[k]=x;a[k+1]=yy;a[k+2]=z-.96+zOffset+bulge;
    }
    mesh.geometry.attributes.position.needsUpdate=true;mesh.geometry.computeVertexNormals();
   }
  }
 }
}
export { SurfaceEyes };
