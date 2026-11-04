export function mountOwnerSecurity(pet){
 const input=document.getElementById('ownerIdentityKey'),toggle=document.getElementById('ownerIdentityEnabled'),save=document.getElementById('ownerIdentitySave'),clear=document.getElementById('ownerIdentityClear'),status=document.getElementById('ownerIdentityStatus');
 if(!input)return;
 let busy=false,state={enabled:false,configured:false};
 const paint=next=>{state={...state,...next};toggle.checked=state.enabled===true;toggle.disabled=busy;input.disabled=save.disabled=clear.disabled=busy||!state.enabled;status.textContent=state.error||(!state.enabled?'身份识别已关闭；不检查外部来信中的密钥，仅本地对话拥有主人权限。':state.configured?'已开启；密钥原值不可查看。修改或关闭会立即撤销全部外部认证。':'已开启，请设置身份密钥后使用。');};
 async function update(operation){if(busy)return;busy=true;paint();let error;try{paint(await operation());input.value='';}catch(e){error=e.message;try{paint(await pet.ownerSecurityStatus());}catch{}}finally{busy=false;paint();if(error)status.textContent=error;}}
 const change=value=>update(()=>pet.ownerSecurityChange(value));
 toggle.addEventListener('change',()=>{const enabled=toggle.checked;void update(()=>pet.ownerSecurityEnable(enabled));});
 save.addEventListener('click',()=>{const value=input.value;if(!value){status.textContent='请输入新密钥；需要停用时点击清除。';return;}void change(value);});
 clear.addEventListener('click',()=>void change(''));
 void pet.ownerSecurityStatus().then(paint).catch(error=>{status.textContent=error.message;});
 pet.on?.(event=>{if(event.type==='owner-security')paint(event);});
}
