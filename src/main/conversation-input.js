'use strict';

// A conservative front-door guard, not a general DLP classifier. It runs before
// history, model calls and speech. Dedicated account settings remain local.
const KEY = /(?:\b(?:sk-|xai-|nvapi-)[A-Za-z0-9_-]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const VALUE = /(?:密码|口令|恢复码|password|api[ _-]?key|access[ _-]?token)\s*(?:[:：=]|是|为)\s*["']?[^\s"'，。；;]{4,}/i;
function containsSecret(text) { return KEY.test(String(text || '')) || VALUE.test(String(text || '')); }
const NOTICE = '这段话可能含密码或密钥，未发送给模型，也未保存。接口密钥请在对应设置中填写。';
module.exports = { containsSecret, NOTICE };
