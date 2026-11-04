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
module.exports={sameTargetRegion,sameActionTarget};
