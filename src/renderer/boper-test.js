'use strict';
window.pasteEvents=0;window.keyEvents=[];
window.wheelEvents=0;window.wheelDeltas=[];window.dragMoves=0;window.lastButtons=0;window.lastPointer=null;
window.addEventListener('wheel',e=>{window.wheelEvents++;if(window.wheelDeltas.length<32)window.wheelDeltas.push({x:e.deltaX,y:e.deltaY});},{capture:true,passive:true});
window.addEventListener('pointermove',e=>{window.lastButtons=e.buttons;window.lastPointer={x:e.screenX,y:e.screenY};if(e.buttons&1)window.dragMoves++;});
window.addEventListener('pointerup',e=>{window.lastButtons=e.buttons;window.lastPointer={x:e.screenX,y:e.screenY};});
document.querySelector('textarea').addEventListener('paste',()=>window.pasteEvents++);
document.querySelector('textarea').addEventListener('keydown',e=>{if(window.keyEvents.length<100)window.keyEvents.push({key:e.key,meta:e.metaKey,ctrl:e.ctrlKey});});
