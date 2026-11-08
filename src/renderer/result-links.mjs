// Only links carried by the result record become controls. Main rechecks the
// current task, scene and result index; the renderer never supplies an open URL.
function entries(links){
 return (Array.isArray(links)?links:[]).flatMap((link,index)=>{
  try{const url=new URL(link.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return [];return [{...link,index}];}catch{return [];}
 });
}
function button(doc,link,onOpen){
 const node=doc.createElement('button');node.type='button';node.className='result-link';node.textContent=link.url;node.title=link.label||link.url;node.dataset.resultLink=String(link.index);node.setAttribute('aria-label','打开成果链接：'+(link.label||link.url));
 node.onclick=event=>{event.preventDefault();event.stopPropagation();Promise.resolve().then(()=>onOpen(link.index)).catch(error=>{node.title=error.message||'链接暂不可用';});};return node;
}
export function renderResultText(container,text,links,onOpen){
 const doc=container.ownerDocument,available=entries(links),value=String(text||''),used=new Set();container.replaceChildren();let offset=0;
 for(;;){let next=null;for(const link of available){const at=value.indexOf(link.url,offset);if(at>=0&&(!next||at<next.at||at===next.at&&link.url.length>next.link.url.length))next={at,link};}if(!next)break;
  container.append(doc.createTextNode(value.slice(offset,next.at)),button(doc,next.link,onOpen));used.add(next.link.index);offset=next.at+next.link.url.length;
 }
 container.append(doc.createTextNode(value.slice(offset)));
 for(const link of available)if(!used.has(link.index))container.append(doc.createTextNode('\n'),button(doc,link,onOpen));
}
export function appendResultLinks(container,links,onOpen){
 const doc=container.ownerDocument;for(const link of entries(links))container.append(button(doc,link,onOpen));
}
