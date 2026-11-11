'use strict';
// The registered command boundary rejects recognizable alternate input APIs.
// This is a source/tool policy, not a sandbox or a claim to identify arbitrary
// behavior hidden inside third-party programs.
const path=require('node:path');
const fs=require('node:fs/promises');
const denied=()=>Object.assign(Error('键鼠输入必须经过 BOPER；请使用已注册的视觉/键鼠工具，不能从终端另建输入通道'),{code:'E_BOPER_INPUT_BYPASS',dispatched:false});
function assertSource(command,args=[],source=''){
 const name=path.basename(command).toLowerCase(),code=[...args,source].join('\n');
 if(['cliclick','keymouse','kmbridge','boper-runtime','ydotool','xdotool'].includes(name)||/(?:^|[\s/'"])(?:cliclick|keymouse|kmbridge|boper-runtime)(?:[\s/'"]|$)/iu.test(code)||
  /\b(?:CGEventPost(?:ToPid)?|CGEventCreate(?:Keyboard|Mouse|ScrollWheel)Event|keyboardSetUnicodeString|postToPid)\s*\(/u.test(code)||/\bCGEvent\s*\(\s*(?:keyboardEventSource|mouseEventSource|scrollWheelEvent2Source)\s*:/u.test(code)||
  /\b(?:pyautogui|pydirectinput)\s*\.\s*(?:click|doubleClick|rightClick|moveTo|moveRel|dragTo|dragRel|mouseDown|mouseUp|scroll|hscroll|write|typewrite|press|keyDown|keyUp|hotkey)\s*\(/iu.test(code)||
  /\bfrom\s+(?:pyautogui|pydirectinput)\s+import\s+(?:\*|[^\n]*(?:click|press|write|hotkey|keyDown|moveTo|typewrite))/iu.test(code)||
  /\bpynput\s*\.\s*(?:keyboard|mouse)\s*\.\s*Controller\s*\(|\bfrom\s+pynput\.(?:keyboard|mouse)\s+import\s+[^\n]*Controller/iu.test(code)||
  /(?:require\s*\(|\bfrom\s+|\bimport\s+)[^\n]{0,80}(?:robotjs|@nut-tree\/(?:nut-js|libnut))|\b(?:robot|robotjs)\s*\.\s*(?:keyTap|keyToggle|typeString|mouseClick|moveMouse|dragMouse|scrollMouse)\s*\(/iu.test(code)||
  /\b(?:keystroke|key\s+code)\s+(?:["'\d{]|using\b)|\.(?:keystroke|keyCode)\s*\(/iu.test(code)||
  /(?:tell\s+application\s+["']System Events["']|Application\s*\(\s*["']System Events["']\s*\))[\s\S]{0,1200}\b(?:click|drag|keyDown|keyUp|set\s+value\s+of)\b/iu.test(code))throw denied();
}
async function inspectFiles(command,args=[],cwd=process.cwd()){
 assertSource(command,args);
 const candidates=new Set();
 if(/\.(?:py|js|mjs|cjs|sh|zsh|bash|swift|applescript|jxa|lua)$/iu.test(command))candidates.add(command);
 const interpreter=/^(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|swift|osascript|(?:ba|z|da|k)?sh|lua)$/iu.test(path.basename(command));
 if(interpreter)for(let i=0;i<args.length;i++){
  const arg=args[i];if(['-c','-e','--eval','-E','-p','--print'].includes(arg)){i++;continue;}
  if(arg.startsWith('-'))continue;
  if(/\.(?:py|js|mjs|cjs|sh|zsh|bash|swift|applescript|jxa|lua|scpt)$/iu.test(arg))candidates.add(arg);
 }
 for(const candidate of [...candidates].slice(0,8)){
  if(/\.scpt$/iu.test(candidate))throw denied();
  const file=path.resolve(cwd,candidate);let stat;try{stat=await fs.stat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!stat.isFile())continue;if(stat.size>1024*1024)throw Object.assign(Error('终端脚本超过可核对范围；请将键鼠操作交给 BOPER 工具'),{code:'E_TERMINAL_SCRIPT_LIMIT',dispatched:false});
  assertSource(command,args,await fs.readFile(file,'utf8'));
 }
}
module.exports={assertSource,inspectFiles};
