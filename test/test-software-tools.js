'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ToolRegistry}=require('../src/main/agent-tools');
const {registerSoftwareTools}=require('../src/main/software-tools');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-software-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const calls=[],native={request:async(op,args)=>{calls.push({op,args});if(op==='softwareInfo')return {installed:true,bundleId:args.bundleId,version:'1.2.3',cliCandidates:[],scriptDictionaries:['Demo.sdef'],accessibilityTrusted:true};if(op==='softwareInterface')return {available:true,target:{bundleId:args.bundleId,expected:{bundleId:args.bundleId,pid:123},windowId:7},nodes:[{role:'AXButton',label:'运行',actions:['AXPress']}]};if(op==='softwareControl')return {performed:true};throw Error('unexpected operation');}};
 const tools=new ToolRegistry();registerSoftwareTools(tools,{native,directory});const task={id:'software-test',skill:'software.execute',subjects:[{application:'demo'}],capabilities:['terminal.execute','screen.read','screen.input'],state:{},sources:[],operations:{}};
 return {tools,task,calls,run:async(name,args)=>{const {tool,input}=tools.check(name,args,task);return tool.execute(input,{task});}};
}
test('discovery, CLI evidence and semantic controls share application scope and bounded method history',async t=>{
 const h=fixture(t);await h.run('software.inspect',{application:'demo',bundleId:'org.example.demo',cliNames:[]});
 const cli=await h.run('software.command',{application:'demo',command:process.execPath,args:['-e','console.log("unsupported operation");process.exitCode=2'],impact:'read',purpose:'inspect actual CLI support'});
 assert.equal(cli.exitCode,2);assert.match(cli.stdout,/unsupported/);assert.equal(h.task.state.softwareMethods.at(-1).exitCode,2);
 await h.run('software.interface',{application:'demo'});const click=await h.run('software.control',{application:'demo',role:'AXButton',label:'运行',action:'press'});
 assert.equal(click.receipt.inputPerformed,true);assert.equal(h.calls.at(-1).args.expected.pid,123);
 assert.throws(()=>h.tools.check('software.command',{application:'other',command:process.execPath,args:[],impact:'read',purpose:'wrong target'},h.task),/范围/);
});
test('WeChat receives its innate boundary without CLI or UI-tree probing, including aliases',async t=>{
 const h=fixture(t);h.task.subjects=[{application:'wechat'},{application:'alias'}];
 const result=await h.run('software.inspect',{application:'wechat'});assert.deepEqual(result.methods,['visual']);assert.equal(h.calls.length,0);
 await h.run('software.inspect',{application:'alias',bundleId:'com.tencent.xinWeChat'});assert.equal(h.calls.length,0);
 assert.throws(()=>h.tools.check('software.interface',{application:'wechat'},h.task),/微信/);
 assert.throws(()=>h.tools.check('software.command',{application:'wechat',command:process.execPath,args:[],impact:'read',purpose:'probe'},h.task),/微信/);
});
test('semantic editing requires a current interface target and an expected old value',async t=>{
 const h=fixture(t);await assert.rejects(h.run('software.control',{application:'demo',role:'AXButton',label:'运行',action:'press'}),/先读取/);
 assert.throws(()=>h.tools.check('software.control',{application:'demo',role:'AXTextArea',label:'',action:'setValue',value:'new'},h.task),/原值/);
});
