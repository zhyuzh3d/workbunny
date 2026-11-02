'use strict';
// Give every suite a fresh process and run them serially. GUI acceptance uses
// the application runtime in separate explicit *.cjs tests.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=fs.readdirSync(path.join(root,'test')).filter(name=>/\.(?:js|mjs)$/u.test(name)).sort().map(name=>path.join('test',name));
async function run(){let failed=0;for(const file of files){
 const code=await new Promise(resolve=>{const child=spawn(process.execPath,['--test',file,...process.argv.slice(2)],{cwd:root,env:process.env,stdio:'inherit'});
 child.on('error',error=>{console.error(error.message);resolve(1);});child.on('exit',code=>resolve(code??1));});if(code)failed++;
}console.log(JSON.stringify({suites:files.length,failed}));process.exitCode=failed?1:0;}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
