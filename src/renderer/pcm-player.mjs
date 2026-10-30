// PCM16LE / mono chunks, scheduled against one AudioContext clock.
export function createPCMPlayer({ context, destination, onStart = () => {}, onDone = () => {}, onUnderrun = () => {}, prebufferSeconds = .32 }) {
  let stream = null;
  function stop(id) {
    if (!stream || (id && stream.id !== id)) return;
    for (const source of stream.sources) { source.onended = null; try { source.stop(); } catch {} }
    stream = null;
  }
  function begin(id) { stop(); stream = { id, queue: [], samples: 0, sources: new Set(), started: false, ended: false, nextTime: 0 }; }
  function finish(s) { if (stream === s && s.ended && !s.sources.size && !s.queue.length) { stream = null; onDone(s.id); } }
  function flush(s) {
    if (!s.started) {
      if (!s.ended && s.samples / 24000 < prebufferSeconds) return;
      s.started = true; s.nextTime = context.currentTime + .04; onStart(s.id);
    }
    for (const samples of s.queue.splice(0)) {
      if (s.nextTime < context.currentTime + .005) { onUnderrun(); s.nextTime = context.currentTime + .04; }
      const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination); s.sources.add(source);
      source.onended = () => { s.sources.delete(source); finish(s); };
      source.start(s.nextTime); s.nextTime += samples.length / 24000;
    }
    finish(s);
  }
  function push(id, bytes) {
    const s = stream;
    if (!s || s.id !== id || s.ended || !bytes?.byteLength || bytes.byteLength % 2) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), samples = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    s.samples += samples.length; s.queue.push(samples); flush(s);
  }
  function end(id) { const s = stream; if (!s || s.id !== id) return; s.ended = true; flush(s); }
  return { begin, push, end, stop, get playing() { return !!stream?.started; } };
}
