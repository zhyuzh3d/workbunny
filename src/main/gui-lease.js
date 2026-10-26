'use strict';

class GuiLease {
  constructor() {
    this.owner = null;
    this.depth = 0;
    this.waiters = [];
  }

  isFree() { return this.owner === null; }

  acquire(owner, signal) {
    if (typeof owner !== 'string' || !owner.trim()) return Promise.reject(new TypeError('GUI lease owner is required'));
    if (signal?.aborted) return Promise.reject(new Error('GUI lease acquisition aborted'));
    if (this.owner === null) {
      this.owner = owner;
      this.depth = 1;
      return Promise.resolve(true);
    }
    if (this.owner === owner) {
      this.depth++;
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const waiter = { owner, signal, resolve, reject, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('GUI lease acquisition aborted'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.grantNext();
    });
  }

  release(owner) {
    if (this.owner !== owner) return false;
    this.depth--;
    if (this.depth > 0) return true;
    this.owner = null;
    this.depth = 0;
    this.grantNext();
    return true;
  }

  grantNext() {
    if (this.owner !== null) return;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('GUI lease acquisition aborted'));
        continue;
      }
      this.owner = waiter.owner;
      this.depth = 1;
      waiter.resolve(true);
      return;
    }
  }
}

module.exports = { GuiLease };
