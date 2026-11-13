#!/usr/bin/env node
'use strict';
// One bounded JSON request on stdin. KEY never needs to appear in argv.
const {BoperClient,createKey}=require('../src/main/boper-client');
async function main(){
 if(process.argv[2]==='keygen'){process.stdout.write(createKey()+'\n');return;}
 let size=0,parts=[];
 for await(const part of process.stdin){size+=part.length;if(size>256*1024)throw Error('BOPER request exceeds 256 KiB');parts.push(part);}
 const request=JSON.parse(Buffer.concat(parts).toString('utf8'));
 const client=new BoperClient({key:request.key});
 let result,failure;
 try{
  if(request.action==='status')result=await client.status();
  else if(request.action==='stop')result=await client.stop();
  else if(request.action==='execute'){
   result=await client.execute(request.operation,{displayBounds:request.displayBounds,timeoutMs:request.timeoutMs});
   try{result={...result,...await client.release()};}catch(error){error.inputOutcome={...result,...error.inputOutcome};throw error;}
  }else throw Error('Supported actions: status, execute, stop');
 }catch(error){failure=error;}
 finally{try{await client.close();}catch(error){if(!failure)failure=error;}}
 if(failure)throw failure;
 process.stdout.write(JSON.stringify({ok:true,result})+'\n');
}
main().catch(error=>{process.stdout.write(JSON.stringify({ok:false,error:{code:error.code||'E_BOPER_CLIENT',message:error.message},...(error.inputOutcome?{inputOutcome:error.inputOutcome}:{})})+'\n');process.exitCode=1;});
