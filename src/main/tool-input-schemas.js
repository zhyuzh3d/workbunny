'use strict';
const string={type:'string'},object=properties=>({type:'object',properties,additionalProperties:false});
const subject={application:{const:'wechat'},recipient:string};
const schemas={
 'files.destination':object({application:{const:'system'},fileName:string}),
 'files.list':object({application:{const:'system'},path:string}),
 'files.inspect':object({application:{const:'system'},path:string}),
 'screen.activate':object({application:{enum:['workbuddy','wechat','finder','chrome','codex']}}),
 'screen.observe':object({application:{enum:['workbuddy','wechat','finder','chrome','codex']},force:{type:'boolean'},regions:{type:'array',items:object({x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'},minChangedRatio:{type:'number'}})}}),
 'screen.commit':object({application:string}),
 'screen.action':object({application:{enum:['workbuddy','wechat','finder','chrome','codex']},recipient:string,frameId:{type:'string',description:'最近screen.observe的唯一frameId'},action:{enum:['click','type','key','scroll']},pixelX:{type:'integer',description:'预览图像素横坐标，禁止归一化'},pixelY:{type:'integer',description:'预览图像素纵坐标，禁止归一化'},text:string,key:string,modifiers:{type:'array',items:string},deltaY:{type:'number'},purpose:string,label:string,targetType:{enum:['text','icon','region']},button:{enum:['left','right']}}),
 'conversation.observe':object({...subject,force:{type:'boolean'},relocate:{type:'boolean'}}),
 'conversation.open':object(subject),'conversation.send':object({...subject,message:string}),
 'work.submit':object({application:{const:'workbuddy'},goal:{type:'string',description:'本步骤的完整目标；不填则沿用主人任务'},criteria:string,context:string,workContext:object({workspace:string,directory:string,mode:{enum:['auto','none','workspace']}})}),
 'work.status':object({application:{const:'workbuddy'},jobId:{type:'string',description:'先前work.submit真实返回的jobId'}}),
 'terminal.execute':object({application:{const:'system'},command:string,args:{type:'array',items:string},impact:{enum:['read','reversible','configuration']},purpose:string,cwd:string,timeoutSeconds:{type:'integer',minimum:1,maximum:300}}),
 'system.configure':object({application:{const:'system'},domain:string,key:string,type:{enum:['string','bool','int']},value:string}),
 'system.restore':object({application:{const:'system'},snapshotId:{type:'string',description:'本任务system.configure回执里的snapshotId'}})
};
function applySchemas(registry){for(const [name,inputSchema]of Object.entries(schemas)){const tool=registry.get(name);registry.tools.set(name,Object.freeze({...tool,inputSchema}));}}
module.exports={applySchemas};
