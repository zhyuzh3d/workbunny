import '../shared/credential-mask.js';
const { MASK, mask } = globalThis.BunnyCredential;
const fields = new WeakMap();

// Keep native password editing and the real draft separate from its visible preview.
// Saved credentials expose only a preview; MASK continues to mean "leave unchanged".
export function paintCredential(input, value = '', { preview = '', preserveEmpty = false, cleared = false } = {}) {
  let field = fields.get(input);
  if (!field) {
    const wrapper = document.createElement('span'), label = document.createElement('span'), clear = document.createElement('button');
    wrapper.className = 'credential-field'; label.className = 'credential-preview'; label.setAttribute('aria-hidden', 'true');
    clear.type = 'button'; clear.className = 'credential-clear'; clear.textContent = '×'; clear.title = '清除密钥'; clear.setAttribute('aria-label','清除密钥');
    input.replaceWith(wrapper); wrapper.append(input, label, clear);
    field = { wrapper, label, clear }; fields.set(input, field);
    clear.addEventListener('click', event => {
      event.preventDefault();
      if (input.disabled || input.readOnly) return;
      field.cleared = true; input.value = ''; update(input, field);
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true})); input.focus();
    });
    input.autocomplete = 'off'; input.spellcheck = false;
    input.addEventListener('input', () => { field.cleared = !input.value; update(input, field); }, true);
    input.addEventListener('focus', () => { if (input.value === MASK || !input.value && field.preserveEmpty) input.select(); });
    input.addEventListener('paste', () => { if (input.value === MASK) input.select(); });
  }
  field.preview = preview; field.preserveEmpty = preserveEmpty; field.cleared = cleared;
  input.value = value;
  update(input, field);
}
function update(input, field) {
  const value = input.value;
  if (value) field.cleared = false;
  field.label.textContent = !field.cleared && (value === MASK || !value && field.preserveEmpty) ? field.preview || (value ? MASK : '') : mask(value);
  field.wrapper.classList.toggle('has-preview', !!field.label.textContent);
  field.clear.hidden = !field.label.textContent;
  field.clear.disabled = input.disabled || input.readOnly;
}
export function credentialCleared(input) { return fields.get(input)?.cleared === true; }
