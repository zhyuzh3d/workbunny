'use strict';
const path=require('node:path'),os=require('node:os');
const {socketPath}=require('../src/main/local-control');
function parseOptions(argv,env=process.env){let userData=env.BUDDY_PET_HOME||path.join(os.homedir(),'Library/Application Support/workbunny'),endpoint,timeoutMs=125000,params;const words=[];
 for(let i=0;i<argv.length;i++){const arg=argv[i];if(['--socket','--user-data','--timeout-ms','--params'].includes(arg)){const value=argv[++i];if(!value)throw Error(arg+' requires a value');if(arg==='--socket')endpoint=value;else if(arg==='--user-data')userData=path.resolve(value);else if(arg==='--params')params=JSON.parse(value);else{timeoutMs=Number(value);if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>660000)throw Error('timeout must be 100..660000 ms');}}else if(arg.startsWith('--'))throw Error('Unknown option: '+arg);else words.push(arg);}
 return {endpoint:endpoint||socketPath(userData),timeoutMs,params,words};
}
module.exports={parseOptions};
