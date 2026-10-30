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
  function probabilities(items, key, percent) {
    const selected = items.find(m => m.key === key && enabled(m));
    if (!selected || !Number.isFinite(percent) || percent < 0 || percent > 100) throw Error('动作或比例不正确');
    const peers = items.filter(m => m.slot === selected.slot && enabled(m)), others = peers.filter(m => m.key !== key);
    const total = others.reduce((n,m) => n + Number(m.weight ?? 1), 0);
    const target = others.length ? percent : percent > 0 ? 100 : 0;
    return Object.fromEntries(peers.map(m => [m.key, m.key === key ? target : (100 - target) * (total > 0 ? Number(m.weight ?? 1) / total : 1 / others.length)]));
  }
  return { choose, enabled, probabilities };
});
