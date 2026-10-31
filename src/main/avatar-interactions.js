'use strict';

// Data-only interaction maps. A pack names regions and actions; it cannot
// supply executable picking logic. The host owns the clock and random source.
const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const SHAPES = new Set(['sphere', 'capsule', 'ellipsoid', 'box']);
const MAX_REGIONS = 64;
const MAX_VOLUMES = 32;
const MAX_POOLS = 64;
const MAX_REACTIONS = 128;
const EMOTIONS = new Set(['happy', 'sad', 'angry', 'relaxed', 'surprised']);

function validId(value) { return typeof value === 'string' && ID.test(value); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function finiteVector(value, name, { positive = false } = {}) {
  assert(Array.isArray(value) && value.length === 3 && value.every(n =>
    typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100 && (!positive || n > 0)), name + ' must contain three valid numbers');
  return value.slice();
}

/** Validate and copy the data needed by the host and renderer. */
function validateInteractionMap(input, { actionIds, anchorIds } = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'interaction map must be an object');
  assert(Array.isArray(input.regions) && input.regions.length <= MAX_REGIONS, 'invalid interaction regions');
  assert(input.pools && typeof input.pools === 'object' && !Array.isArray(input.pools), 'invalid interaction pools');
  const poolEntries = Object.entries(input.pools);
  assert(poolEntries.length <= MAX_POOLS, 'too many interaction pools');
  const pools = Object.create(null);
  for (const [id, rows] of poolEntries) {
    assert(validId(id) && Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_REACTIONS, 'invalid interaction pool');
    const seen = new Set();
    pools[id] = rows.map(row => {
      assert(row && validId(row.action) && (!actionIds || actionIds.has(row.action)), 'unknown interaction action');
      assert(!seen.has(row.action), 'duplicate interaction action');
      seen.add(row.action);
      const weight = row.weight === undefined ? 1 : row.weight;
      assert(typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 100, 'invalid interaction weight');
      let speech;
      if (row.speech !== undefined) {
        const input = row.speech;
        assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['text', 'emotion'].includes(key)) &&
          typeof input.text === 'string' && input.text.length <= 120 && !require('./conversation-input').containsSecret(input.text), 'invalid interaction speech');
        const text = require('./conversation-text').conversationText(input.text);
        assert(input.emotion === undefined || EMOTIONS.has(input.emotion), 'invalid interaction emotion');
        speech = { text, emotion: input.emotion || 'relaxed' };
      }
      return { action: row.action, weight, ...(speech ? { speech } : {}) };
    });
    assert(pools[id].some(row => row.weight > 0), 'interaction pool has no selectable action');
  }
  const ids = new Set();
  const regions = input.regions.map(region => {
    assert(region && validId(region.id) && !ids.has(region.id), 'invalid or duplicate interaction region');
    ids.add(region.id);
    assert(validId(region.pool) && Object.hasOwn(pools, region.pool), 'unknown interaction pool');
    assert(Array.isArray(region.hitVolumes) && region.hitVolumes.length > 0 && region.hitVolumes.length <= MAX_VOLUMES, 'invalid hit volumes');
    const priority = region.priority ?? 0;
    assert(Number.isInteger(priority) && Math.abs(priority) <= 100, 'invalid interaction priority');
    const label = region.label === undefined ? region.id : region.label;
    assert(typeof label === 'string' && label.length <= 80, 'invalid interaction label');
    const hitVolumes = region.hitVolumes.map(volume => {
      assert(volume && SHAPES.has(volume.type) && validId(volume.anchor) && (!anchorIds || anchorIds.has(volume.anchor)), 'invalid interaction volume');
      const center = finiteVector(volume.center ?? [0, 0, 0], 'center');
      const size = finiteVector(volume.size, 'size', { positive: true });
      if (volume.type === 'capsule') assert(Math.abs(size[0] - size[2]) <= 1e-6 && size[1] >= 2 * size[0], 'invalid capsule dimensions');
      return { type: volume.type, anchor: volume.anchor, center, size };
    });
    return { id: region.id, label, pool: region.pool, priority, hitVolumes };
  });
  return { regions, pools };
}

class AvatarInteractionPicker {
  constructor({ clock = Date.now, random = Math.random, cooldownMs = 900, repeatFactor = 0.35 } = {}) {
    assert(typeof clock === 'function' && typeof random === 'function', 'invalid interaction sources');
    assert(Number.isFinite(cooldownMs) && cooldownMs >= 0, 'invalid interaction cooldown');
    assert(Number.isFinite(repeatFactor) && repeatFactor > 0 && repeatFactor <= 1, 'invalid repeat factor');
    Object.assign(this, { clock, random, cooldownMs, repeatFactor });
    this.lastAt = -Infinity;
    this.lastAction = null;
  }

  reset() { this.lastAt = -Infinity; this.lastAction = null; }

  // `allowed` is evaluated by the host against the current avatar, state and
  // catalog revision. Invalid or suppressed clicks do not consume cooldown.
  pick(map, regionId, { allowed = () => true } = {}) {
    const region = map?.regions?.find(item => item.id === regionId);
    if (!region) return null;
    const now = this.clock();
    if (!Number.isFinite(now) || now - this.lastAt < this.cooldownMs) return null;
    const candidates = (map.pools[region.pool] || []).filter(row => row.weight > 0 && allowed(row.action));
    if (!candidates.length) return null;
    const rows = candidates.map(row => ({ ...row,
      effectiveWeight: row.weight * (candidates.length > 1 && row.action === this.lastAction ? this.repeatFactor : 1) }));
    const total = rows.reduce((sum, row) => sum + row.effectiveWeight, 0);
    const value = this.random();
    if (!Number.isFinite(value)) return null;
    let cursor = Math.max(0, Math.min(0.999999999999, value)) * total;
    let chosen = rows[rows.length - 1];
    for (const row of rows) { cursor -= row.effectiveWeight; if (cursor < 0) { chosen = row; break; } }
    this.lastAt = now;
    this.lastAction = chosen.action;
    return { region: region.id, action: chosen.action, ...(chosen.speech ? { speech: chosen.speech } : {}) };
  }
}

module.exports = { validateInteractionMap, AvatarInteractionPicker };
