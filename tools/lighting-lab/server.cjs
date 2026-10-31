'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {pathToFileURL}=require('url');
const ROOT=path.resolve(__dirname,'../..');
const FORMAT='workbunny-lighting/v1';
async function createLightingServer({port=8767,storageDirectory=path.join(ROOT,'.cache/lighting-lab')}={}) {
  const {normalizeLighting}=await import(pathToFileURL(path.join(ROOT,'src/renderer/avatar-lighting.mjs')));
  const {lightingForAvatar}=await import(pathToFileURL(path.join(ROOT,'src/renderer/avatar-lighting-profiles.mjs')));
  const avatars=require(path.join(ROOT,'src/main/avatars')).scan().filter(a=>!a.personal);
  const models=avatars.map(a=>({id:a.key,label:a.label,scale:a.light,url:'/assets/models/'+encodeURIComponent(a.file)}));
  const file=path.join(storageDirectory,'profiles.json'),nonce=crypto.randomBytes(18).toString('base64');
  fs.mkdirSync(storageDirectory,{recursive:true});
  function normalize(value) {
    if(value?.format!==FORMAT||!value.profiles||typeof value.profiles!=='object'||Array.isArray(value.profiles)||Object.keys(value.profiles).length>64) throw Error('请选择本工作台导出的参数文件');
    const profiles=Object.fromEntries(Object.entries(value.profiles).map(([id,row])=>{
      if(!id||id.length>160||['__proto__','prototype','constructor'].includes(id)||!row?.lighting||typeof row.lighting!=='object') throw Error('参数文件中的模型设置不正确');
      return [id,{label:String(row.label||id).slice(0,80),lighting:normalizeLighting(row.lighting)}];
    }));
    return {format:FORMAT,revision:Number.isSafeInteger(value.revision)?value.revision:0,updatedAt:value.updatedAt||null,profiles};
  }
  function read(){return normalize(JSON.parse(fs.readFileSync(file,'utf8')));}
  function write(value){const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);}
  if(!fs.existsSync(file))write({format:FORMAT,revision:0,updatedAt:null,profiles:Object.fromEntries(models.map(m=>[m.id,{label:m.label,lighting:lightingForAvatar(m.id,m.scale)}]))});
  const routes=new Map([['/','tools/lighting-lab/index.html'],['/lab.js','tools/lighting-lab/lab.js'],['/lab.css','tools/lighting-lab/lab.css'],['/brand.svg','res/logo.svg'],['/form-controls.css','src/renderer/form-controls.css'],['/avatar-lighting.mjs','src/renderer/avatar-lighting.mjs'],['/avatar-lighting-profiles.mjs','src/renderer/avatar-lighting-profiles.mjs'],['/ground.js','src/renderer/ground.js'],['/motion-quality.mjs','src/renderer/motion-quality.mjs']]);
  for(const name of ['three.module.js','three-vrm.module.js','three-vrm-animation.module.js','jsm/loaders/GLTFLoader.js','jsm/utils/BufferGeometryUtils.js'])routes.set('/vendor/'+name,'src/renderer/vendor/'+name);
  for(const name of ['OrbitControls.js','TransformControls.js'])routes.set('/vendor/jsm/controls/'+name,'node_modules/three/examples/jsm/controls/'+name);
  for(const m of models)routes.set(new URL(m.url,'http://localhost').pathname,'src/renderer/assets/models/'+m.id);
  routes.set('/idle.vrma','src/renderer/assets/motions/'+(fs.existsSync(path.join(ROOT,'src/renderer/assets/motions/idle_pose.vrma'))?'idle_pose.vrma':'idle_loop.vrma'));
  const mime={'.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.vrm':'model/gltf-binary','.vrma':'model/gltf-binary'};
  let origin;
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if(![origin.slice(7),origin.slice(7).replace('127.0.0.1','localhost')].includes(req.headers.host))return json(403,{error:'只允许从本机工作台访问'});
      const url=new URL(req.url,origin);
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(req.method==='GET'&&url.pathname==='/api/models')return json(200,{models});
      if(req.method==='GET'&&url.pathname==='/api/profiles'){try{return json(200,read());}catch{return json(503,{error:'旧参数文件暂不能读取，原文件已保留；可以先导出当前调整'});}}
      if(req.method==='GET'&&url.pathname==='/api/status')return json(200,{application:'workbunny-lighting-lab',url:origin,file});
      if(req.method==='POST'&&url.pathname==='/api/profiles'){
        if(req.headers.origin&&![origin,origin.replace('127.0.0.1','localhost')].includes(req.headers.origin))return json(403,{error:'不接受其他页面的保存请求'});
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(415,{error:'只接受 JSON 参数'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>512*1024)return json(413,{error:'参数文件过大'});chunks.push(chunk);}
        const value=normalize(JSON.parse(Buffer.concat(chunks).toString('utf8'))),previous=read();
        if(value.revision!==previous.revision)return json(409,{error:'其他页面更新了参数。请先导出你的调整，再重新载入页面'});
        value.revision++;value.updatedAt=new Date().toISOString();write(value);return json(200,{...value,file});
      }
      if(req.method!=='GET')return json(405,{error:'不支持此操作'});
      const relative=routes.get(url.pathname);if(!relative)return json(404,{error:'未找到文件'});
      const source=path.join(ROOT,relative),stat=fs.statSync(source);
      res.setHeader('Content-Type',mime[path.extname(source)]||'application/octet-stream');
      res.setHeader('Cache-Control',/\.(vrm|vrma)$/.test(source)?'private, max-age=3600':'no-store');
      if(path.extname(source)==='.html'){
        res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
        return res.end(fs.readFileSync(source,'utf8').replace('__NONCE__',nonce));
      }
      res.setHeader('Content-Length',stat.size);const stream=fs.createReadStream(source);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    } catch(error){if(!res.headersSent)json(400,{error:error instanceof SyntaxError?'参数文件不是有效 JSON':error.message});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  return {server,url:origin,file,models,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
if(require.main===module){
  const argument=process.argv.find(a=>a.startsWith('--port='));
  const port=argument?Number(argument.split('=')[1]):8767;
  const open=url=>require('child_process').spawn('open',[url],{stdio:'ignore'}).unref();
  createLightingServer({port}).then(lab=>{
    fs.writeFileSync(path.join(path.dirname(lab.file),'server.json'),JSON.stringify({pid:process.pid,url:lab.url,file:lab.file})+'\n');
    console.log('Bunny 灯光工作台：'+lab.url+'\n参数保存到：'+lab.file+'\n按 Ctrl+C 关闭工作台服务。');
    if(process.argv.includes('--open'))open(lab.url);
  }).catch(async e=>{
    if(e.code==='EADDRINUSE'){
      const url='http://127.0.0.1:'+port;
      try{const status=await fetch(url+'/api/status',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
        if(status.application==='workbunny-lighting-lab'){console.log('工作台已运行：'+url);if(process.argv.includes('--open'))open(url);return;}
      }catch{}
      console.error('端口 '+port+' 已被其他程序占用，请使用 --port=8768');
    }else console.error(e.message);
    process.exitCode=1;
  });
}
module.exports={createLightingServer};
