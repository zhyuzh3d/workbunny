'use strict';

const { choose } = require('../shared/motion-core');
const { containsSecret } = require('./conversation-input');
const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,23}$/;

function assert(value, message) { if (!value) throw new Error(message); }
function readText(value, max, field) {
  assert(typeof value === 'string' && value.trim() && value.length <= max && !containsSecret(value), `invalid ${field}`);
  return value.trim();
}
function id(value, field) { assert(typeof value === 'string' && ID.test(value), `invalid ${field}`); return value; }

// An immutable action catalog from a validated, data-only character package.
// It deliberately offers no editing/importing of individual actions.
class AvatarActionCatalog {
  constructor(descriptor, { random = Math.random } = {}) {
    assert(descriptor && NAMESPACE.test(descriptor.namespace || ''), 'invalid action namespace');
    assert(Array.isArray(descriptor.categories) && descriptor.categories.length > 0 && descriptor.categories.length <= 64, 'invalid categories');
    assert(Array.isArray(descriptor.actions) && descriptor.actions.length > 0 && descriptor.actions.length <= 512, 'invalid actions');
    assert(typeof random === 'function', 'invalid random source');
    this.random = random;
    this.namespace = descriptor.namespace;
    const groupIds = new Set();
    this.categories = descriptor.categories.map(group => {
      assert(group && typeof group === 'object', 'invalid category');
      const key = id(group.id, 'category id');
      assert(!groupIds.has(key), 'duplicate category id'); groupIds.add(key);
      return Object.freeze({ id: key, label: readText(group.label, 40, 'category label'),
        description: readText(group.description, 240, 'category description') });
    });
    const ids = new Set();
    this.motions = descriptor.actions.map(action => {
      assert(action && typeof action === 'object', 'invalid action');
      const localId = id(action.id, 'action id');
      assert(!ids.has(localId), 'duplicate action id'); ids.add(localId);
      const slot = id(action.category, 'action category');
      assert(groupIds.has(slot), 'unknown action category');
      const duration = action.duration;
      assert(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 300, 'invalid action duration');
      const weight = action.weight ?? 1;
      assert(typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 100, 'invalid action weight');
      const key = `${this.namespace}_${localId}`;
      assert(key.length <= 80, 'action key too long');
      return Object.freeze({ key, localId, slot, label: readText(action.label, 80, 'action label'),
        use: readText(action.use, 300, 'action description'), duration, weight,
        loop: action.loop === true, idle: action.idle === true,
        autonomous: action.autonomous !== false, enabled: true, tag: 'llm',
        // Pack props are owned by the runtime, not missing external props.
        requiresProp: action.requiresExternalProp === true });
    });
    assert(typeof descriptor.defaultIdle === 'string' && this.motions.some(m =>
      m.localId === descriptor.defaultIdle && m.idle && m.loop && m.weight > 0), 'invalid default idle');
    this.defaultIdle = `${this.namespace}_${descriptor.defaultIdle}`;
    Object.freeze(this.categories); Object.freeze(this.motions);
  }

  catalog() { return { categories: this.categories.slice(), motions: this.motions.slice() }; }
  keyFor(localId) { return this.motions.find(item => item.localId === localId)?.key || null; }

  select(selector, { exact = false, manual = false, autonomous = false, reason = '', allowed = () => true } = {}) {
    const eligible = item => item.enabled && allowed(item) && (manual || !item.requiresProp) && (!autonomous || reason === 'touch' || item.autonomous);
    const direct = this.motions.find(item => item.key === selector);
    if (direct) return eligible(direct) ? direct : null;
    if (exact) return null;
    return choose(this.motions.filter(item => item.slot === selector && eligible(item) && (manual || item.autonomous) && item.weight > 0), this.random);
  }

  idle() { return this.motions.find(item => item.key === this.defaultIdle); }

  prompt(query = '') {
    const q = String(query).replace(/\s+/g, '');
    const scored = this.motions.map(m => {
      const text = `${m.label} ${m.use}`.replace(/\s+/g, '');
      let score = q && (q.includes(m.label) || q.includes(m.key)) ? 20 : 0;
      for (let i = 0; i + 1 < q.length; i++) if (text.includes(q.slice(i, i + 2))) score++;
      return { motion: m, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    return this.categories.map(group => {
      const available = this.motions.some(m => m.slot === group.id);
      return available ? { category: group.id, meaning: group.label, use: group.description.slice(0, 60),
        actions: scored.filter(item => item.motion.slot === group.id).map(({ motion: m }) =>
          ({ id: m.key, name: m.label, meaning: m.use.slice(0, 80), requiresProp: m.requiresProp })) } : null;
    }).filter(Boolean);
  }
}

module.exports = { AvatarActionCatalog };
