export function autoGrow(field, minRows = 3) {
  if (!field || !field.clientWidth) return;
  const style = getComputedStyle(field), line = parseFloat(style.lineHeight) || 18;
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  field.style.minHeight = `${Math.ceil(line * minRows + padding + border)}px`;
  field.style.height = 'auto';
  field.style.height = `${Math.max(line * minRows + padding + border, field.scrollHeight + border)}px`;
}
