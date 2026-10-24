'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {makeReplyGate}=require('../src/main/reply-policy');
const {makeSentenceSplitter}=require('../src/main/llm');
test('split skip marker never leaks as a response; regular replies pass immediately',()=>{
 for(const pieces of [['<','sk','ip','>'],[' ','< SK','IP /','>']]){const output=[];const gate=makeReplyGate(t=>output.push(t));pieces.forEach(t=>gate.push(t));gate.flush();assert.equal(gate.skipped,true);assert.deepEqual(output,[]);}
 const output=[];const gate=makeReplyGate(t=>output.push(t));gate.push('在呢。');assert.deepEqual(output,['在呢。']);gate.push('你说。');gate.flush();assert.deepEqual(output,['在呢。','你说。']);
});
test('a one-call answer keeps short sentences and the final fragment exactly once',()=>{
 const output=[];const splitter=makeSentenceSplitter(t=>output.push(t));['好','。','我在','呢'].forEach(t=>splitter.push(t));splitter.flush();assert.deepEqual(output,['好。','我在呢']);
});
