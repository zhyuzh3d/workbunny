'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{rendererConsole}=require('../src/main/renderer-console');
test('production renderer warnings and errors keep their actual named severity and source; ordinary chatter is quiet',()=>{
 assert.equal(rendererConsole({level:'info',message:'ordinary status'},'renderer'),null);
 assert.match(rendererConsole({level:'warning',message:'visual task stalled',sourceId:'file:///app/renderer/app.js',lineNumber:12},'renderer'),/^\[renderer:warning\].*app.js:12/u);
 assert.match(rendererConsole({level:'error',message:'UI failed'},'panel:desktop'),/^\[panel:desktop:error\] UI failed/u);
 assert.equal(rendererConsole({level:'warning',message:'specVersion of the VRMA'},'renderer'),null);
 assert.match(rendererConsole({level:'debug',message:'diagnostic'},'renderer',{development:true}),/debug/u);
});
