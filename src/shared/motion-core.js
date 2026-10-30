'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BunnyMotion = api;
})(globalThis, function () {
  function enabled(motion, disabled = []) { return motion && motion.enabled !== false && !motion.deleted && !disabled.includes(motion.key); }
  function choose(items, random = Math.random) {
    const pool = items.filter(m => enabled(m) && Number(m.weight ?? 1) > 0);
    const total = pool.reduce((sum, m) => sum + Number(m.weight ?? 1), 0);
    if (!total) return null;
    let target = Math.max(0, Math.min(0.999999999999, random())) * total;
    for (const motion of pool) { target -= Number(motion.weight ?? 1); if (target < 0) return motion; }
    return pool.at(-1);
  }
  return { choose, enabled };
});
