import '../shared/credential-mask.js';
const { MASK, mask } = globalThis.BunnyCredential;
const fields = new WeakMap();

// Keep native password editing and the real draft separate from its visible preview.
// Saved credentials expose only a preview; MASK continues to mean "leave unchanged".
export function paintCredential(input, value = '', { preview = '', preserveEmpty = false } = {}) {
  let field = fields.get(input);
  if (!field) {
    const wrapper = document.createElement('span'), label = document.createElement('span');
    wrapper.className = 'credential-field'; label.className = 'credential-preview'; label.setAttribute('aria-hidden', 'true');
    input.replaceWith(wrapper); wrapper.append(input, label);
    field = { wrapper, label }; fields.set(input, field);
    input.autocomplete = 'off'; input.spellcheck = false;
    input.addEventListener('input', () => update(input, field), true);
    input.addEventListener('focus', () => { if (input.value === MASK || !input.value && field.preserveEmpty) input.select(); });
    input.addEventListener('paste', () => { if (input.value === MASK) input.select(); });
  }
  field.preview = preview; field.preserveEmpty = preserveEmpty;
  input.value = value;
  update(input, field);
}
function update(input, field) {
  const value = input.value;
  field.label.textContent = value === MASK || !value && field.preserveEmpty ? field.preview || (value ? MASK : '') : mask(value);
  field.wrapper.classList.toggle('has-preview', !!field.label.textContent);
}
