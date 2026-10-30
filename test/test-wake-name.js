'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process'),{Asr}=require('../src/main/asr'),wake=require('../src/main/wake-name');
test('native pinyin matching follows custom names and aliases without a model request',()=>{
  for(const binary of ['asr','asr-legacy']) {
    const result=spawnSync(path.resolve('bin',binary),['--wake-name-test'],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout.trim());for(const [key,value]of Object.entries(report))if(key!=='t')assert.equal(value,true,key);
  }
  assert(wake.hit('巴尼，你好','Bunny'));assert(!wake.hit('我把你的东西保存','Bunny'));assert(!wake.hit('bunnyhop','Bunny'));
  assert(wake.hit('Alice你好','Alice'));assert(!wake.hit('巴尼你好','倩倩'));
  const asr=new Asr('/unused');asr.onMessage({t:'partial',v:'芊芊，帮我看看',wakeNameHit:true});assert(asr.wakeHit('芊芊，帮我看看'));assert(asr.wakeHit('芊芊，帮我看看\n再看看后面的'));
});
test('the actual utterance handler rejects unnamed speech before LLM, memory or quiet-reply effects',async()=>{
  const file=path.resolve('src/main/index.js'),source=fs.readFileSync(file,'utf8'),requests=[],events=[];
  const ctx={require:require('node:module').createRequire(file),asr:{wakeHit:text=>text.startsWith('芊芊')},config:{load:()=>({buddy:{name:'倩倩'},asr:{wakeOnly:true,judge:true}})},
    inputAdmission:{containsSecret:()=>false},worthJudging:()=>true,recentEcho:()=>false,speaking:false,Date,send:(...args)=>events.push(args),log(){},lastHeardAt:0,turnT0:0,autonomy:null,QUIET_WORDS:/安静/,nameHit:null,
    think:async opts=>{requests.push(opts);return{text:'你好'};}};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function nameHit('),source.indexOf('/** 每听到一句')),ctx);
  vm.runInContext(source.slice(source.indexOf('async function handleUtterance('),source.indexOf('/** 主动要权限')),ctx);
  let skips=0;await ctx.handleUtterance('旁边的人说请安静',{skip:()=>skips++});assert.equal(skips,1);assert.equal(requests.length,0);assert(!events.some(e=>e[0]==='chat'));
  await ctx.handleUtterance('芊芊，帮我看看',{isCurrent:()=>true});assert.equal(requests.length,1);assert(requests[0].judge);
});
test('tray text input and visibility labels toggle with actual state; clicking the icon never hides the pet',()=>{
 const source=fs.readFileSync(path.resolve('src/main/index.js'),'utf8');let shown=0,hidden=0,focused=0,interactive=false,visible=true,icon;
 const ctx={config:{load:()=>({buddy:{name:'倩倩'},asr:{},voice:{enabled:true},monitor:{},window:{scale:1}})},
 win:{isVisible:()=>visible,focus:()=>focused++},textInputOpen:false,Menu:{buildFromTemplate:x=>x},avatars:{scan:()=>[]},clampScale:v=>v,SCALES:[1],SCALE_LABELS:{1:'100%'},scopePolicy:{LABELS:{life:'生活',work:'工作',private:'私聊'}},currentScene:()=> 'life',asrStatus:{speech:3,mic:true},
 showWindow:()=>{shown++;visible=true;},hideWindow:()=>{hidden++;visible=false;},setInteractive:v=>interactive=v,send:(type,value)=>{assert.equal(type,'ask');ctx.textInputOpen=value.open;},tray:{on:(event,fn)=>{assert.equal(event,'click');icon=fn;}}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function buildTrayMenu()'),source.indexOf('function rebuildTray()')),ctx);
 const menu=ctx.buildTrayMenu();assert(!menu.some(m=>/按住说话|说句话/.test(m.label||'')));menu.find(m=>m.label==='打开文字输入').click();assert(interactive);assert.equal(focused,1);
 ctx.buildTrayMenu().find(m=>m.label==='关闭文字输入').click();assert.equal(ctx.textInputOpen,false);
 ctx.buildTrayMenu().find(m=>m.label==='让它隐藏').click();assert.equal(visible,false);
 ctx.textInputOpen=true;assert(ctx.buildTrayMenu().some(m=>m.label==='打开文字输入'));
 ctx.buildTrayMenu().find(m=>m.label==='叫它出来').click();assert.equal(visible,true);
 const hides=hidden;const line=source.split('\n').find(l=>l.includes("tray.on('click',"));vm.runInContext(line,ctx);icon();assert.equal(hidden,hides);visible=false;icon();assert.equal(shown,3);
});
