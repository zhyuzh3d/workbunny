'use strict';
const assert = require('node:assert/strict');
const { containsSecret, NOTICE } = require('../src/main/conversation-input');
for (const value of ['请记住密码是example-fixture-only', 'password: fixture-not-a-real-password', 'API key = sk-fixtureonly01234567890123456789', '-----BEGIN OPENSSH PRIVATE KEY-----']) assert(containsSecret(value));
for (const value of ['我想修改密码，去哪里设置？', '接口密钥应该保存在本机。', '请帮我写一份账号安全建议。', '普通算术结果1.1']) assert(!containsSecret(value));
assert(!NOTICE.includes('example-fixture-only'));
console.log('Sensitive conversation admission checks passed');
