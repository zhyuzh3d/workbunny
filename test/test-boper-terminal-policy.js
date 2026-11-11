'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {terminalArgs,executeTerminal}=require('../src/main/system-tools');
const base={application:'system',impact:'reversible',purpose:'fixture input boundary'};
test('known alternate input commands and inline APIs cannot bypass the registered BOPER boundary',()=>{
 for(const [command,args] of [['/usr/local/bin/cliclick',['c:10,10']],['/tmp/keymouse',['click']],['/tmp/boper-runtime',[]],['/usr/bin/osascript',['-e','tell application "System Events" to keystroke "private"']],['/usr/bin/osascript',['-l','JavaScript','-e','Application("System Events").keyCode(36)']],['/usr/bin/python3',['-c','import pyautogui; pyautogui.write("private")']],['/usr/bin/python3',['-c','from pynput.keyboard import Controller; Controller()']],['/usr/bin/swift',['-e','CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)']],['/usr/bin/node',['-e','require("robotjs").keyTap("a")']]]){
  assert.throws(()=>terminalArgs({...base,command,args}),{code:'E_BOPER_INPUT_BYPASS'});
 }
});
test('referenced script files are inspected before command launch and non-input scripts retain authorization',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'boper-terminal-'));try{
  await fs.writeFile(path.join(directory,'input.py'),'import pyautogui\npyautogui.click(10, 10)\n');
  const denied={...base,command:'/usr/bin/python3',args:['input.py'],cwd:directory,timeoutSeconds:1};await assert.rejects(executeTerminal(denied,{task:{id:'test'},directory}),{code:'E_BOPER_INPUT_BYPASS'});
  const args=terminalArgs({...base,command:'/usr/bin/python3',args:['-c','print(6 * 7)'],cwd:directory,timeoutSeconds:2});const result=await executeTerminal(args,{task:{id:'test'},directory});assert.equal(result.exitCode,0);assert.equal(result.stdout.trim(),'42');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
