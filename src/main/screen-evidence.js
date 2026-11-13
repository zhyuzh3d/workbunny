'use strict';
// Bounded comparison of the actual target, excluding unrelated screen changes.
function sameTargetRegion(bitmap,first,second,row,maxChangedRatio=.015){
  if(typeof bitmap!=='function')return false;
  try{
    const a=bitmap(Buffer.from(first.pngBase64,'base64')),b=bitmap(Buffer.from(second.pngBase64,'base64'));
    if(!a?.data||!b?.data||a.width!==b.width||a.height!==b.height||!a.width||!a.height||
       a.data.length<a.width*a.height*4||b.data.length<b.width*b.height*4)return false;
    const cx=row.x+(row.width||0)/2,cy=row.y+(row.height||0)/2;
    if(!Number.isFinite(cx)||!Number.isFinite(cy)||cx<0||cx>=1||cy<0||cy>=1)return false;
    const halfW=Math.max((row.width||0)/2,.035),halfH=Math.max((row.height||0)/2,.014);
    const x0=Math.max(0,Math.floor((cx-halfW)*a.width)),x1=Math.min(a.width,Math.ceil((cx+halfW)*a.width));
    const y0=Math.max(0,Math.floor((cy-halfH)*a.height)),y1=Math.min(a.height,Math.ceil((cy+halfH)*a.height));
    let changed=0,total=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const i=(y*a.width+x)*4;total++;
      if(Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]))>24)changed++;
    }
    return total>=20&&changed/total<maxChangedRatio;
  }catch{return false;}
}
// A delayed click depends on its target and the window heading, rather than
// clocks or activity elsewhere. Keyboard input still depends on focus.
function sameActionTarget(bitmap,first,second,action,anchor){
  if(first.preview===second.preview)return true;
  if(!['click','scroll'].includes(action.action))return false;
  let row;
  if(action.label){
    try{const point=require('./screen-action-tools').labelTarget(action.label,anchor.ocr||[]);row={x:point.x,y:point.y};}catch{return false;}
  }else row={x:action.pixelX/first.width,y:action.pixelY/first.height};
  const frame=shot=>({pngBase64:String(shot.preview||'').split(',')[1]||''});
  return sameTargetRegion(bitmap,frame(first),frame(second),row)&&
    sameTargetRegion(bitmap,frame(first),frame(second),{x:.1,y:0,width:.8,height:.13},.001);
}
// Change detection, not semantic recognition. Regions come from a visual
// model; a few changed pixels in a small status area must not disappear in a
// whole-screen percentage. Overlapping regions count each pixel only once.
function regionsChanged(bitmap,first,second,regions,minChangedPixels=3){
 try{
  const a=bitmap(Buffer.from(first.pngBase64,'base64')),b=bitmap(Buffer.from(second.pngBase64,'base64'));
  if(!a?.data||!b?.data||a.width!==b.width||a.height!==b.height||a.data.length<a.width*a.height*4||b.data.length<b.width*b.height*4)return true;
  const seen=new Uint8Array(a.width*a.height);let changed=0;
  for(const r of regions){if(!r||!['x','y','width','height'].every(k=>Number.isFinite(r[k]))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1||r.y+r.height>1)return true;
   for(let y=Math.floor(r.y*a.height);y<Math.ceil((r.y+r.height)*a.height);y++)for(let x=Math.floor(r.x*a.width);x<Math.ceil((r.x+r.width)*a.width);x++){
    const pixel=y*a.width+x;if(seen[pixel])continue;seen[pixel]=1;const i=pixel*4;
    if(Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]))>24&&++changed>=minChangedPixels)return true;
   }
  }return false;
 }catch{return true;}
}
// Facts about already captured images, never a business-success predicate.
// Compare the common screen area so a new estimated crop is not a new event.
function alignedChangeFacts(bitmap,before,after){
 const valid=r=>r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0;
 const geometry=s=>({rect:s?.rect,pixelRect:s?.pixelRect||s?.rect,capturedAt:s?.capturedAt??s?.at,frameId:s?.visualFrameId||s?.frameId});
 const result={schema:'bunny.image-comparison/v1',before:geometry(before),current:geometry(after),available:false,interpretation:'像素变化只描述已有两图的共同屏幕区域，不证明业务成功、失败或身份改变；结合原目标、实际内容与反例自主判断。'};
 try{
  const aRect=before?.pixelRect||before?.rect,bRect=after?.pixelRect||after?.rect;if(typeof bitmap!=='function'||!valid(aRect)||!valid(bRect))return {...result,reason:'missing-pixels-or-screen-rect'};
  if(before.sourceRect&&after.sourceRect&&JSON.stringify(before.sourceRect)!==JSON.stringify(after.sourceRect))return {...result,reason:'display-geometry-changed'};
  const decode=s=>bitmap(s.sourcePixels||Buffer.from(String(s.preview||'').split(',')[1]||'','base64')),a=decode(before),b=decode(after);
  if(!a?.data||!b?.data||!a.width||!a.height||!b.width||!b.height)return {...result,reason:'pixels-unavailable'};
  const x=Math.max(aRect.x,bRect.x),y=Math.max(aRect.y,bRect.y),right=Math.min(aRect.x+aRect.width,bRect.x+bRect.width),bottom=Math.min(aRect.y+aRect.height,bRect.y+bRect.height);
  if(right<=x||bottom<=y)return {...result,reason:'no-screen-overlap'};
  const step=Math.max(1,Math.ceil(Math.sqrt((right-x)*(bottom-y)/200000)));let samples=0,changed=0;
  for(let sy=y+.5;sy<bottom;sy+=step)for(let sx=x+.5;sx<right;sx+=step){
   const index=(r,img)=>(Math.min(img.height-1,Math.floor((sy-r.y)*img.height/r.height))*img.width+Math.min(img.width-1,Math.floor((sx-r.x)*img.width/r.width)))*4,ai=index(aRect,a),bi=index(bRect,b);
   if(ai+2>=a.data.length||bi+2>=b.data.length)return {...result,reason:'pixels-unavailable'};samples++;
   if(Math.max(...[0,1,2].map(c=>Math.abs(a.data[ai+c]-b.data[bi+c])))>24)changed++;
  }
  return {...result,available:true,method:before.sourcePixels&&after.sourcePixels?'captured-pixel-samples':'preview-pixel-samples',overlap:{x,y,width:right-x,height:bottom-y},cropChanged:JSON.stringify(aRect)!==JSON.stringify(bRect),sampleStep:step,sampledPixels:samples,changedPixels:changed,changedRatio:samples?changed/samples:null};
 }catch{return {...result,reason:'pixels-unavailable'};}
}
module.exports={sameTargetRegion,sameActionTarget,regionsChanged,alignedChangeFacts};
