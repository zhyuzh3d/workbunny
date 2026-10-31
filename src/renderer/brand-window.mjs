// Native traffic lights stay available; the title itself uses our vector mark.
const bar=document.createElement('header');
bar.className='brand-titlebar';bar.setAttribute('aria-label','窗口标题');
const mark=document.createElement('span');mark.className='bunny-logo';mark.setAttribute('aria-hidden','true');
const label=document.createElement('span');label.className='brand-window-title';
bar.append(mark,label);document.body.prepend(bar);document.body.classList.add('has-brand-title');
const update=()=>{label.textContent=document.title;};update();
const observer=new MutationObserver(update);observer.observe(document.querySelector('title'),{childList:true,subtree:true,characterData:true});
window.addEventListener('unload',()=>observer.disconnect(),{once:true});
