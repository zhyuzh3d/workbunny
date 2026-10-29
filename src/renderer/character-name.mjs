export function characterName(config, limit = 6) {
  const name = String(config?.buddy?.name || '伙伴').trim() || '伙伴';
  const units = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].map(item => item.segment);
  return units.length > limit ? units.slice(0, limit).join('') + '…' : name;
}
export function characterText(text, config) {
  return String(text || '').replace(/\bBunny\b/gi, () => characterName(config));
}
export function paintCharacterNames(config, root = document) {
  for (const el of root.querySelectorAll('[data-character-text]')) {
    el.textContent = characterText(el.dataset.characterText, config);
    el.title = el.dataset.characterText.replace(/\bBunny\b/gi, () => characterName(config, 64));
  }
  for (const el of root.querySelectorAll('[data-character-placeholder]')) el.placeholder = characterText(el.dataset.characterPlaceholder, config);
}
