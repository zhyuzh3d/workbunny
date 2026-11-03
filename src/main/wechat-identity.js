'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const MARK='［Bunny］';
function markedMessage(text,ownership='owner'){return ownership==='bunny'||/^[［\[]Bunny[］\]]/iu.test(String(text||''))?text:MARK+' '+text;}
function markedFilename(file,ownership='owner'){return markedMessage(path.basename(file),ownership);}
async function deliveryAttachment(file,{taskId,ownership='owner',directory=path.join(os.tmpdir(),'workbunny-deliveries')}={}){
 const source=await require('./result-attachment').verifyAttachment(file),name=markedFilename(source.path,ownership);
 if(name===path.basename(source.path))return source;
 if(!/^[a-zA-Z0-9_.-]{1,120}$/.test(taskId))throw Error('附件任务标识无效');
 const folder=path.join(directory,taskId);await fs.mkdir(folder,{recursive:true,mode:0o700});const destination=path.join(folder,name);
 try{await fs.copyFile(source.path,destination,require('node:fs').constants.COPYFILE_EXCL);await fs.chmod(destination,0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
 return require('./result-attachment').verifyAttachment({...source,path:await fs.realpath(destination)});
}
module.exports={MARK,markedMessage,markedFilename,deliveryAttachment};
