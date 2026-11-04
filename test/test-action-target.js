'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sameActionTarget}=require('../src/main/screen-evidence');
test('late actions preserve their decision across unrelated changes, but replan for target/header/focus changes',()=>{
 const original=Buffer.alloc(200*200*4),bitmap=data=>({width:200,height:200,data});
 const shot=data=>({preview:'data:image/png;base64,'+data.toString('base64'),width:200,height:200});
 const action={action:'click',pixelX:100,pixelY:100},anchor={ocr:[{text:'Open',confidence:1,x:.49,y:.49,width:.02,height:.02}]};
 const changed=(x,y)=>{const data=Buffer.from(original);for(let yy=y;yy<y+4;yy++)for(let xx=x;xx<x+4;xx++)data.fill(255,(yy*200+xx)*4,(yy*200+xx)*4+3);return shot(data);};
 assert.equal(sameActionTarget(bitmap,shot(original),changed(170,170),action,anchor),true);
 assert.equal(sameActionTarget(bitmap,shot(original),changed(99,99),action,anchor),false);
 assert.equal(sameActionTarget(bitmap,shot(original),changed(99,10),action,anchor),false);
 assert.equal(sameActionTarget(bitmap,shot(original),changed(170,170),{...action,action:'type'},anchor),false);
 assert.equal(sameActionTarget(bitmap,shot(original),changed(170,170),{action:'click',label:'Open'},anchor),true);
 assert.equal(sameActionTarget(bitmap,shot(original),changed(170,170),{action:'click',label:'Missing'},anchor),false);
 assert.equal(sameActionTarget(undefined,shot(original),changed(170,170),action,anchor),false);
});
