// Leave a little breathing room above the character while retaining a useful
// reading area when a very small character sits near the bottom of the window.
export function dialogueTopForHead(headY, windowHeight, scale = 1) {
  if (!Number.isFinite(headY) || !Number.isFinite(windowHeight) || windowHeight <= 0) return 10;
  const margin = Math.max(12, Math.min(28, 18 * scale));
  const maximum = Math.max(10, windowHeight - 180);
  return Math.round(Math.max(10, Math.min(maximum, headY - margin)));
}
