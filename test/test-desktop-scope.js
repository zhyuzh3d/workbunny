'use strict';
const assert = require('assert/strict');
const { checkDesktopScope } = require('../src/main/desktop-scope');
for (const goal of ['给张三转账100元', '发送一个红包给文件传输助手', '支付这次订单', '发红包', '重启微信', '退出微信后再登录', '用AppleScript发送一条微信', '用微信系统工具查看消息']) {
  assert(checkDesktopScope('wechat', goal), goal);
}
for (const goal of ['向文件传输助手发送早上好', '给李四发一句“吃饭了吗”', '发消息，不要支付，也不要重启微信。', '禁止微信AppleScript、插件与支付。\n只用截图键鼠发送你好。']) {
  assert.equal(checkDesktopScope('wechat', goal), null, goal);
}
assert(checkDesktopScope('workbuddy', '用微信转账给张三'));
for (const goal of ['请使用 AppleScript 退出微信再重试', '请用 AppleScript 发送一条微信', '重启微信后继续', '通过微信接口读取消息', '微信MCP读取消息']) assert(checkDesktopScope('workbuddy', goal), goal);
for (const goal of ['Use WeChat API to read messages', 'Use AppleScript to send via WeChat', 'Use AX tree to read WeChat']) assert(checkDesktopScope('workbuddy', goal), goal);
assert.equal(checkDesktopScope('wechat', 'Send hello. Do not use AppleScript, never quit WeChat.'), null);
assert.equal(checkDesktopScope('workbuddy', '给本地支付组件的代码做一次只读审查'), null);
console.log('Desktop scope boundaries passed');
