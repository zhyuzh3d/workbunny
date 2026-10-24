/* Conservative, in-memory cleanup for animation tracks. Original VRMA files stay untouched. */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function qDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
function qNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-10 && Number.isFinite(n) ? q.map((v) => v / n) : null;
}
function qAngle(a, b) { return 2 * Math.acos(clamp(Math.abs(qDot(a, b)), -1, 1)); }
function qSlerp(a, b, t) {
  let dot = qDot(a, b), end = b;
  if (dot < 0) { dot = -dot; end = b.map((v) => -v); }
  if (dot > 0.9995) return qNormalize(a.map((v, i) => v + (end[i] - v) * t));
  const theta = Math.acos(clamp(dot, -1, 1)), sin = Math.sin(theta);
  const x = Math.sin((1 - t) * theta) / sin, y = Math.sin(t * theta) / sin;
  return qNormalize(a.map((v, i) => v * x + end[i] * y));
}
function strideOf(track) { return track.getValueSize ? track.getValueSize() : track.values.length / track.times.length; }
function trackReport(track) {
  const stride = strideOf(track), type = track.name.endsWith('.quaternion') ? 'quaternion'
    : track.name.endsWith('.position') ? 'position' : track.name.endsWith('.scale') ? 'scale' : 'other';
  const values = track.values, times = track.times, count = times.length;
  let invalid = 0, signFlips = 0, outliers = 0, seamGap = 0;
  const q = [];
  for (let i = 0; i < count; i++) {
    const v = Array.from(values.subarray(i * stride, (i + 1) * stride));
    if (type === 'quaternion') {
      const n = Math.hypot(...v);
      if (!Number.isFinite(n) || n < 0.8 || n > 1.2) invalid++;
      q.push(qNormalize(v));
    }
  }
  if (type === 'quaternion' && count > 1 && q.every(Boolean)) {
    for (let i = 1; i < count; i++) {
      if (qDot(q[i - 1], q[i]) < 0) signFlips++;
      seamGap = qAngle(q[0], q[count - 1]);
      if (i < count - 1 && times[i] > times[i - 1] && times[i + 1] > times[i]) {
        const gap = qAngle(q[i - 1], q[i + 1]);
        if (qAngle(q[i - 1], q[i]) > 1.35 && qAngle(q[i], q[i + 1]) > 1.35 && gap < 0.30) outliers++;
      }
    }
  } else if ((type === 'position' || type === 'scale') && count > 2 && stride === 3) {
    for (let i = 1; i < count - 1; i++) {
      const d = times[i + 1] - times[i - 1];
      if (!(d > 0)) continue;
      let dev = 0, adjacent = 0;
      for (let k = 0; k < 3; k++) {
        const a = values[(i - 1) * 3 + k], b = values[i * 3 + k], c = values[(i + 1) * 3 + k];
        const expect = a + (c - a) * ((times[i] - times[i - 1]) / d);
        dev = Math.max(dev, Math.abs(b - expect));
        adjacent = Math.max(adjacent, Math.abs(c - a));
      }
      if (dev > (type === 'position' ? 0.08 : 0.15) && dev > adjacent * 5) outliers++;
    }
  }
  if (type === 'quaternion' && count > 1 && q.every(Boolean)) seamGap = qAngle(q[0], q[count - 1]);
  else if ((type === 'position' || type === 'scale') && count > 1) {
    let d = 0;
    for (let k = 0; k < stride; k++) d += (values[k] - values[(count - 1) * stride + k]) ** 2;
    seamGap = Math.sqrt(d);
  }
  return { type, keys: count, invalid, signFlips, outliers, seamGap };
}

function closeMotionLoop(track, type, duration) {
  const size = strideOf(track), count = track.times.length, values = track.values;
  if (count < 2 || !(duration > 0.5) || !track.createInterpolant) return false;
  const first = Array.from(values.subarray(0, size));
  const last = Array.from(values.subarray((count - 1) * size, count * size));
  let gap;
  if (type === 'quaternion' && size === 4) {
    const a = qNormalize(first), b = qNormalize(last);
    if (!a || !b) return false;
    gap = qAngle(a, b);
    if (gap < 0.06) return false;
  } else {
    gap = Math.hypot(...first.map((v, i) => v - last[i]));
    // A large root translation is likely intentional locomotion or a unit mismatch.
    // Leave it for review instead of sweeping the entire character back to its origin.
    if (gap < 0.01 || gap > (type === 'position' ? 0.5 : 0.4)) return false;
  }
  const desiredWindow = type === 'quaternion' ? clamp(gap * 0.27, 0.25, 0.8) : clamp(gap * 0.8, 0.25, 0.8);
  const window = Math.min(desiredWindow, duration * 0.45);
  if (window < 0.12) return false;
  const start = duration - window;
  const interpolant = track.createInterpolant();
  const startValue = Array.from(interpolant.evaluate(start)).slice(0, size);
  const q0 = type === 'quaternion' ? qNormalize(startValue) : null;
  const q1 = type === 'quaternion' ? qNormalize(first) : null;
  if (type === 'quaternion' && (!q0 || !q1)) return false;
  const oldTimes = Array.from(track.times), oldValues = Array.from(values);
  const newTimes = oldTimes.filter((time) => time < start - 1e-5);
  const newValues = [];
  for (let i = 0; i < oldTimes.length; i++) {
    if (oldTimes[i] < start - 1e-5) newValues.push(...oldValues.slice(i * size, (i + 1) * size));
  }
  const samples = 4;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, eased = t * t * (3 - 2 * t);
    newTimes.push(start + window * t);
    if (type === 'quaternion' && size === 4) {
      newValues.push(...qSlerp(q0, q1, eased));
    } else {
      newValues.push(...startValue.map((v, k) => v + (first[k] - v) * eased));
    }
  }
  track.times = Float32Array.from(newTimes);
  track.values = Float32Array.from(newValues);
  return true;
}

