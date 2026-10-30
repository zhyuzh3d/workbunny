'use strict';
const DIMENSION = 28;
function unit(vector) {
  if (!Array.isArray(vector) || vector.length !== DIMENSION || vector.some(x => !Number.isFinite(x))) return null;
  const norm = Math.hypot(...vector); return Number.isFinite(norm) && norm > 1e-8 ? vector.map(x => x / norm) : null;
}
function cosine(a, b) { return Math.max(-1, Math.min(1, a.reduce((sum, x, i) => sum + x * b[i], 0))); }
function mean(vectors) { return unit(Array.from({ length: DIMENSION }, (_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length)); }
class SpeakerFilter {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.profile = null; this.enabled = false; this.enrollment = null; this.latest = null; this.device = ''; }
  load(profile) {
    this.latest = null;
    if (!profile || profile.schema !== 'local-speaker/v1' || !Array.isArray(profile.samples) || !profile.samples.length || profile.samples.length > 6 || profile.samples.some(v => !unit(v))) { this.profile = null; return; }
    const samples = profile.samples.map(unit);
    if (!mean(samples)) { this.profile = null; return; }
    this.profile = { schema: profile.schema, samples, threshold: Math.max(.84, Math.min(.98, Number(profile.threshold) || .9)), device: String(profile.device || '').slice(0,256), enrolledAt: Number(profile.enrolledAt) || 0 };
  }
  classify(feature) {
    const vector = unit(feature?.vector), quality = Number(feature?.quality), frames = Number(feature?.frames);
    if (!vector || !Number.isFinite(quality) || !Number.isFinite(frames) || quality < 0.2 || frames < 12) return { accepted: false, status: 'insufficient', score: 0 };
    if (!this.enabled) return { accepted: true, status: 'unfiltered', score: null };
    if (!this.profile || this.profile.samples.length < 3) return { accepted: false, status: 'needs-enrollment', score: 0 };
    if (this.profile.device && this.device && this.profile.device !== this.device) return { accepted: false, status: 'device-changed', score: 0 };
    const center = mean(this.profile.samples), score = .75 * cosine(vector, center) + .25 * Math.max(...this.profile.samples.map(v => cosine(vector, v)));
    const threshold = Number(this.profile.threshold) || .9;
    return { accepted: score >= threshold, status: score >= threshold ? 'owner' : score >= threshold - .035 ? 'uncertain' : 'other', score };
  }
  enrollmentProgress(pending) {
    if (this.enrollment !== pending) return;
    pending.onProgress?.();
  }
  heard(text) {
    const pending = this.enrollment, value = String(text || '').trim();
    if (!pending || !value || value === pending.text) return;
    pending.text = value; pending.lastTextAt = this.clock(); this.enrollmentActivity(pending);
  }
  enrollmentActivity(pending) {
    if (this.enrollment !== pending) return;
    if (!pending.started) {
      pending.started = true; clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.cancel('录入时间过长，请停下后重新朗读'), pending.timeoutMs);
    }
    clearTimeout(pending.quietTimer);
    pending.quietTimer = setTimeout(() => this.finishEnrollment(pending), pending.quietMs);
    this.enrollmentProgress(pending);
  }
  finishEnrollment(pending) {
    if (this.enrollment !== pending) return;
    if (pending.vectors.length < 6 || pending.duration < 1800) { this.cancel('这次没听清足够的声音，请靠近麦克风重新朗读'); return; }
    const samples = [0, 1, 2].map(i => mean(pending.vectors.slice(Math.floor(pending.vectors.length * i / 3), Math.floor(pending.vectors.length * (i + 1) / 3))));
    const center = samples.every(Boolean) && mean(samples);
    if (!center || samples.some(sample => cosine(sample, center) < .8)) { this.cancel('声音变化较大，请在安静的环境重新朗读'); return; }
    clearTimeout(pending.timer); clearTimeout(pending.quietTimer); this.enrollment = null;
    const within = Math.min(...samples.map(sample => cosine(sample, center)));
    this.profile = { schema:'local-speaker/v1', samples, threshold:Math.max(.84, Math.min(.96, within - .035)), device:pending.device, enrolledAt:this.clock() };
    this.phase = 'complete'; this.note = '已记住你的声音'; pending.onProgress?.();
    pending.resolve({ samples:3, ready:true });
  }
  offer(feature) {
    const vector = unit(feature?.vector), pending = this.enrollment;
    const speech = feature?.speech !== false || !!pending?.text && this.clock() - pending.lastTextAt < 2000;
    if (pending && vector && speech && feature.quality >= .2 && feature.frames >= 12) {
      if (pending.device && this.device && pending.device !== this.device) this.cancel('麦克风变了，请重新朗读');
      else {
        pending.device ||= this.device;
        pending.vectors.push(vector); pending.vectors = pending.vectors.slice(-96);
        pending.duration += Math.min(1200, Math.max(0, Number(feature.durationMs) || 0));
        this.enrollmentActivity(pending);
      }
    }
    const result = this.classify(feature); this.latest = { ...result, at:this.clock() }; return result;
  }
  enroll({ timeoutMs = 45000, quietMs = 1500, startTimeoutMs = 12000, onProgress } = {}) {
    if (this.enrollment) return Promise.reject(Error('正在录入声音'));
    this.phase = 'waiting'; this.note = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel('没有听到声音，请检查麦克风后重试'), startTimeoutMs === 12000 ? Math.min(startTimeoutMs, timeoutMs) : startTimeoutMs);
      this.enrollment = { resolve, reject, timer, quietMs, timeoutMs, onProgress, quietTimer:null, vectors:[], duration:0, device:this.device, started:false, text:'', lastTextAt:0 };
    });
  }
  acceptsText() {
    if (this.enrollment) return false;
    return !this.enabled || !!(this.latest?.accepted && this.clock() - this.latest.at < 6000);
  }
  status() {
    const pending = this.enrollment;
    return { enabled:this.enabled, samples:this.profile?.samples.length || 0, ready:(this.profile?.samples.length || 0) >= 3,
      enrolling:!!pending, progress:pending ? Math.min(3, Math.floor(pending.vectors.length / 2)) : 0,
      phase:pending ? pending.started ? 'recording' : 'waiting' : this.phase || 'idle',
      percent:pending ? Math.min(90, Math.round(pending.vectors.length / 6 * 90)) : this.phase === 'complete' ? 100 : 0,
      seconds:pending ? Math.round(pending.duration / 100) / 10 : 0, note:this.note || '',
      latest:this.latest ? { status:this.latest.status, score:this.latest.score } : null, approximate:true };
  }
  reset() { this.cancel(); this.profile = null; this.latest = null; this.enabled = false; this.phase = 'idle'; this.note = ''; }
  reportFailure(message) { this.phase = 'failed'; this.note = message; }
  cancel(message = '已取消朗读') {
    if (!this.enrollment) return;
    const pending = this.enrollment; clearTimeout(pending.timer); clearTimeout(pending.quietTimer); this.enrollment = null;
    this.phase = message === '已取消朗读' ? 'cancelled' : 'failed'; this.note = message;
    pending.onProgress?.(); pending.reject(Error(message));
  }

}
module.exports = { SpeakerFilter, unit, cosine, mean, DIMENSION };
