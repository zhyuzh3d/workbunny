'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PetWindowInput}=require('../src/main/pet-window-input');
function fixture(){
 let capturing=false,visible=true,destroyed=false,mutations=0;
 const window={getContentBounds:()=>({x:-1000,y:100,width:500,height:400}),isDestroyed:()=>destroyed,isVisible:()=>visible,setIgnoreMouseEvents:()=>{mutations++;}};
 const input=new PetWindowInput({window,screen:{getCursorScreenPoint:()=>({x:0,y:0})},capturing:()=>capturing});
 input.setGeometry({width:1000,height:800,regions:[{x:100,y:100,width:200,height:200,taskUi:true},{x:500,y:100,width:200,height:200,taskUi:false}]});mutations=0;
 return {input,window,capture:v=>{capturing=v;},visible:v=>{visible=v;},destroy:v=>{destroyed=v;},mutations:()=>mutations};
}
test('pointer blocking maps global negative bounds and content scaling to real UI regions',()=>{
 const h=fixture();assert.equal(h.input.blocksPoint({x:-925,y:175}),true);assert.equal(h.input.blocksPoint({x:-725,y:175}),true);
 assert.equal(h.input.blocksPoint({x:-850,y:175}),false,'right edge is outside the first region');assert.equal(h.input.blocksPoint({x:-825,y:300}),false,'transparent content stays unblocked');
 assert.equal(h.input.blocksPoint({x:-1001,y:175}),false);assert.equal(h.input.blocksPoint({x:-500,y:175}),false);assert.equal(h.mutations(),0);
});
test('capturing blocks task UI while ordinary UI follows the existing click-through rule',()=>{
 const h=fixture();h.capture(true);assert.equal(h.input.blocksPoint({x:-925,y:175}),true);assert.equal(h.input.blocksPoint({x:-725,y:175}),false);h.capture(false);assert.equal(h.input.blocksPoint({x:-725,y:175}),true);assert.equal(h.mutations(),0);
});
test('hover cannot turn transparent pixels or missing geometry into a positive hit',()=>{
 const h=fixture();h.input.hover={inside:true,taskUi:true,ui:true};assert.equal(h.input.blocksPoint({x:-825,y:300}),false);
 h.input.geometry=null;assert.equal(h.input.blocksPoint({x:-925,y:175}),false);h.input.geometry={width:0,height:800,regions:[]};assert.equal(h.input.blocksPoint({x:-925,y:175}),false);assert.equal(h.mutations(),0);
});
test('hidden, destroyed, invalid points and invalid bounds do not claim a verified UI hit',()=>{
 const h=fixture();h.visible(false);assert.equal(h.input.blocksPoint({x:-925,y:175}),false);h.visible(true);h.destroy(true);assert.equal(h.input.blocksPoint({x:-925,y:175}),false);h.destroy(false);
 for(const p of [null,{x:NaN,y:175},{x:-925,y:Infinity}])assert.equal(h.input.blocksPoint(p),false);
 h.window.getContentBounds=()=>({x:-1000,y:100,width:0,height:400});assert.equal(h.input.blocksPoint({x:-925,y:175}),false);assert.equal(h.mutations(),0);
});
