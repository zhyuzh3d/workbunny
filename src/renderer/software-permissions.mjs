import '../shared/external-message.js';
const {MARK}=globalThis.BunnyExternalMessage;
export function mountSoftwarePermissions(root,api,{config,save,onOpen}={}){
 if(!root)return;
 const title=document.createElement('div');title.className='group';title.textContent='主动处理';root.append(title);
 const note=document.createElement('p');note.className='note';note.textContent='推荐开启，让 Bunny 在授权任务内主动解决问题，尝试可恢复的小风险；系统密码仍由你确认。';root.append(note);
 const inputs=new Map();
 for(const [key,label] of [['systemConfiguration','允许 Bunny 进行操作系统配置修改'],['terminal','允许 Bunny 完全使用非破坏性终端命令']]){
  const row=document.createElement('label');row.className='row';const span=document.createElement('span');span.textContent=label;
  const input=document.createElement('input');input.type='checkbox';input.setAttribute('role','switch');input.dataset.softwareCapability=key;input.checked=config?.software?.[key]===true;
  input.onchange=async()=>{input.disabled=true;try{await save({software:{[key]:input.checked}});status.textContent='已保存。等待这项授权的任务会自动继续。';}catch(error){input.checked=!input.checked;status.textContent=error.message;}finally{input.disabled=false;}};
  row.append(span,input);root.append(row);inputs.set(key,input);
 }
 const ownershipRow=document.createElement('label');ownershipRow.className='row';const ownershipLabel=document.createElement('span');ownershipLabel.textContent='当前微信';const ownership=document.createElement('select');
 for(const [value,label]of [['owner',`主人微信 · 代发带${MARK}`],['bunny','Bunny自己的微信']]){const option=document.createElement('option');option.value=value;option.textContent=label;ownership.append(option);}ownership.value=config?.software?.wechatAccountOwnership||'owner';ownership.onchange=async()=>{ownership.disabled=true;try{await save({software:{wechatAccountOwnership:ownership.value}});}catch(error){status.textContent=error.message;}finally{ownership.disabled=false;}};ownershipRow.append(ownershipLabel,ownership);root.append(ownershipRow);
 const status=document.createElement('div');status.className='permTip';status.setAttribute('role','status');root.append(status);
 const buttons=document.createElement('div');buttons.className='permBtns';root.append(buttons);
 const paint=request=>{
  buttons.replaceChildren();if(request?.resolved){status.textContent='授权已核对，原任务已继续。';return;}if(!request)return;status.textContent=request.message;onOpen?.();
  if(request.missing?.includes('boperReady')){const button=document.createElement('button');button.className='mini';button.textContent='安装并启用虚拟键鼠';button.onclick=async()=>{button.disabled=true;try{await api.boperControl('enable');status.textContent='请完成系统批准，并在 BOPER 设置中重新检测。';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};buttons.append(button);return;}
  const names={screenCaptureAllowed:['screen','屏幕录制'],accessibilityTrusted:['accessibility','输入与辅助功能'],postEventAllowed:['input','模拟键鼠']};
  for(const missing of request.missing||[]){const known=names[missing];if(!known)continue;const button=document.createElement('button');button.className='mini';button.textContent='允许'+known[1];
   button.onclick=async()=>{button.disabled=true;try{await api.softwarePermission(known[0]);status.textContent='请完成系统提示。授权后会重新核对并继续原任务。';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};buttons.append(button);break;
  }
 };
 api.on(event=>{if(event.type==='task-permission')paint(event);if(event.type==='config'){for(const [key,input]of inputs)input.checked=event.config?.software?.[key]===true;ownership.value=event.config?.software?.wechatAccountOwnership||'owner';}});
 return {paint};
}
