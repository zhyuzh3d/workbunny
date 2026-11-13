// The policy says whether an action is periodic; only the runtime knows its
// actual duration. Report the resulting whole cycles to the host.
export function performancePlaybackPlan(policy, durationSeconds) {
  if (policy == null) return null;
  if (!policy || !['once', 'cycle'].includes(policy.mode) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Invalid performance playback');
  }
  const clipDurationMs = durationSeconds * 1000;
  if (!Number.isFinite(clipDurationMs) || clipDurationMs <= 0) throw new Error('Invalid performance duration');
  if (policy.mode === 'cycle' && (!Number.isFinite(policy.targetMs) || policy.targetMs <= 0)) throw new Error('Invalid performance target');
  const cycles = policy.mode === 'cycle' ? Math.min(128, Math.max(1, Math.ceil(policy.targetMs / clipDurationMs))) : 1;
  const totalDurationMs = cycles * clipDurationMs;
  if (!Number.isFinite(totalDurationMs)) throw new Error('Invalid performance duration');
  return { mode: policy.mode, cycles, clipDurationMs, totalDurationMs };
}

// Undefined repetitions preserves the original action's loop/once behavior.
export function playbackRepetitions(request, action) {
  if (request?.repetitions !== undefined) {
    if (!Number.isInteger(request.repetitions) || request.repetitions < 1 || request.repetitions > 128) return null;
    return request.repetitions;
  }
  return (request?.loop === undefined ? action.loop : request.loop === true) ? Infinity : 1;
}
