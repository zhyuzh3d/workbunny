'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BunnyExternalMessage = api;
})(globalThis, function () {
  const MARK = '［ᕱᕱ］';
  const PREFIX = /^[［\[]ᕱᕱ[］\]]/u;
  function markedText(text) {
    const value = String(text ?? '');
    return PREFIX.test(value) ? value.replace(PREFIX, MARK) : MARK + ' ' + value;
  }
  return Object.freeze({ MARK, markedText });
});
