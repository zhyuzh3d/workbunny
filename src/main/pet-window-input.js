'use strict';
// DOM hover is advisory: it can become stale when transparent UI is replaced or
// the native window moves. Visible UI geometry owns its real screen hit region.
class PetWindowInput{
 constructor({window,screen,capturing=()=>false,log=()=>{}}){Object.assign(this,{window,screen,capturing,log});this.hover={inside:false,taskUi:false};this.geometry=null;this.interactive=false;this.last={interactive:false,taskUi:false};}
 setHover(hover){this.hover={inside:hover?.inside===true,taskUi:hover?.taskUi===true,ui:hover?.ui===true||hover?.taskUi===true};return this.refresh();}
 setGeometry(value){
  if(!value||!Number.isFinite(value.width)||!Number.isFinite(value.height)||value.width<=0||value.height<=0||!Array.isArray(value.regions)||value.regions.length>64)return false;
  const regions=value.regions.filter(rect=>['x','y','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0&&rect.x>=-2&&rect.y>=-2&&rect.x+rect.width<=value.width+2&&rect.y+rect.height<=value.height+2).map(rect=>({...rect,taskUi:rect.taskUi===true}));
  this.geometry={width:value.width,height:value.height,regions};this.refresh();return true;
 }
 invalidate(){this.geometry=null;this.refresh();}
 blocksPoint(point){
  try{
   if(this.window.isDestroyed?.()||this.window.isVisible?.()===false||!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;
   const bounds=this.window.getContentBounds(),geometry=this.geometry;
   if(!bounds||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k]))||bounds.width<=0||bounds.height<=0||
    point.x<bounds.x||point.y<bounds.y||point.x>=bounds.x+bounds.width||point.y>=bounds.y+bounds.height)return false;
   if(!geometry||!Number.isFinite(geometry.width)||!Number.isFinite(geometry.height)||geometry.width<=0||geometry.height<=0||!Array.isArray(geometry.regions))return false;
   const x=(point.x-bounds.x)*geometry.width/bounds.width,y=(point.y-bounds.y)*geometry.height/bounds.height,capturing=this.capturing();
   return geometry.regions.some(r=>r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0&&
    x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height&&(!capturing||r.taskUi===true));
  }catch{return false;}
 }
 hit(point=this.screen.getCursorScreenPoint()){
  const bounds=this.window.getContentBounds(),within=point.x>=bounds.x&&point.y>=bounds.y&&point.x<bounds.x+bounds.width&&point.y<bounds.y+bounds.height;
  if(!within)return {within:false,inside:false,taskUi:false};
  const geometry=this.geometry;if(!geometry)return {within:true,inside:this.hover.inside,taskUi:this.hover.taskUi};
  const x=(point.x-bounds.x)*geometry.width/bounds.width,y=(point.y-bounds.y)*geometry.height/bounds.height;
  const regions=geometry.regions.filter(rect=>x>=rect.x&&x<rect.x+rect.width&&y>=rect.y&&y<rect.y+rect.height);
  return {within:true,inside:regions.length>0||this.hover.inside&&!this.hover.ui,taskUi:regions.some(rect=>rect.taskUi),ui:regions.length>0};
 }
 refresh(){
  if(this.window.isDestroyed())return this.last;
  const hit=this.hit(),interactive=hit.inside&&(!this.capturing()||hit.taskUi),changed=interactive!==this.interactive||hit.taskUi!==this.last.taskUi;
  if(interactive!==this.interactive){this.interactive=interactive;this.window.setIgnoreMouseEvents(!interactive,{forward:true});}
  this.last={interactive,taskUi:hit.taskUi,ui:hit.ui===true};
  if(changed)this.log('[window-input]',this.last);return this.last;
 }
 start(){if(!this.timer){this.timer=setInterval(()=>this.refresh(),80);this.timer.unref?.();}return this;}
 close(){clearInterval(this.timer);this.timer=null;}
}
module.exports={PetWindowInput};
