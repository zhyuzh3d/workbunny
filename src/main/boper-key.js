'use strict';
const {randomBytes}=require('node:crypto');
function validateKey(key){
 if(typeof key!=='string'||key.length!==24||!/^[A-Za-z0-9_-]{24}$/.test(key))throw Object.assign(Error('BOPER KEY 必须是24个字母、数字、下划线或短横线字符'),{code:'E_BOPER_KEY',dispatched:false});
 return key;
}
module.exports={validateKey,createKey:()=>randomBytes(18).toString('base64url')};
