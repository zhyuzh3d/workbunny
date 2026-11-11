'use strict';
const fs=require('node:fs'),path=require('node:path');
// Own bundled UI declarations are the tab allowlist; no target-app discovery.
const html=fs.readFileSync(path.join(__dirname,'../renderer/panel.html'),'utf8');
const markup=/<div\b[^>]*\bid="tabs"[^>]*>([\s\S]*?)<\/div>/u.exec(html)?.[1]||'';
const SETTINGS_TABS=Object.freeze([...new Set([...markup.matchAll(/<button\b[^>]*\bdata-t="([a-z][a-z0-9-]*)"/gu)].map(match=>match[1]))]);
const SETTINGS_TAB_NAMES=Object.freeze([...SETTINGS_TABS,...(SETTINGS_TABS.includes('data')?['system']:[])]);
function checkedTab(tab){if(tab===undefined)return null;if(typeof tab!=='string'||!SETTINGS_TAB_NAMES.includes(tab))throw Object.assign(Error('设置标签不存在'),{code:'E_LOCAL_PARAMS'});return tab==='system'?'data':tab;}
function openSettingsPanel({openPanel,tab}){const selected=checkedTab(tab),window=openPanel('settings');if(!window||window.isDestroyed())throw Object.assign(Error('设置面板暂不可用'),{code:'E_SETTINGS_PANEL'});
 if(selected){const select=()=>{if(!window.isDestroyed())window.webContents.send('pet:ev',{type:'settings-tab',tab:selected});};if(window.webContents.isLoading())window.webContents.once('did-finish-load',select);else select();}
 return {opened:true,tab:selected,...(typeof window.getBounds==='function'?{bounds:window.getBounds()}: {})};
}
module.exports={SETTINGS_TABS,SETTINGS_TAB_NAMES,checkedTab,openSettingsPanel};
