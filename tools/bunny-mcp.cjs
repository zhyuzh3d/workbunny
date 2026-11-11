#!/usr/bin/env node
'use strict';
// Official MCP stdio transport/lifecycle; the socket is private host IPC.
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode}=require('@modelcontextprotocol/sdk/types.js');
const {SCHEMA,sendRequest,randomUUID}=require('../src/main/local-control');
const {parseOptions}=require('./bunnyctl-options.cjs');
async function start({endpoint,timeoutMs=125000}={}){
 const server=new Server({name:'workbunny-local-control',version:'1.0.0'},{capabilities:{tools:{}}});
 const forward=async(method,params)=>{const reply=await sendRequest(endpoint,{schema:SCHEMA,id:randomUUID(),method,params},{timeoutMs});if(!reply.ok)throw new McpError(['E_LOCAL_METHOD','E_LOCAL_PARAMS'].includes(reply.error?.code)?ErrorCode.InvalidParams:ErrorCode.InternalError,reply.error?.message||'Bunny local control unavailable',{code:reply.error?.code});return reply.result;};
 server.setRequestHandler(ListToolsRequestSchema,async()=>forward('tools.list',{}));
 server.setRequestHandler(CallToolRequestSchema,async request=>forward('tools.call',{name:request.params.name,arguments:request.params.arguments??{}}));
 await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:16*1024}));return server;
}
if(require.main===module){try{const options=parseOptions(process.argv.slice(2));if(options.words.length)throw Error('MCP bridge accepts only --socket, --user-data and --timeout-ms');void start(options).catch(error=>{process.stderr.write('bunny-mcp: '+error.message+'\n');process.exitCode=1;});}catch(error){process.stderr.write('bunny-mcp: '+error.message+'\n');process.exitCode=1;}}
module.exports={start};
