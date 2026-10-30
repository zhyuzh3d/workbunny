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
    const vector = unit(feature?.vector), pending = this.enrollment;
    if (pending && vector && feature.speech !== false && feature.quality >= .2 && feature.frames >= 12) {
      if (pending.device && this.device && pending.device !== this.device) this.cancel('麦克风变了，请重新朗读');
      else {
        pending.device ||= this.device;
        if (pending.samples.length < 3) {
          pending.vectors.push(vector); pending.vectors = pending.vectors.slice(-32);
          pending.duration += Math.min(1200, Math.max(0, Number(feature.durationMs) || 0));
          if (pending.duration >= 3000) {
            const sample = mean(pending.vectors);
            if (!sample || pending.samples.length && cosine(sample, mean(pending.samples)) < .8) this.cancel('没有听清同一个声音，请重新朗读');
            else { pending.samples.push(sample); pending.vectors = []; pending.duration = 0; }
          }
        }
        // Wait for the owner to finish the passage; its tail must not become a chat.
        if (this.enrollment === pending && pending.samples.length === 3) {
          clearTimeout(pending.quietTimer);
          pending.quietTimer = setTimeout(() => {
            if (this.enrollment !== pending) return;
            clearTimeout(pending.timer); this.enrollment = null;
            const center = mean(pending.samples), within = Math.min(...pending.samples.map(v => cosine(v, center)));
            this.profile = { schema: 'local-speaker/v1', samples: pending.samples, threshold: Math.max(.84, Math.min(.96, within - .035)), device: pending.device, enrolledAt: this.clock() };
            pending.resolve({ samples: 3, ready: true });
          }, pending.quietMs);
        }
      }
    }
    const result = this.classify(feature); this.latest = { ...result, at: this.clock() }; return result;
  }
  enroll({ timeoutMs = 45000, quietMs = 1500 } = {}) {
    if (this.enrollment) return Promise.reject(Error('正在听，请先读完这一段'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel('没有听清，请靠近麦克风重新朗读'), timeoutMs);
      this.enrollment = { resolve, reject, timer, quietMs, quietTimer: null, vectors: [], samples: [], duration: 0, device: this.device };
    });
  }
  acceptsText() {
    if (this.enrollment) return false;
    return !this.enabled || !!(this.latest?.accepted && this.clock() - this.latest.at < 6000);
  }
  status() { return { enabled: this.enabled, samples: this.profile?.samples.length || 0, ready: (this.profile?.samples.length || 0) >= 3,
    enrolling: !!this.enrollment, progress: this.enrollment?.samples.length || 0, latest: this.latest ? { status: this.latest.status, score: this.latest.score } : null, approximate: true }; }
  reset() { this.cancel(); this.profile = null; this.latest = null; this.enabled = false; }
  cancel(message = '已取消朗读') { if (this.enrollment) { const pending = this.enrollment; clearTimeout(pending.timer); clearTimeout(pending.quietTimer); this.enrollment = null; pending.reject(Error(message)); } }
}
module.exports = { SpeakerFilter, unit, cosine, mean, DIMENSION };
