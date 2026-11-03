// Keep native checkbox state/events; share switch semantics and appearance for
// static fields and lazily generated forms in every panel.
document.body.classList.add('panel-theme');
const upgrade=root=>{if(root.matches?.('input[type=checkbox]'))root.setAttribute('role','switch');for(const el of root.querySelectorAll?.('input[type=checkbox]')||[])el.setAttribute('role','switch');};
upgrade(document.body);
new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')upgrade(r.target);else for(const n of r.addedNodes)if(n.nodeType===1)upgrade(n);}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['type']});
