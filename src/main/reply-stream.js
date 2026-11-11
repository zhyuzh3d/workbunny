'use strict';

const { stringEnd, parseStrictJson } = require('./strict-json');
const { makeActionGate } = require('./dialogue-actions');
const { presentConversation } = require('./conversation-text');
const { makeSentenceSplitter } = require('./llm');

// Locate JSON values structurally: braces and field names inside strings must
// never turn a review, tool result or action into conversational output.
function valueEnd(source, start) {
  if (source[start] === '"') return stringEnd(source, start);
  if (!['{', '['].includes(source[start])) {
    const match = source.slice(start).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/u);
    return match ? start + match[0].length : -1;
  }
  const stack = [source[start] === '{' ? '}' : ']'];
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { const end = stringEnd(source, i); if (end < 0) return end; i = end - 1; }
    else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') { if (stack.pop() !== char) return -2; if (!stack.length) return i + 1; }
  }
  return -1;
}
function fields(source, start) {
  if (source[start] !== '{') return null;
  const found = new Map(); let i = start + 1;
  const ws = () => { while (/\s/u.test(source[i] || '\0')) i++; };
  while (i < source.length) {
    ws(); if (source[i] === '}') return found;
    const end = stringEnd(source, i); if (end < 0) return found;
    let key; try { key = JSON.parse(source.slice(i, end)); } catch { return null; }
    if (found.has(key)) return null;
    i = end; ws(); if (source[i++] !== ':') return null; ws();
    const valueStart = i, valueStop = valueEnd(source, i);
    found.set(key, { start: valueStart, end: valueStop });
    if (valueStop < 0) return found;
    i = valueStop; ws(); if (source[i] !== ',') return found; i++;
  }
  return found;
}
function parsed(source, range) {
  if (!range || range.end < 0) return undefined;
  try { return parseStrictJson(source.slice(range.start, range.end)); } catch { return undefined; }
}
function replyStart(source, cognitive) {
  const root = source.search(/\S/u); if (root < 0 || source[root] !== '{') return -1;
  if (!cognitive) return root;
  const outer = fields(source, root);
  if (parsed(source, outer?.get('protocol')) !== 'dialogue-v2') return -1;
  let index = outer?.get('stages')?.start;
  if (source[index] !== '[') return -1;
  index++; while (/\s/u.test(source[index] || '\0')) index++;
  const reviewEnd = valueEnd(source, index); if (reviewEnd < 0) return -1;
  const review = parsed(source, { start: index, end: reviewEnd });
  if (review?.stage !== 'review') return -1;
  index = reviewEnd; while (/\s/u.test(source[index] || '\0')) index++;
  if (source[index++] !== ',') return -1;
  while (/\s/u.test(source[index] || '\0')) index++;
  const stage = fields(source, index);
  if (parsed(source, stage?.get('stage')) !== 'reply') return -1;
  const reply = stage?.get('reply');
  return reply && source[reply.start] === '{' ? reply.start : -1;
}

function createReplyStream({ cognitive = false, isCurrent = () => true, onDelta, onSentence } = {}) {
  let raw = '', offset = 0, cursor = null, started = false, body = '', visible = '', closed = false;
  const splitter = makeSentenceSplitter(text => { if (isCurrent()) onSentence?.(text); });
  const present = (text, final = false) => {
    if (closed || !isCurrent()) return;
    if (!final) {
      // The complete typed container is removed by extractTags. Its payload
      // can contain spaces, so holding only an unfinished '<...>' leaks words
      // which disappear when the eventual closing tag arrives.
      for (const open of text.matchAll(/<([me])(?:\s[^>]*)?>/gi)) {
        if (!new RegExp('</' + open[1] + '\\s*>', 'i').test(text.slice(open.index + open[0].length))) { text = text.slice(0, open.index); break; }
      }
    }
    const lastTag = text.lastIndexOf('<');
    if (!final && lastTag >= 0 && text.indexOf('>', lastTag) < 0) text = text.slice(0, lastTag);
    const clean = presentConversation(require('./owner-security').redactPrefix(text, { final }));
    // Incomplete tags are held by the shared presentation boundary. A later
    // valid prefix can release them without ever exposing control markup.
    if (!clean || !clean.startsWith(visible)) return;
    const delta = clean.slice(visible.length); visible = clean;
    if (delta) { onDelta?.(delta); if (isCurrent()) splitter.push(delta); }
  };
  const gate = makeActionGate(delta => { body += delta; present(body); }, { allowTurnDisposition: true });
  return {
    push(delta) {
      if (closed || !isCurrent()) return;
      raw += String(delta || ''); if (raw.length > 65536) { closed = true; return; }
      if (!started) { const start = replyStart(raw, cognitive); if (start < 0) return; offset = start; started = true; }
      const end = valueEnd(raw, offset), stop = end > 0 ? end : raw.length;
      if (end > 0) {
        try { require('./reply-format').validateReply(raw.slice(offset, end), { allowActions: false, allowTurnDisposition: true }); }
        catch { closed = true; return; }
      }
      // The inner chat object ends before cognition's prediction fields.
      if (cursor === null) cursor = offset;
      if (stop > cursor) { gate.push(raw.slice(cursor, stop)); cursor = stop; }
    },
    finish(text) {
      const final = presentConversation(require('./owner-security').redactPrefix(text, { final: true }));
      if (visible && !final.startsWith(visible)) throw Object.assign(Error('流式正文与最终回复不一致'), { code: 'E_REPLY_PROTOCOL' });
      present(text, true); if (!closed && isCurrent()) splitter.flush(); closed = true;
    },
    reset() { if (visible) return false; closed = true; return true; },
    get text() { return visible; },
  };
}

module.exports = { createReplyStream };
