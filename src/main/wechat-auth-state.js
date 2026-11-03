'use strict';
// Read only display evidence. This module never offers a login action.
function wechatAuthReason(rows=[]){
 const labels=rows.filter(r=>r.confidence>=.55).map(r=>String(r.text||'').normalize('NFKC').replace(/\s/gu,'').replace(/[。.!！]$/u,''));
 if(labels.some(s=>/^(?:为了你的?账号安全[,，]?请重新登录|请重新登录|登录已(?:过期|失效))$/u.test(s)))return '微信要求重新登录，已停止操作；请主人恢复登录后重新定位';
 const chat=labels.some(s=>/^(?:搜索|聊天|通讯录|Search|Contacts)$/iu.test(s));
 if(!chat&&labels.some(s=>/^(?:扫码登录|扫描二维码(?:登录)?|在手机上确认登录|请在手机上确认登录|登录微信|一键登录|进入微信|登录|LogintoWeChat|Login|Signin)$/iu.test(s)))return '画面显示微信登录界面，已停止操作；未尝试重新登录';
 return null;
}
function wechatAuthError(rows){const reason=wechatAuthReason(rows);return reason?Object.assign(Error(reason),{code:'E_APP_CIRCUIT',dispatched:false}):null;}
module.exports={wechatAuthReason,wechatAuthError};
