import { createSelfEditor } from './self-editor.js';
import { paintCharacterNames } from './character-name.mjs';
let config = {};
const editor = createSelfEditor(window.pet, { getConfig: () => config });
window.pet.on(event => {
  if (event.type === 'config' && event.config) { config = event.config; paintCharacterNames(config); void editor.load(); }
});
window.pet.init().then(result => { config = result.config || {}; paintCharacterNames(config); return editor.load(); })
  .catch(error => { document.getElementById('selfStatus').textContent = error.message; });
