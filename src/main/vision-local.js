'use strict';
function bubbleDirection(image,row){
  if(!image)return null;const {data,width,height}=image;
  let gray=0,green=0,total=0;
  const x0=Math.max(0,Math.floor(row.x*width)),x1=Math.min(width,Math.ceil((row.x+row.width)*width));
  const y0=Math.max(0,Math.floor(row.y*height)),y1=Math.min(height,Math.ceil((row.y+row.height)*height));
  for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const i=(y*width+x)*4,b=data[i],g=data[i+1],r=data[i+2];total++;
    if(g>135&&g-r>30&&g-b>45)green++;
    if(Math.max(r,g,b)-Math.min(r,g,b)<7&&r>=210&&r<=245)gray++;
  }
  return total>=10&&green/total>.4?'outgoing':total>=10&&gray/total>.45?'incoming':null;
}
function refineReceipt(action,shot,message,bitmap){
 const receipt=action?.receipt;if(!bitmap||action.action!=='done'||!action.completed||!receipt?.outgoing||!receipt.newBubble||!receipt.composerEmpty)return action;
 const norm=s=>String(s||'').normalize('NFKC').replace(/\s/gu,'');
 if(norm(receipt.text)!==norm(message))return action;
 const expected=norm(message),rows=(shot.ocr||[]).filter(r=>r.confidence>=.65&&r.x>.32&&r.y>.09&&r.y+r.height<receipt.composer.y&&r.width>0&&r.height>0).sort((a,b)=>a.y-b.y||a.x-b.x);
 const matches=[];
 for(let start=0;start<rows.length;start++){let joined='',part=[];
  for(let end=start;end<Math.min(rows.length,start+16);end++){
   const row=rows[end];if(end>start&&row.y-rows[end-1].y>.065)break;
   joined+=norm(row.text);part.push(row);if(joined===expected){matches.push(part);break;}if(!expected.startsWith(joined))break;
  }
 }
 const image=bitmap(Buffer.from(shot.preview.split(',')[1],'base64')),old=receipt.bubble;
 if(matches.length===1){const part=matches[0];
  if(part.every(row=>bubbleDirection(image,row)==='outgoing')){
   const x=Math.min(...part.map(r=>r.x)),y=Math.min(...part.map(r=>r.y)),right=Math.max(...part.map(r=>r.x+r.width)),bottom=Math.max(...part.map(r=>r.y+r.height));
   if(Math.abs(y+((bottom-y)/2)-(old.y+old.height/2))<=.15)return {...action,receipt:{...receipt,bubble:{x,y,width:right-x,height:bottom-y},localGeometryVerified:true}};
  }
 }
 // OCR can misread a single punctuation mark in a long paragraph. It need not
 // transcribe the whole paragraph a second time to locate its pixel component:
 // the model's exact full text / before-after new-bubble proof remain mandatory.
 const candidates=outgoingComponents(image,receipt.composer.y).filter(rect=>Math.abs(rect.y+rect.height/2-(old.y+old.height/2))<=.15&&rows.some(row=>{
  const line=norm(row.text);return line.length>=Math.min(12,expected.length)&&expected.includes(line)&&row.x>=rect.x-.01&&row.x+row.width<=rect.x+rect.width+.01&&row.y>=rect.y-.01&&row.y+row.height<=rect.y+rect.height+.01;
 }));
 if(candidates.length!==1)return action;
 return {...action,receipt:{...receipt,bubble:candidates[0],localGeometryVerified:true,pixelGeometryVerified:true}};
}
function outgoingComponents(image,bottom){
 const {data,width,height}=image,step=2,x0=Math.floor(width*.32),y0=Math.floor(height*.09),w=Math.floor((width*.985-x0)/step),h=Math.floor((Math.min(bottom,.87)*height-y0)/step);
 if(w<1||h<1)return [];const mask=new Uint8Array(w*h),rects=[];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((y0+y*step)*width+x0+x*step)*4,b=data[i],g=data[i+1],r=data[i+2];if(g>135&&g-r>30&&g-b>45)mask[y*w+x]=1;}
 for(let at=0;at<mask.length;at++){if(mask[at]!==1)continue;const queue=[at];mask[at]=2;let minX=w,maxX=0,minY=h,maxY=0;
  for(let n=0;n<queue.length;n++){const p=queue[n],x=p%w,y=Math.floor(p/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
   for(const next of[x>0?p-1:-1,x+1<w?p+1:-1,y>0?p-w:-1,y+1<h?p+w:-1])if(next>=0&&mask[next]===1){mask[next]=2;queue.push(next);}
  }
  const rw=maxX-minX+1,rh=maxY-minY+1;if(queue.length<64||rw*step<28||rh*step<14||queue.length/(rw*rh)<.4)continue;
  rects.push({x:(x0+minX*step)/width,y:(y0+minY*step)/height,width:rw*step/width,height:rh*step/height});
 }return rects;
}
module.exports={bubbleDirection,refineReceipt,outgoingComponents};
