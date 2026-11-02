'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {bubbleDirection,checkVisibleCopies}=require('../src/main/wechat-observer');
const {refineReceipt}=require('../src/main/vision-local');
const {validateWechatAction}=require('../src/main/desktop-service');
test('local bubble evidence distinguishes incoming gray, outgoing green and plain conversation background',()=>{
 const row={x:.4,y:.4,width:.4,height:.2},image={width:100,height:100,data:Buffer.alloc(40000)};
 const fill=(r,g,b)=>{for(let i=0;i<image.data.length;i+=4){image.data[i]=b;image.data[i+1]=g;image.data[i+2]=r;image.data[i+3]=255;}};
 fill(239,239,239);assert.equal(bubbleDirection(image,row),'incoming');fill(153,238,105);assert.equal(bubbleDirection(image,row),'outgoing');fill(248,248,248);assert.equal(bubbleDirection(image,row),null);
});
test('visible repeated bubbles cannot be silently collapsed, while OCR language duplicates count once',()=>{
 const rows=[.3,.3,.46,.46,.62].map(y=>({x:.4,y,text:'Bunny R1 project',confidence:.99}));
 assert.throws(()=>checkVisibleCopies([{text:'Bunny R1 project continues'}],rows),/3条/);
 checkVisibleCopies(Array.from({length:3},()=>({text:'Bunny R1 project continues'})),rows);
 checkVisibleCopies([{text:'A unique project instruction'}],rows);
});
test('coarse receipt geometry is refined only from a unique complete OCR text on outgoing pixels',()=>{
 const image={width:100,height:100,data:Buffer.alloc(40000)},fill=(r,g,b)=>{for(let i=0;i<40000;i+=4){image.data[i]=b;image.data[i+1]=g;image.data[i+2]=r;image.data[i+3]=255;}};
 fill(153,238,105);
 const shot={at:2,preview:'data:image/png;base64,eA==',ocr:[{text:'Alice',x:.4,y:.04,width:.1,height:.02,confidence:.99},
 {text:'demo project',x:.5,y:.7,width:.4,height:.03,confidence:.99},{text:'done',x:.5,y:.74,width:.1,height:.03,confidence:.99}]};
 const action={action:'done',completed:true,receipt:{outgoing:true,newBubble:true,composerEmpty:true,text:'demo project done',bubble:{x:.45,y:.76,width:.47,height:.07},composer:{x:.31,y:.83,width:.66,height:.09}}};
 const task={operation:'send',recipient:'Alice',message:'demo project done',submitAttemptedAt:1,hasBeforeSubmit:true,screenshot:shot};
 assert.throws(()=>validateWechatAction(action,task));const refined=refineReceipt(action,shot,task.message,()=>image);
 assert(refined.receipt.localGeometryVerified);validateWechatAction(refined,task);
 fill(239,239,239);assert.equal(refineReceipt(action,shot,task.message,()=>image),action,'incoming pixels cannot repair an outgoing proof');
 fill(248,248,248);assert.equal(refineReceipt(action,shot,task.message,()=>image),action,'plain composer pixels are not a sent bubble');
});
test('a long outgoing paragraph can locate its green component when one OCR line is imperfect',()=>{
 const image={width:200,height:200,data:Buffer.alloc(160000,248)};
 for(let y=130;y<162;y++)for(let x=90;x<190;x++){const i=(y*200+x)*4;image.data[i]=105;image.data[i+1]=238;image.data[i+2]=153;image.data[i+3]=255;}
 const shot={preview:'data:image/png;base64,eA==',ocr:[{text:'demo project is',x:.5,y:.7,width:.35,height:.03,confidence:.99}]};
 const action={action:'done',completed:true,receipt:{outgoing:true,newBubble:true,composerEmpty:true,text:'demo project is now done',bubble:{x:.45,y:.755,width:.44,height:.115},composer:{x:.31,y:.85,width:.64,height:.1}}};
 const refined=refineReceipt(action,shot,action.receipt.text,()=>image);assert(refined.receipt.pixelGeometryVerified);assert(refined.receipt.bubble.y+refined.receipt.bubble.height<.85);
 const wrong={...shot,ocr:[{...shot.ocr[0],text:'unrelated incoming content'}]};assert.equal(refineReceipt(action,wrong,action.receipt.text,()=>image),action);
 assert.equal(refineReceipt(action,shot,'a different expected full message',()=>image),action);
});
