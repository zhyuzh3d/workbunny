'use strict';
const contains=(r,p)=>p.x>=r.x&&p.x<r.x+r.width&&p.y>=r.y&&p.y<r.y+r.height;
const same=(a,b)=>a&&b&&['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<1);
const overlaps=(a,b)=>a.x<=b.x+b.width&&b.x<=a.x+a.width&&a.y<=b.y+b.height&&b.y<=a.y+a.height;
function applicationScene(window,windows){
 const owned=windows.filter(w=>w.pid===window.pid&&w.bundleId===window.bundleId&&w.rect.width>0&&w.rect.height>0);let rect={...window.rect},changed=true;
 while(changed){changed=false;for(const w of owned){if(!overlaps(rect,w.rect))continue;const x=Math.min(rect.x,w.rect.x),y=Math.min(rect.y,w.rect.y),right=Math.max(rect.x+rect.width,w.rect.x+w.rect.width),bottom=Math.max(rect.y+rect.height,w.rect.y+w.rect.height),next={x,y,width:right-x,height:bottom-y};if(!same(rect,next)){rect=next;changed=true;}}}
 return {rect,windows:owned.filter(w=>overlaps(rect,w.rect)),expanded:!same(rect,window.rect)};
}
function actionWindow(anchor,windows,point){
 const owned=windows.filter(w=>w.pid===anchor.pid&&w.bundleId===anchor.bundleId),target=owned.find(w=>contains(w.rect,point));if(!target)throw Object.assign(Error('坐标不在当前软件的可见窗口或菜单中，重新观察'),{dispatched:false});
 const expected=target.windowId===anchor.windowId?anchor.windowRect||anchor.rect:anchor.sceneWindows?.find(w=>w.windowId===target.windowId)?.rect;
 if(!same(expected,target.rect))throw Object.assign(Error('窗口或菜单位置已变化，重新观察定位'),{dispatched:false});return target;
}
module.exports={applicationScene,actionWindow,contains,same};
