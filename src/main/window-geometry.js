'use strict';
// AppKit constrains physical windows below the menu bar. Keep an independent
// logical canvas, clip its window to the screen and translate only the canvas.
function layoutWindow(rect, area) {
  const width = Math.max(320, Math.min(2400, Math.round(rect.width)));
  const height = Math.max(320, Math.min(2400, Math.round(rect.height)));
  const x = Math.round(Math.max(area.x - width + 160, Math.min(area.x + area.width - 160, rect.x)));
  const logicalY = Math.round(Math.max(area.y - height + 160, Math.min(area.y + area.height - 160, rect.y)));
  const y = Math.max(area.y, logicalY), bottom = Math.min(area.y + area.height, logicalY + height);
  return { logical: { x, y: logicalY, width, height }, bounds: { x, y, width, height: Math.max(160, bottom - y) },
    viewport: { width, height, offsetY: logicalY - y } };
}
module.exports = { layoutWindow };
