'use strict';

// A response owns a snapshot of unanswered inputs, not the inputs themselves.
// Cancelling that response releases its work immediately and leaves its
// unacknowledged words available to its successor. A stale lease cannot consume
// that queue; consuming input does not end or release its active response.
class DialogueTurnScheduler {
  constructor() { this.channels = new Map(); this.sequence = 0; }

  channel(id, scope) {
    let state = this.channels.get(id);
    if (!state || state.scope !== scope) {
      state?.active?.controller.abort();
      state = { scope, pending: new Map(), active: null };
      this.channels.set(id, state);
    }
    return state;
  }

  interrupt({ channel = 'local', scope, clear = false } = {}) {
    const state = this.channel(channel, scope);
    const prior = state.active; state.active = null;
    prior?.controller.abort();
    if (clear) state.pending.clear();
  }

  resumable({ channel = 'local', scope } = {}) {
    const state = this.channels.get(channel);
    if (!state || state.scope !== scope || state.active) return null;
    return [...state.pending.values()].at(-1) || null;
  }

  begin({ channel = 'local', scope, input, controller = new AbortController() } = {}) {
    if (!input || typeof input.text !== 'string' || !input.text.trim()) throw new TypeError('A dialogue input needs text');
    const state = this.channel(channel, scope);
    this.interrupt({ channel, scope });
    const key = input.key || 'input:' + ++this.sequence;
    // A source revision replaces that source in place; repeated observations
    // do not append the same utterance or disturb the order of earlier words.
    const item = Object.assign(state.pending.get(key) || { key }, input, { key });
    state.pending.set(key, item);
    const inputs = [...state.pending.values()];
    const lease = { controller, inputs, input: item, consumed: false,
      isCurrent: () => this.channels.get(channel) === state && state.active === lease && !controller.signal.aborted,
      accept: () => { if (!lease.isCurrent()) return false; item.accepted = true; return true; },
      consume: ({ ignored = false } = {}) => {
        if (!lease.isCurrent() || lease.finished) return false;
        for (const entry of ignored ? [item] : inputs) if (state.pending.get(entry.key) === entry) state.pending.delete(entry.key);
        lease.consumed = true;
        return true;
      },
      finish: ({ ignored = false } = {}) => {
        if (!lease.consume({ ignored })) return false;
        lease.finished = true;
        return true;
      },
      release: () => { if (state.active === lease) state.active = null; },
      // This is a receipt of an already-started effect, not fresh authority.
      // It remains attached to the original words even if the response retires.
      effect: value => { for (const entry of inputs) entry.effect = value; },
    };
    state.active = lease;
    return lease;
  }
}

module.exports = { DialogueTurnScheduler };
