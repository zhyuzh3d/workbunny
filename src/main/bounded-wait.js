'use strict';
const deadlines=new WeakMap();
const deadlineAt=signal=>signal&&deadlines.get(signal);
function inheritDeadline(signal,parent,at=Infinity){const end=Math.min(deadlineAt(signal)??Infinity,deadlineAt(parent)??Infinity,at);if(signal&&Number.isFinite(end))deadlines.set(signal,end);return end;}
const remainingMs=(signal,fallback=Infinity)=>Math.max(0,Math.min(fallback,Number.isFinite(deadlineAt(signal))?deadlineAt(signal)-Date.now():Infinity));

// This bounds the caller's wait, not an underlying mutation. Never use it to
// release a serial write lane while its previous write can still be running.
function createBoundedWait({ signal, controller = new AbortController(), timeoutMs = 55000,
  code = 'E_WAIT_TIMEOUT', message = '等待超时，请稍后重试。', setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const cancelled = () => controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError' ? controller.signal.reason
    : Object.assign(new Error('操作已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const duration = Number(timeoutMs);
  const now=Date.now(),end=inheritDeadline(controller.signal,signal,now+(Number.isFinite(duration)&&duration>0?duration:55000));
  if(end<=now&&!controller.signal.aborted)controller.abort(Object.assign(new Error(message),{code}));
  const timer = setTimer(() => controller.abort(Object.assign(new Error(message), { code })),Math.max(0,end-now));
  const run = (invoke, limit = {}) => new Promise((resolve, reject) => {
    let settled = false, stepTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimer(stepTimer); controller.signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(cancelled());
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) { abort(); return; }
    if (Number.isFinite(limit.timeoutMs) && limit.timeoutMs > 0) stepTimer = setTimer(() => controller.abort(
      Object.assign(new Error(limit.message || message), { code: limit.code || code })), limit.timeoutMs);
    // Invoke only while current, and always observe late rejections.
    try { Promise.resolve(invoke(controller.signal)).then(value => finish(null, value), error => finish(error)); }
    catch (error) { finish(error); }
  });
  return { signal: controller.signal, run, close() { clearTimer(timer); signal?.removeEventListener('abort', cancel); } };
}
module.exports = { createBoundedWait,deadlineAt,inheritDeadline,remainingMs };
