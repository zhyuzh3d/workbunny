'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SpeechEcho, resembles } = require('../src/main/speech-echo');
test('only actual playback can supply self echo evidence', () => {
  let time = 10000; const echo = new SpeechEcho({ now: () => time });
  echo.prepare('one', '这是已经完成的清单');
  assert(!echo.matches('这是已经完成的清单'), 'synthesis is not audible playback');
  assert(!echo.start('old'));
  echo.start('one'); assert(echo.matches('完成的清单'));
  assert(!echo.matches('等一下我想换个问题'));
  echo.end('one'); time += 3100;
  assert(!echo.matches('完成的清单'), 'later owner repetitions remain available');
  assert(!echo.start('one'), 'a late renderer start cannot revive ended audio');
});
test('capture time associates late final with its original playback', () => {
  let time = 10000; const echo = new SpeechEcho({ now: () => time });
  echo.prepare('one', '我已把资料整理完毕'); echo.start('one');
  time = 15000; echo.end('one'); time = 24000;
  assert(echo.matches('把资料整理完毕', { audioStartAtMs: 12000, audioEndAtMs: 14000 }));
  assert(!echo.matches('把资料整理完毕', { audioStartAtMs: 22000, audioEndAtMs: 23000 }));
  assert(!echo.matches('把资料整理完毕', { audioStartAtMs: 5000, audioEndAtMs: 9000 }));
});
test('long replies preserve their opening and separate queued utterances', () => {
  const echo = new SpeechEcho({ now: () => 10000 });
  echo.prepare('one', '先检查今天准备的材料。' + '这里有一些需要耐心阅读的内容。'.repeat(120)); echo.start('one');
  assert(echo.matches('先检查今天准备的材料'));
  echo.prepare('two', '然后我们再讨论下一步');
  assert(!echo.matches('然后我们再讨论下一步'), 'queued text is not playback evidence');
  assert(!echo.matches('阅读的内容然后我们再讨论'), 'unrelated sentence boundaries are not invented');
});
test('recognition substitutions stay bounded and real short interruption remains distinct', () => {
  assert(resembles('接下来我们可以检察结果', '接下来我们可以检查结果。'));
  assert(!resembles('等等', '我已经整理好了'));
  assert(!resembles('有个新问题需要讨论', '我已经整理好报告，接下来可以检查结果'));
});
test('one ASR utterance can cover adjacent actually played sentences', () => {
  let time = 1000; const echo = new SpeechEcho({ now: () => time });
  echo.prepare('one', '第一段已经完整播放。'); echo.start('one'); time = 3000; echo.end('one');
  time = 3060; echo.prepare('two', '第二段正在继续播放。'); echo.start('two'); time = 5000;
  assert(echo.matches('第一段已经完整播放。第二段正在继续播放。', { audioStartAtMs: 1000, audioEndAtMs: 5000 }));
  assert(!echo.matches('第一段已经完整播放。但是我现在有新问题'));
  echo.end('two'); time = 10000; echo.prepare('three', '稍后另一轮回复。'); echo.start('three');
  assert(!echo.matches('第二段正在继续播放。稍后另一轮回复。', { audioStartAtMs: 3060, audioEndAtMs: 10000 }));
});
