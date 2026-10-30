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
  offer(feature) {
    const vector = unit(feature?.vector);
    if (this.enrollment && vector && feature.quality >= .2 && feature.frames >= 12) {
      const pending = this.enrollment;
      pending.vectors.push(vector); pending.duration += Math.min(1200, Math.max(0, Number(feature.durationMs) || 0));
      if (pending.duration >= 2500) {
        clearTimeout(pending.timer); this.enrollment = null;
        const sample = mean(pending.vectors), old = this.profile?.samples || [];
        if (!sample || old.length && cosine(sample, mean(old)) < .8) { pending.reject(Error('这段声音与先前差异太大，请保持同一麦克风并重新录制')); return this.classify(feature); }
        const samples = [...old, sample].slice(-6);
        const center = mean(samples), within = Math.min(...samples.map(v => cosine(v, center)));
        this.profile = { schema: 'local-speaker/v1', samples, threshold: Math.max(.84, Math.min(.96, within - .035)), device: this.device, enrolledAt: this.clock() };
        pending.resolve({ samples: samples.length, ready: samples.length >= 3 });
      }
    }
    const result = this.classify(feature); this.latest = { ...result, at: this.clock() }; return result;
  }
  enroll({ timeoutMs = 20000 } = {}) {
    if (this.enrollment) return Promise.reject(Error('正在录入，请先完成当前这段'));
    if (this.profile?.device && this.device && this.profile.device !== this.device) { this.profile = null; this.latest = null; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.enrollment = null; reject(Error('没有录到足够清楚的人声，请靠近麦克风再读一段')); }, timeoutMs);
      this.enrollment = { resolve, reject, timer, vectors: [], duration: 0 };
    });
  }
  acceptsText() {
    if (this.enrollment) return false;
    return !this.enabled || !!(this.latest?.accepted && this.clock() - this.latest.at < 6000);
  }
  status() { return { enabled: this.enabled, samples: this.profile?.samples.length || 0, ready: (this.profile?.samples.length || 0) >= 3,
    enrolling: !!this.enrollment, latest: this.latest ? { status: this.latest.status, score: this.latest.score } : null, approximate: true }; }
  reset() { this.cancel(); this.profile = null; this.latest = null; this.enabled = false; }
  cancel() { if (this.enrollment) { clearTimeout(this.enrollment.timer); this.enrollment.reject(Error('录入已取消')); this.enrollment = null; } }
}
module.exports = { SpeakerFilter, unit, cosine, mean, DIMENSION };
