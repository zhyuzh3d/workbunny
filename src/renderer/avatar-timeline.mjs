const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const EASINGS = new Set(['linear', 'smooth', 'snap', 'wind', 'cut']);

function finite(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000; }
function onlyKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function validateValue(value) {
  if (finite(value)) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every(finite)) return value.slice();
  throw new Error('Invalid timeline value');
}
function eased(mode, u) {
  if (mode === 'cut') return u >= 1 ? 1 : 0;
  if (mode === 'linear') return u;
  if (mode === 'wind') return u ** 3;
  if (mode === 'snap') return u < .5 ? 4 * u ** 3 : 1 - 4 * (1 - u) ** 3;
  return u * u * (3 - 2 * u);
}
function blend(a, b, u) {
  return Array.isArray(a) ? a.map((value, i) => value + (b[i] - value) * u) : a + (b - a) * u;
}

// Host-defined channel names only; the timeline contains numbers and metadata,
// never property paths, expressions, callbacks or arbitrary code.
export function compileAvatarTimeline(input, { allowedChannels } = {}) {
  if (!onlyKeys(input, ['duration', 'tracks']) || !finite(input.duration) || input.duration <= 0 || input.duration > 300 ||
      !Array.isArray(input.tracks) || input.tracks.length > 256) throw new Error('Invalid timeline');
  const seen = new Set();
  const tracks = input.tracks.map(track => {
    if (!onlyKeys(track, ['channel', 'frames', 'flights']) || typeof track.channel !== 'string' || !ID.test(track.channel) || seen.has(track.channel) ||
        (allowedChannels && !allowedChannels.has(track.channel)) || !Array.isArray(track.frames) ||
        track.frames.length < 1 || track.frames.length > 4096) throw new Error('Invalid timeline track');
    seen.add(track.channel);
    let previousTime = -1, dimension;
    const frames = track.frames.map(frame => {
      if (!onlyKeys(frame, ['time', 'value', 'ease']) || !finite(frame.time) || frame.time < 0 || frame.time > input.duration || frame.time <= previousTime ||
          (frame.ease !== undefined && !EASINGS.has(frame.ease))) throw new Error('Invalid timeline frame');
      previousTime = frame.time;
      const value = validateValue(frame.value), size = Array.isArray(value) ? value.length : 0;
      if (dimension !== undefined && size !== dimension) throw new Error('Inconsistent timeline value');
      dimension = size;
      return { time: frame.time, value, ease: frame.ease || 'smooth' };
    });
    if (track.flights !== undefined && (!Array.isArray(track.flights) || track.flights.length > 128)) throw new Error('Invalid ballistic windows');
    const flights = (track.flights || []).map(window => {
      if (dimension !== 0 || !onlyKeys(window, ['from', 'to', 'y0', 'y1', 'gravity']) || !finite(window.from) || !finite(window.to) || window.from < 0 ||
          window.to > input.duration || window.from >= window.to || !finite(window.y0) || !finite(window.y1) ||
          !finite(window.gravity) || window.gravity < 0) throw new Error('Invalid ballistic window');
      return { from: window.from, to: window.to, y0: window.y0, y1: window.y1, gravity: window.gravity };
    });
    if (flights.some((w, i) => i > 0 && w.from < flights[i - 1].to)) throw new Error('Overlapping ballistic windows');
    return { channel: track.channel, frames, flights };
  });
  return { duration: input.duration, tracks };
}

export function sampleAvatarTimeline(timeline, time) {
  if (!Number.isFinite(time)) throw new Error('Invalid timeline time');
  const t = Math.max(0, Math.min(timeline.duration, time)), result = Object.create(null);
  for (const track of timeline.tracks) {
    const frames = track.frames;
    let index = 0;
    while (index < frames.length - 1 && t > frames[index + 1].time) index++;
    const a = frames[index], b = frames[Math.min(index + 1, frames.length - 1)];
    const u = a === b ? 0 : Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time)));
    let value = blend(a.value, b.value, eased(b.ease, u));
    for (const flight of track.flights) if (t >= flight.from && t <= flight.to) {
      const duration = flight.to - flight.from, q = (t - flight.from) / duration;
      value = flight.y0 + (flight.y1 - flight.y0) * q + .5 * flight.gravity * duration * duration * q * (1 - q);
      break;
    }
    result[track.channel] = value;
  }
  return result;
}
