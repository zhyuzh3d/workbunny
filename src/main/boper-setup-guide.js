'use strict';
// Global OS metadata only; never inspects the application being operated.
function setupGuide(macOSVersion=''){
 const version=String(macOSVersion),major=Number.parseInt(version,10);
 const legacy=Number.isInteger(major)&&major>=13&&major<15;
 return {macOSVersion:version,driverName:'Karabiner VirtualHIDDevice',publisher:'Fumihiko Takayama',screenApprovalPath:'系统设置 → 隐私与安全性 → 录屏（部分系统称“屏幕与系统音频录制”或“屏幕录制”）',
  approvalPath:legacy?'系统设置 → 隐私与安全性':'系统设置 → 通用 → 登录项与扩展 → 驱动扩展',
  settingsURL:legacy?'x-apple.systempreferences:com.apple.preference.security?General':'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'};
}
function publicGuide(guide){const {settingsURL,...display}=guide;return display;}
module.exports={setupGuide,publicGuide};
