'use strict';

const assert = require('node:assert/strict');
const { factFromStatement, factFromMemory, keysForQuestion } = require('../src/main/user-facts');

function testNames() {
  assert.deepEqual(factFromStatement('我叫  张三。'), { key: 'user.name', canonicalValue: '张三', memoryKind: 'fact' });
  assert.equal(factFromStatement('小雨'), null, 'a bare name assertion requires a supported prefix');
  assert.equal(factFromStatement('我叫什么'), null, 'a question is never stored as a fact');
  assert.equal(factFromStatement('如果我叫张三'), null);
  assert.equal(factFromStatement('我不叫张三'), null);
  assert.equal(factFromStatement('他说我叫张三'), null);
  assert.equal(factFromStatement('我叫“张三”'), null, 'quoted words are not adopted as facts');
  assert.equal(factFromStatement('My name is Alice?'), null);
  assert.equal(factFromStatement('My name is  Ａlice   Smith.' ).canonicalValue, 'alice smith', 'NFKC, whitespace, and English case normalize');
  assert.equal(factFromStatement("Call me O'Neil").canonicalValue, "o'neil", 'an apostrophe inside an English name is allowed');
  assert.equal(factFromStatement('以后叫我欧阳娜娜').canonicalValue, '欧阳娜娜', 'Chinese names are preserved');
  assert.equal(factFromStatement('my name is Alice Smith').canonicalValue,
    factFromStatement('My name is ALICE   Smith').canonicalValue, 'different English capitalization compares equal');
}

function testBirthdays() {
  assert.deepEqual(factFromStatement('我的生日是3月4日'), {
    key: 'user.birthday', canonicalValue: 'solar:03-04', memoryKind: 'anniversary', anniversary: { calendar: 'solar', month: 3, day: 4 },
  });
  assert.equal(factFromStatement('我出生于2000年2月29日').canonicalValue, 'solar:02-29');
  assert.equal(factFromStatement('我出生于2001年2月29日'), null, 'an explicitly supplied non-leap birth year must be valid');
  assert.equal(factFromStatement('我的生日是4月31日'), null);
  assert.equal(factFromStatement('我的生日是2月29日').canonicalValue, 'solar:02-29', 'a yearless solar birthday may be leap day');
  assert.equal(factFromStatement('我农历生日是3月30日').canonicalValue, 'lunar:03-30');
  assert.equal(factFromStatement('我的生日是农历3月4日').canonicalValue, 'lunar:03-04');
  assert.equal(factFromStatement('我的农历生日是12月31日'), null, 'lunar days cannot exceed 30');
  assert.equal(factFromStatement('我的生日是13月2日'), null);
  assert.equal(factFromStatement('My birthday is March 4').canonicalValue, 'solar:03-04');
  assert.equal(factFromStatement('I was born on 1992-02-29').canonicalValue, 'solar:02-29');
  assert.equal(factFromStatement('I was born on 1991-02-29'), null);
  assert.equal(factFromStatement('My lunar birthday is 3/4').canonicalValue, 'lunar:03-04');
  assert.equal(factFromStatement('如果我的生日是3月4日'), null);
  assert.equal(factFromStatement('给张三发消息：他的生日是3月4日'), null, 'another person’s birthday is not the user’s fact');
  assert.equal(factFromStatement('农历3月4日'), null, 'a date without a self-statement prefix is ambiguous');
  assert.equal(factFromStatement('我的生日是3月4日吗'), null);
  assert.equal(factFromStatement('我的生日是三月四日'), null, 'unsupported date formats fail closed');
}

function testMemoryCompatibility() {
  assert.equal(factFromMemory({ key: 'user.name', canonicalValue: ' Alice ' }).canonicalValue, 'alice');
  assert.equal(factFromMemory({ key: 'user.name', content: '我叫李雷', evidence: '我叫李雷' }).canonicalValue, '李雷');
  assert.equal(factFromMemory({ key: 'user.birthday', anniversary: { calendar: 'lunar', month: 8, day: 15 } }).canonicalValue, 'lunar:08-15');
  assert.equal(factFromMemory({ key: 'user.birthday', evidence: '我的生日是2月29日' }).canonicalValue, 'solar:02-29');
  assert.equal(factFromMemory({ key: 'unrelated.key', evidence: '我叫李雷' }), null, 'a different explicit key is not reclassified');
  assert.equal(factFromMemory({ content: 'Call me Alice' }).key, 'user.name', 'legacy unkeyed records can be recovered from their statement');
  assert.equal(factFromMemory({ key: 'user.birthday', anniversary: { calendar: 'solar', month: 4, day: 31 } }), null);
}

function testQuestionKeys() {
  assert.deepEqual(keysForQuestion('我叫什么？'), ['user.name']);
  assert.deepEqual(keysForQuestion('你还记得我的名字吗'), ['user.name']);
  assert.deepEqual(keysForQuestion('What is my name?'), ['user.name']);
  assert.deepEqual(keysForQuestion('你知道我的生日是哪天吗？'), ['user.birthday']);
  assert.deepEqual(keysForQuestion('When is my birthday?'), ['user.birthday']);
  assert.deepEqual(keysForQuestion('你叫什么名字？'), [], 'the assistant’s name is not the user’s fact');
  assert.deepEqual(keysForQuestion('他生日是哪天？'), [], 'another person’s birthday is excluded');
  assert.deepEqual(keysForQuestion('我叫Alice'), [], 'a statement is not a question');
  assert.deepEqual(keysForQuestion('“我叫什么？”'), [], 'quoted question text is not an explicit request');
  assert.deepEqual(keysForQuestion('我什么时候去生日派对？'), [], 'a birthday event is not a question about the user’s birthday');
  assert(keysForQuestion('What is my name? When is my birthday?').length <= 2);
}

testNames();
testBirthdays();
testMemoryCompatibility();
testQuestionKeys();
console.log('User fact parsing checks passed');
