'use strict';
// A production browser process with input authority cannot be a debug endpoint.
if(require('electron').app?.isPackaged&&process.argv.some(arg=>/^--(?:remote-debugging|inspect)(?:[-=]|$)/u.test(arg))){
  require('electron').app.exit(2);
}else {
// Keep synchronous macOS Keychain prompts outside the interactive main process.
if (process.argv.includes('--workbunny-vault-key')) require('./vault-key-helper').start();
else require('./index');
}
