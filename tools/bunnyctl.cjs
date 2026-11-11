#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {parseOptions}=require('./bunnyctl-options.cjs');
function parse(argv,env){const options=parseOptions(argv,env),words=options.words;const verb=words[0]?.includes('.')?words.shift().replaceAll('.','_'):words.splice(0,2).join('_');if(!verb||!verb.includes('_'))throw Error('Usage: bunnyctl scene get | scene set life | boper status|enable|refresh|test | tools list');let params=options.params;if(verb==='scene_set'&&params===undefined)params={scene:words.shift()};if(words.length)throw Error('Unexpected arguments');return {...options,name:verb,params:params??{}};}
async function main(argv=process.argv.slice(2),io=process){let client;try{const options=parse(argv);if(options.name==='boper_enable'&&!argv.includes('--timeout-ms'))options.timeoutMs=660000;client=new Client({name:'bunnyctl',version:'1.0.0'},{capabilities:{}});const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'bunny-mcp.cjs'),'--socket',options.endpoint,'--timeout-ms',String(options.timeoutMs)],stderr:'pipe'});transport.stderr?.on('data',chunk=>io.stderr.write(chunk));await client.connect(transport,{timeout:options.timeoutMs});
 const response=options.name==='tools_list'?await client.listTools({}, {timeout:options.timeoutMs}):await client.callTool({name:options.name,arguments:options.params},undefined,{timeout:options.timeoutMs});io.stdout.write(JSON.stringify(response)+'\n');if(response.isError)io.exitCode=1;return response;
 }catch(error){const result={error:{code:typeof error.code==='string'?error.code:'E_MCP_CLIENT',message:error.message}};const response={content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:true};io.stdout.write(JSON.stringify(response)+'\n');io.stderr.write('bunnyctl: '+error.message+'\n');io.exitCode=1;return response;}finally{await client?.close().catch(()=>{});}}
if(require.main===module)void main();
module.exports={main,parse};
