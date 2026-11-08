const roots=['dialogueOverlay','ear','dock','bubble','settings','motions','fab','rec','activity','activityDetails'];
export function observeInputRegions({document=globalThis.document,window=globalThis.window,publish}){
 let timer,last='';
 const collect=()=>{
  timer=null;const width=window.innerWidth,height=window.innerHeight,regions=[];
  for(const id of roots){const element=document.getElementById(id);if(!element||element.getClientRects().length===0)continue;const style=window.getComputedStyle(element);if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0)continue;const rect=element.getBoundingClientRect(),x=Math.max(0,rect.x),y=Math.max(0,rect.y),right=Math.min(width,rect.right),bottom=Math.min(height,rect.bottom);if(right>x&&bottom>y)regions.push({x:Math.round(x),y:Math.round(y),width:Math.floor(right-x),height:Math.floor(bottom-y),taskUi:id==='activity'||id==='activityDetails'});}
  const value={width,height,regions},signature=JSON.stringify(value);if(signature!==last){last=signature;publish(value);}
 };
 const schedule=()=>{if(!timer)timer=setTimeout(collect,32);};
 const mutation=new MutationObserver(schedule);mutation.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','style','open']});
 const resize=new ResizeObserver(schedule);resize.observe(document.documentElement);window.addEventListener('resize',schedule);document.addEventListener('scroll',schedule,true);collect();
 return {refresh:collect,close:()=>{clearTimeout(timer);mutation.disconnect();resize.disconnect();window.removeEventListener('resize',schedule);document.removeEventListener('scroll',schedule,true);}};
}
