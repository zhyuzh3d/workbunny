'use strict';
// Public local API. The caller chooses its group KEY; no Bunny identity needed.
const {randomUUID}=require('node:crypto');
const {BoperService}=require('./boper-service');
const {validateKey,createKey}=require('./boper-key');
class BoperClient{
 constructor({key,...options}={}){
  this.key=validateKey(key);this.scopeId=randomUUID();
  this.service=new BoperService({...options,key:this.key,enabled:true});
  this.context={ownerId:this.key,application:'boper-client',requiredInputBackend:'virtual-hid',validate:()=>!this.service.closed};
 }
 async status(){const value=await this.service.control().status();return value;}
 async execute(operation,{displayBounds,signal,timeoutMs=12000}={}){
  await this.service.refreshStatus();
  return this.service.execute(operation,{...this.context,displayBounds,signal},{scopeId:this.scopeId,timeoutMs});
 }
 async release(){return this.service.endScope(this.key,this.scopeId);}
 async stop(){
  if(this.service.active)await this.service.stop('group-stop');
  return this.service.control().revokeSession();
 }
 async close(){await this.service.shutdown();}
}
module.exports={BoperClient,createKey,validateKey};
