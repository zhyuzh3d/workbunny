'use strict';

// A voice seal controls new durable effects, not read-only planning. Waits
// happen before acquiring a Task write/admission lane; inside it only assert.
function admissionError(cancelled = false) {
  return Object.assign(new Error(cancelled ? '这次交办已被新的输入或控制替换，未开始执行。' :
    '语音确认尚未恢复；已保存的输入保持暂停，未开始执行。'),
  { code: cancelled ? 'ABORT_ERR' : 'E_VOICE_COMMIT_UNCONFIRMED', dispatched: false });
}
function assertAdmission(gate, live = () => true) {
  if (!live() || gate && (gate.accepted !== true || !gate.isCurrent?.())) throw admissionError(true);
  if (gate && !gate.canCommit?.()) throw admissionError();
}
async function waitAdmission(gate, { signal, live = () => true } = {}) {
  if (!gate) { if (signal?.aborted || !live()) throw admissionError(true); return; }
  if (signal?.aborted || !live() || gate.accepted !== true || !gate.isCurrent?.()) throw admissionError(true);
  if (gate.canCommit?.()) return;
  const wait = require('./bounded-wait').createBoundedWait({ signal, timeoutMs: 8000,
    code: 'E_VOICE_COMMIT_UNCONFIRMED', message: admissionError().message });
  try {
    if (!await wait.run(innerSignal => gate.waitForCommit?.({ signal: innerSignal }))) throw admissionError();
    assertAdmission(gate, () => !signal?.aborted && live());
  } finally { wait.close(); }
}
module.exports = { assertAdmission, waitAdmission };