/** Analyze or repair a clip. Repairs are limited to invalid/sign-flipped quaternions,
 * isolated single-key spikes with near-identical neighbors, and loop seam tails. */
export function processMotionClip(clip, { loop = false, repair = true } = {}) {
  const result = { tracks: 0, quaternionKeysNormalized: 0, quaternionSignFlips: 0,
    isolatedSpikesRepaired: 0, loopSeamsSmoothed: 0, findings: [] };
  for (const track of clip.tracks || []) {
    const stride = strideOf(track), times = track.times, values = track.values, count = times.length;
    const before = trackReport(track);
    result.tracks++;
    const isQ = before.type === 'quaternion';
    if (!isQ && !['position', 'scale'].includes(before.type)) continue;
    const read = (i) => Array.from(values.subarray(i * stride, (i + 1) * stride));
    const write = (i, v) => { for (let k = 0; k < stride; k++) values[i * stride + k] = v[k]; };
    if (isQ && stride === 4) {
      let previous = null;
      for (let i = 0; i < count; i++) {
        const raw = read(i), unit = qNormalize(raw);
        if (!unit) { result.findings.push({ track: track.name, key: i, issue: 'zero-or-nonfinite-quaternion' }); continue; }
        if (repair && Math.abs(Math.hypot(...raw) - 1) > 1e-5) { write(i, unit); result.quaternionKeysNormalized++; }
        let q = unit;
        if (previous && qDot(previous, q) < 0) {
          if (repair) { q = q.map((v) => -v); write(i, q); }
          result.quaternionSignFlips++;
        }
        previous = q;
      }
      if (repair && count > 2) {
        for (let i = 1; i < count - 1; i++) {
          const a = qNormalize(read(i - 1)), b = qNormalize(read(i)), c = qNormalize(read(i + 1));
          if (!a || !b || !c) continue;
          if (times[i] <= times[i - 1] || times[i + 1] <= times[i]) continue;
          if (qAngle(a, b) > 1.35 && qAngle(b, c) > 1.35 && qAngle(a, c) < 0.30) {
            write(i, qSlerp(a, c, (times[i] - times[i - 1]) / (times[i + 1] - times[i - 1])));
            result.isolatedSpikesRepaired++;
          }
        }
      }
      if (repair && loop && closeMotionLoop(track, 'quaternion', clip.duration || times[count - 1])) result.loopSeamsSmoothed++;
    } else if (repair && stride === 3 && count > 2) {
      for (let i = 1; i < count - 1; i++) {
        const d = times[i + 1] - times[i - 1];
        if (!(d > 0)) continue;
        const a = read(i - 1), b = read(i), c = read(i + 1), t = (times[i] - times[i - 1]) / d;
        let dev = 0, adjacent = 0;
        const expected = a.map((v, k) => { const e = v + (c[k] - v) * t; dev = Math.max(dev, Math.abs(b[k] - e)); adjacent = Math.max(adjacent, Math.abs(c[k] - v)); return e; });
        if (dev > (before.type === 'position' ? 0.08 : 0.15) && dev > adjacent * 5) {
          write(i, expected); result.isolatedSpikesRepaired++;
        }
      }
      if (repair && loop && closeMotionLoop(track, before.type, clip.duration || times[count - 1])) result.loopSeamsSmoothed++;
    }
    const after = trackReport(track);
    if (before.invalid || before.signFlips || before.outliers || (loop && before.seamGap > 0.06)) {
      result.findings.push({ track: track.name, before, after });
    }
  }
  if (repair && loop && clip.resetDuration) clip.resetDuration();
  return result;
}

export function analyzeMotionTracks(tracks, { loop = false } = {}) {
  return tracks.map((track) => ({ name: track.name, ...trackReport(track), loop }));
}

/** Start a new action while preserving the live weights of interrupted fades.
 * Three.js crossFadeFrom/fadeOut schedules a 1→0 multiplier every time, which
 * can make a partially faded action jump back toward full weight on interruption. */
export function crossFadeMotionAction(next, previous, duration, activeActions = []) {
  const fadeCurrentWeightOut = (action) => {
    if (!action) return;
    const weight = action.getEffectiveWeight();
    action.stopFading();
    if (!(weight > 1e-4)) { action.stop(); return; }
    action.setEffectiveWeight(weight);
    action.fadeOut(duration);
  };
  for (const action of activeActions) {
    if (action !== next && action !== previous) fadeCurrentWeightOut(action);
  }
  fadeCurrentWeightOut(previous);
  next.stopFading();
  next.reset();
  next.setEffectiveWeight(1);
  next.play();
  next.fadeIn(duration);
  return next;
}
