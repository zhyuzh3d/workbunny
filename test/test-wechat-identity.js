'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {markedMessage,deliveryAttachment}=require('../src/main/wechat-identity');
test('owner account messages have one clear marker, and an explicitly Bunny-owned account preserves original text',()=>{
 assert.equal(markedMessage('收到。'),'［ᕱᕱ］ 收到。');assert.equal(markedMessage('［ᕱᕱ］ 收到。'),'［ᕱᕱ］ 收到。');assert.equal(markedMessage('[ᕱᕱ] received'),'［ᕱᕱ］ received');assert.equal(markedMessage('收到。','bunny'),'收到。');
});
test('owner-account attachment copies carry the marker without renaming or changing the source',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-identity-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'result.txt');fs.writeFileSync(file,'actual result');const source={path:file,sha256:require('crypto').createHash('sha256').update('actual result').digest('hex')};
 const copied=await deliveryAttachment(source,{taskId:'test-1',directory:path.join(root,'delivery')});assert.equal(path.basename(copied.path),'［ᕱᕱ］ result.txt');assert.equal(fs.readFileSync(copied.path,'utf8'),'actual result');assert(fs.existsSync(file));assert.equal((await deliveryAttachment(source,{taskId:'test-1',directory:path.join(root,'delivery')})).path,copied.path);assert.equal((await deliveryAttachment(source,{taskId:'test-2',ownership:'bunny'})).path,file);
});
test('an unrelated task mentioning execution software does not select its integration project',async()=>{
 const {chooseWorkspace}=require('../src/main/workbuddy-route');assert.equal(await chooseWorkspace(['workbuddy_bridge','WorkBaby'],{goal:'交给WorkBuddy制作Cedar-UX实验文件，微信交付'}),null);assert.equal(await chooseWorkspace(['workbuddy_bridge','WorkBaby'],{goal:'调整WorkBaby项目的输出格式'}),'WorkBaby');
});
test('the WorkBuddy brief separates work scope from the host delivery channel',()=>{
 const {workOrder}=require('../src/main/work-order');const task={goal:'做文件并通过微信交付',state:{ownerRequest:'按刚才做，微信告诉我'},workRequest:{goal:'生成实验文件',criteria:'核对真实内容'}};const brief=workOrder(task);assert.match(brief,/生成实验文件/);assert.match(brief,/不得操作微信/);assert.match(brief,/按刚才做，微信告诉我/);
});
