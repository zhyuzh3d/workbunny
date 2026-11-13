// Keep the original reply intact; compact empty lines only for display.
export function compactReplyText(text) {
  return String(text ?? '').replace(/(?:\r\n|\r|\n)(?:[^\S\r\n]*(?:\r\n|\r|\n))+/g, '\n');
}
