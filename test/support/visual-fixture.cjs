'use strict';
const {VisualSession}=require('../../src/main/visual-session');
const encode=image=>Buffer.from(JSON.stringify({...image,data:[...image.data]}));
const bitmap=bytes=>{const image=JSON.parse(bytes.toString());return {...image,data:Uint8Array.from(image.data)};};
function raster(width=200,height=120){const data=new Uint8Array(width*height*4);for(let i=0;i<data.length;i+=4)data.set([90,120,170,255],i);return {width,height,data};}
function crop(bytes,r){const a=bitmap(bytes),data=new Uint8Array(r.width*r.height*4);for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++)data.set(a.data.subarray(((y+r.y)*a.width+x+r.x)*4,((y+r.y)*a.width+x+r.x)*4+4),(y*r.width+x)*4);return encode({width:r.width,height:r.height,data});}
function paint(image,r,value=250){for(let y=Math.floor(r.y*image.height);y<Math.ceil((r.y+r.height)*image.height);y++)for(let x=Math.floor(r.x*image.width);x<Math.ceil((r.x+r.width)*image.width);x++)image.data[(y*image.width+x)*4]=value;}
function fixture(options={}){
 let now=100000, image=raster(),location={software:'Demo',available:true,unique:true,active:true,sameIdentity:true,confidence:.71,region:{x:.1,y:.1,width:.8,height:.8},mainRegion:{x:.1,y:.1,width:.8,height:.8},monitorRegions:[{x:.1,y:.1,width:.8,height:.5}],identityRegion:{x:.2,y:.12,width:.3,height:.15},focusRegion:{x:.2,y:.65,width:.4,height:.15},focusEvidence:'可见输入光标',evidence:'目标文档标题及当前身份唯一可见',texts:[]};const calls=[],requests=[];
 const native={request:async(op,args)=>{calls.push({op,args});if(op==='displayCapture'){await options.beforeCapture?.();return {pngBase64:encode(image).toString('base64'),width:image.width,height:image.height,desktopRect:{x:0,y:0,width:image.width,height:image.height},backend:'CGDisplayStream',capturedAt:now};}if(op==='displayInput'){await options.onInput?.();return {performed:true};}throw Error('Forbidden native operation: '+op);}};
 const request=async opts=>{requests.push(opts);await options.beforeModel?.();return {response:{text:JSON.stringify(location)}};};
 const args={native,bitmap,imageCrop:crop,request,clock:()=>now,...options};delete args.beforeCapture;delete args.beforeModel;delete args.onInput;
 const visual=new VisualSession(args);
 return {visual,native,calls,requests,bitmap,encode,crop,paint,get image(){return image;},set image(v){image=v;},get location(){return location;},set location(v){location=v;},advance(ms){now+=ms;}};
}
module.exports={fixture,raster,bitmap,crop,encode,paint};
