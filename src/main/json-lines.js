'use strict';

const MAX_NATIVE_LINE_BYTES = 64 * 1024 * 1024;

// Native pipes split frames at arbitrary byte offsets, including in UTF-8
// characters. Retain only the unfinished frame and join it once.
class JsonLines {
  constructor(maxBytes = MAX_NATIVE_LINE_BYTES) {
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.parts = [];
    this.bytes = 0;
    this.discarding = false;
  }

  get atBoundary() { return !this.bytes && !this.discarding; }

  push(chunk, receive, invalid) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (this.discarding) {
        if (newline < 0) return;
        this.discarding = false;
        start = newline + 1;
        continue;
      }
      const end = newline < 0 ? chunk.length : newline;
      const size = this.bytes + end - start;
      if (size > this.maxBytes) {
        this.reset();
        const error = Object.assign(new Error('JSON line exceeded byte limit'), { code: 'E_JSON_LINE_LIMIT' });
        if (!invalid) throw error;
        invalid(error);
        if (newline < 0) {
          this.discarding = true;
          return;
        }
        start = newline + 1;
        continue;
      }
      const part = chunk.subarray(start, end);
      if (newline < 0) {
        this.parts.push(part);
        this.bytes = size;
        return;
      }
      const line = this.parts.length ? Buffer.concat([...this.parts, part], size) : part;
      this.reset();
      start = newline + 1;
      const text = line.toString('utf8');
      if (!text.trim()) continue;
      let value;
      try {
        value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Expected a JSON line object');
      } catch (error) {
        if (!invalid) throw error;
        invalid(error);
        continue;
      }
      if (receive(value) === false) return;
    }
  }
}

module.exports = { JsonLines, MAX_NATIVE_LINE_BYTES };
