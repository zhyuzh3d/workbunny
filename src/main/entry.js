'use strict';
// Keep synchronous macOS Keychain prompts outside the interactive main process.
if (process.argv.includes('--workbunny-vault-key')) require('./vault-key-helper').start();
else require('./index');
