'use strict';

// Correlate only our explicit GUI handoff. Never use the monitor's "latest task"
// as evidence for a different delegated request.
function observeWorkBuddy(monitor, task) {
  if (!monitor?.sessions || !task?.id || !Number.isFinite(task.submittedAt) || task.submittedAt <= 0) return null;
  const found = [];
  for (const entry of monitor.sessions.values()) {
    const snap = entry.snap;
    if (!snap?.sessionId || (task.monitorSessionId && snap.sessionId !== task.monitorSessionId)) continue;
    const rows = [snap.task, ...(snap.history || [])].filter(Boolean);
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const previous = task.previousMonitorMessageKey ? row.messageKey === task.previousMonitorMessageKey : row.id === task.previousMonitorTaskId;
      if (row.bunnyTaskId !== task.id || previous ||
          !Number.isFinite(row.startedAt) || row.startedAt < task.submittedAt - 2000) continue;
      if (task.monitorMessageKey ? row.messageKey !== task.monitorMessageKey : task.monitorTaskId && row.id !== task.monitorTaskId) continue;
      const status = row.endReason === 'superseded' ? 'abandoned' : row.status;
      if (!['running', 'ok', 'failed', 'abandoned'].includes(status)) continue;
      found.push({ sessionId: snap.sessionId, taskId: row.id, status,
        ...(row.messageKey ? { messageKey: row.messageKey } : {}),
        summary: String(row.summary || '').slice(0, 6000), startedAt: row.startedAt,
        updatedAt: row.endedAt || snap.lastEventAt, model: row.model || null });
    }
  }
  // Ambiguous duplicate markers must never authorize a reply to either session.
  return found.length === 1 ? found[0] : null;
}

module.exports = { observeWorkBuddy };
