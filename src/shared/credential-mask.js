'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BunnyCredential = api;
})(globalThis, function () {
  const MASK = '••••••••';
  function mask(value) {
    const chars = Array.from(String(value || ''));
    if (!chars.length) return '';
    if (chars.length < 3) return MASK;
    const edge = Math.min(4, Math.floor(chars.length / 3));
    return chars.slice(0, edge).join('') + MASK + chars.slice(-edge).join('');
  }
  function isPassword(name) { return /password|passwd|passphrase|(?:^|[_-])(?:pwd|pass|pin)(?:$|[_-])|密码/i.test(name); }
  return { MASK, mask, isPassword };
});
