'use strict';

const overrides = require('./performance-loop-overrides.json');
const TARGET_MS = 4000;

// This is presentation metadata, independent of idle selection, asset editing
// and the original loop-processing flag. Short duration or matching endpoints
// alone never promote an unknown animation to a repeatable performance.
function performancePlayback(motion = {}) {
  let mode = motion.loop === true ? 'cycle' : 'once';
  const reviewed = !motion.personal && overrides[motion.key];
  if (reviewed && reviewed.sourceId === motion.sourceId) mode = reviewed.mode;
  if (['once', 'cycle'].includes(motion.performanceMode)) mode = motion.performanceMode;
  // Transitions and composed stories have an entrance/end and must settle once.
  if (motion.transition || motion.postureChanging || motion.sourceId?.startsWith('sequence__')) mode = 'once';
  return Object.freeze({ mode, targetMs: TARGET_MS });
}

module.exports = { performancePlayback, TARGET_MS };
