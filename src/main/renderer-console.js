'use strict';
// Electron's current console event carries named severity and source fields.
function rendererConsole(entry,scope,{development=false}={}){
 if(!entry||typeof entry.message!=='string')return null;
 const {level,message,lineNumber,sourceId}=entry;
 if(message.includes('DevTools')||message.includes('specVersion of the VRMA'))return null;
 if(!development&&!['warning','error'].includes(level))return null;
 return `[${scope}:${level}] ${message.slice(0,12000)} (${String(sourceId||'').split('/').pop()}:${lineNumber||0})`;
}
module.exports={rendererConsole};
