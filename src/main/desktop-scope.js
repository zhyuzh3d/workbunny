'use strict';

// This product's WeChat scope explicitly excludes payments and process/tool
// automation. Keep these checks before window activation, including panel use.
function checkDesktopScope(target, goal) {
  const clauses = String(goal || '').split(/[。；;\n]/u).map(value => value.trim()).filter(Boolean);
  const positive = clauses.map(value => value.replace(/(?:不要|不能|禁止|严禁|绝不|不许|不可|不得|无需|不需要|\bdo\s+not\b|\bdon't\b|\bnever\b|\bmust\s+not\b)[^，,。；;.\n]*/giu, '')).join('\n');
  const wechat = target === 'wechat' || /(?:使用|用|在|通过|调用|操作|退出|重启|关闭|kill|quit|restart|\b(?:use|using|in|via|operate|call|close)\b)\s*(?:微信|wechat)/i.test(positive) ||
    /(?:使用|用|通过|调用|\b(?:use|using|via|call)\b)[^。；\n]{0,20}(?:AppleScript|osascript|MCP|系统工具|辅助功能|AX|accessibility)[^。；\n]{0,20}(?:微信|wechat)/i.test(positive) ||
    /(?:微信|wechat)\s*(?:API|接口|MCP|插件|系统工具|辅助功能|AX)\s*(?:读取|写入|获取|操作|发送|导出|执行|调用)/i.test(positive);
  if (!wechat) return null;
  if (/转账|付款|支付|发(?:送)?(?:一个|几个|[一二三四五六七八九十\d]+个?|个)?红包|塞钱|充值|汇款|打款|\bpayment\b|\bpay\s|transfer\s+money|send\s+money/i.test(positive)) {
    return '微信代办不支持支付、转账或红包，请直接在微信中自行处理。';
  }
  if (/(?:退出|重启|关闭|kill|quit|restart)\s*(?:微信|wechat)|(?:微信|wechat)[^。；\n]{0,8}(?:退出|重启|进程)|AppleScript|osascript|AX(?:树|控件|\s*(?:tree|automation|control))|辅助功能(?:树|控件)|accessibility\s*(?:API|tree|automation)|(?:微信|wechat)\s*(?:API|接口|MCP|插件|系统工具|interface|plugin|system\s+tools?)|(?:MCP|系统工具)[^。；\n]{0,15}(?:微信|wechat)/i.test(positive)) {
    return '微信只能通过截图和键鼠操作，不能退出、重启或使用微信系统工具。';
  }
  return null;
}

module.exports = { checkDesktopScope };
