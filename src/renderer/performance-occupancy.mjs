// A performance owns the body from dispatch through its actual playback end.
// Retired identities also prevent cancellation that arrives before dispatch from
// being undone by a late event.
export function createPerformanceOccupancy(report, limit = 128) {
  let current = null;
  const retired = new Set();
  function remember(id) {
    if (!id) return;
    retired.delete(id); retired.add(id);
    while (retired.size > limit) retired.delete(retired.values().next().value);
  }
  function end(entry, phase) {
    if (!entry || current !== entry) return false;
    current = null;
    remember(entry.performanceId);
    report({ ...entry, phase, ok: phase === 'finished' });
    return true;
  }
  return {
    begin(event, avatar) {
      if (!event.performanceId || retired.has(event.performanceId) || current?.performanceId === event.performanceId) return null;
      if (current) end(current, 'cancelled');
      current = { key: event.key, requestId: event.requestId, reason: 'performance', performanceId: event.performanceId, avatar };
      return current;
    },
    current: () => current,
    isCurrent: entry => !!entry && current === entry && !retired.has(entry.performanceId),
    allows: event => !current || (event?.reason === 'performance' && event.performanceId === current.performanceId),
    started(entry, playback) { if (this.isCurrent(entry)) report({ ...entry, phase: 'started', ok: true, ...(playback ? { playback } : {}) }); },
    finish: (entry, phase = 'finished') => end(entry, phase),
    cancel(id) {
      remember(id);
      if (current?.performanceId === id) { const entry = current; end(entry, 'cancelled'); return entry; }
      return null;
    },
  };
}
