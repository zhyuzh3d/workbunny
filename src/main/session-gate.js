'use strict';
// Never enter a synchronous Keychain read while the login screen owns the session.
// Native session status is authoritative; Electron 33's idle state reports "idle"
// on this locked macOS 26 machine, so idle time is not a lock detector.
class SessionGate {
  constructor({ readLocked, onLocked, onUnlocked, pollMs = 10000 }) {
    Object.assign(this, { readLocked, onLocked, onUnlocked, pollMs });
    this.locked = undefined; this.closed = false; this.pending = null; this.timer = null; this.revision = 0;
  }
  lock() {
    this.revision++;
    if (this.closed || this.locked === true) return;
    this.locked = true;
    return this.onLocked();
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    const revision = this.revision;
    this.pending = (async () => {
      let locked = true;
      try { locked = await this.readLocked() !== false; } catch { /* Fail closed, retry on next status/event. */ }
      if (this.closed || revision !== this.revision) return;
      if (this.locked === locked) return;
      this.locked = locked;
      if (locked) await this.onLocked(); else await this.onUnlocked();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async start() {
    await this.refresh();
    if (!this.closed && !this.timer) { this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollMs); this.timer.unref?.(); }
  }
  close() { this.closed = true; this.revision++; clearInterval(this.timer); this.timer = null; }
}
module.exports = { SessionGate };
