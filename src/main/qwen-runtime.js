'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
function cancelled() { return Object.assign(new Error('本地语音合成已停止'), { name: 'AbortError' }); }
function wav(pcm, rate = 24000) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm]);
}
function createRuntime({ findBinary, files, timeoutMs = 120000, idleMs = 10 * 60000, spawnProcess = spawn }) {
  let child, modelKey, ready, startReject, pending, startTimer, idleTimer, cancelTimer;
  let tail = Promise.resolve(), epoch = 0, queued = 0, sequence = 0, initialMs = 0, loaded = false, information;
  function stop(error = cancelled()) {
    clearTimeout(startTimer); clearTimeout(idleTimer); clearTimeout(cancelTimer);
    const previous = child; child = null; ready = null; modelKey = null; loaded = false; information = null;
    startReject?.(error); startReject = null;
    if (pending) { const active = pending; pending = null; clearTimeout(active.timer); active.reject(error); }
    if (previous) {
      previous.stdin.destroy(); previous.kill('SIGTERM');
      const force = setTimeout(() => { try { previous.kill('SIGKILL'); } catch {} }, 1500); force.unref();
      previous.once('exit', () => clearTimeout(force));
    }
  }
  function close() { epoch++; stop(); }
  function releaseLater() {
    clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!queued) stop(); }, idleMs); idleTimer.unref();
  }
  function ensure(dir) {
    clearTimeout(idleTimer);
    const binary = findBinary();
    if (!binary) return Promise.reject(new Error('本地语音引擎缺失，请重新安装应用'));
    const key = [binary, dir, ...files.map((f) => fs.statSync(path.join(dir, f.name)).mtimeMs)].join(':');
    if (child && modelKey === key) { if (!queued) releaseLater(); return ready; }
    stop(); modelKey = key;
    const started = Date.now();
    const current = spawnProcess(binary, ['worker', path.join(dir, files[0].name), '--device', 'gpu'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = current;
    ready = new Promise((resolve, reject) => {
      startReject = reject;
      startTimer = setTimeout(() => { if (child === current) stop(new Error('本地语音引擎启动超时')); }, 90000);
      const lines = readline.createInterface({ input: current.stdout });
      current.stderr.on('data', () => {});
      current.stdin.on('error', () => { if (child === current) stop(new Error('本地语音引擎连接中断')); });
      lines.on('line', (line) => {
        if (child !== current) return;
        try {
          if (line.length > 4 * 1024 * 1024) throw new Error('本地语音响应过大');
          const message = JSON.parse(line);
          if (message.type === 'fatal') throw new Error('CustomVoice 模型加载失败');
          if (message.type === 'ready') {
            if (message.protocol !== 3 || message.model?.sample_rate !== 24000 || !/CustomVoice/i.test(message.model?.name || ''))
              throw new Error('本地语音引擎与 CustomVoice 模型不匹配');
            information = message.model; loaded = true; initialMs = Date.now() - started;
            clearTimeout(startTimer); startReject = null; resolve(); releaseLater(); return;
          }
          if (!pending || message.id !== pending.id) return;
          const active = pending;
          if (message.type === 'chunk') {
            if (message.seq !== active.sequence++) throw new Error('本地音频分片顺序异常');
            const pcm = Buffer.from(message.pcm || '', 'base64');
            if (!pcm.length || pcm.length % 2) throw new Error('本地音频分片无效');
            active.bytes += pcm.length;
            if (active.bytes > 48000 * 60) throw new Error('本地音频超出长度限制');
            const now = Date.now();
            if (!active.firstMs) active.firstMs = now - active.started;
            active.maxGapMs = Math.max(active.maxGapMs, now - active.lastChunk); active.lastChunk = now;
            active.chunks.push(pcm);
            if (active.epoch === epoch) active.onChunk?.(pcm, { sampleRate: 24000, elapsedMs: now - active.started });
          } else if (['end', 'error', 'cancelled'].includes(message.type)) {
            pending = null; clearTimeout(active.timer); clearTimeout(cancelTimer);
            if (active.epoch !== epoch || message.type === 'cancelled') { active.reject(cancelled()); return; }
            if (message.type === 'error') { active.reject(new Error('CustomVoice 合成失败')); return; }
            if (message.stop !== 'complete' || message.samples * 2 !== active.bytes) { active.reject(new Error('CustomVoice 音频未完整生成')); return; }
            const totalMs = Date.now() - active.started, audioSeconds = active.bytes / 48000;
            active.resolve({ buffer: wav(Buffer.concat(active.chunks)), streamed: !!active.onChunk,
              stats: { firstMs: active.firstMs, totalMs, audioSeconds, rtf: totalMs / 1000 / audioSeconds, maxGapMs: active.maxGapMs } });
          }
        } catch (error) { stop(error); }
      });
      current.on('error', () => { if (child === current) stop(new Error('无法启动 CustomVoice 引擎')); });
      current.on('exit', () => { lines.close(); if (child === current) stop(new Error('CustomVoice 引擎已退出')); });
    });
    ready.catch(() => {}); return ready;
  }
  function synthesize(text, q, options = {}) {
    const generation = epoch; queued++;
    const task = tail.then(async () => {
      if (generation !== epoch) throw cancelled();
      await ensure(q.dir);
      if (generation !== epoch) throw cancelled();
      const id = String(++sequence), started = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(new Error('CustomVoice 合成超时')), timeoutMs);
        pending = { id, epoch: generation, resolve, reject, timer, sequence: 0, chunks: [], bytes: 0,
          started, firstMs: 0, lastChunk: started, maxGapMs: 0, onChunk: options.onChunk };
        child.stdin.write(JSON.stringify({ type: 'synthesize', id, text, voice: q.voice || 'serena',
          language: /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en', max_seconds: 45,
          ...(options.seed === undefined ? {} : { seed: options.seed }) }) + '\n');
      });
    }).catch((e) => { if (generation !== epoch) throw cancelled(); throw e; })
      .finally(() => { queued--; releaseLater(); });
    tail = task.catch(() => {}); return task;
  }
  function cancel() {
    if (!queued) return;
    epoch++;
    if (pending && child) {
      child.stdin.write(JSON.stringify({ type: 'cancel', id: pending.id }) + '\n');
      clearTimeout(cancelTimer); cancelTimer = setTimeout(() => stop(cancelled()), 2000); cancelTimer.unref();
    }
  }
  return { synthesize, prewarm: ensure, close, cancel,
    status: () => ({ running: !!child, ready: loaded, queued, initMs: initialMs, voices: information?.voices || [] }) };
}
module.exports = { createRuntime, wav };
