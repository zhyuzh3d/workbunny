'use strict';
// Device interaction is exclusively screenshots + generic touch/keyboard input.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function keyboardVisible(texts){const keys=new Set();for(const r of texts){const s=String(r.text||'').trim();if(r.y>.7&&/^[a-z0-9 ]{1,20}$/iu.test(s))for(const c of s.replace(/ /g,''))keys.add(c.toLowerCase()+':'+Math.round(r.x*20)+':'+Math.round(r.y*20));}return keys.size>=6&&texts.some(r=>r.y>.85&&/^(?:123|ABC|换行|返回|符号|空格|发送|回车)$/u.test(String(r.text||'').trim()));}
class VisualPhone{
 constructor({serial,directory,ocr,expectedHeader}){if(typeof expectedHeader!=='string'||!expectedHeader.trim())throw Error('Set the explicitly authorized phone conversation header');Object.assign(this,{serial,directory,ocr,expectedHeader});this.sequence=0;}
 adb(...args){return execFileSync('adb',['-s',this.serial,...args],{timeout:20000,maxBuffer:12*1024*1024});}
 async snapshot(name='phone'){
  const png=this.adb('exec-out','screencap','-p');const file=path.join(this.directory,name+'.png');fs.writeFileSync(file,png,{mode:0o600});
  const texts=await this.ocr(png);return {png,texts,file};
 }
 async assertChat(){
  const shot=await this.snapshot('phone-before');
  if(!shot.texts.some(r=>r.y<.09&&r.confidence>=.6&&String(r.text).trim().toLowerCase()===this.expectedHeader.toLowerCase()))throw new Error('Phone screen does not show the authorized test conversation; no input performed');
  const send=shot.texts.find(r=>r.y>.5&&r.x>.78&&r.text==='发送');
  if(send)throw new Error('Phone already has a draft; no input performed');return shot;
 }
 async send(text,{privateFixture=false}={}){
  if(!/^[\x20-\x7e]+$/u.test(text)||text.length>800)throw new Error('Phone fixture messages must be bounded ASCII text');
  const before=await this.assertChat();this.sequence++;
  const width=before.png.readUInt32BE(16),height=before.png.readUInt32BE(20);
  const journal=path.join(this.directory,'phone-send-'+this.sequence+'.json');
  const recordedText=privateFixture?'[private operator fixture]':text;
  fs.writeFileSync(journal,JSON.stringify({text:recordedText,at:Date.now(),state:'intent'}),{mode:0o600});
  if(!keyboardVisible(before.texts)){
   const {value:composer}=await require('../../src/main/agent-json').checkedJSON({vision:true,messages:[{role:'system',content:'手机软键盘未展开。只定位微信最底部、语音按钮右边、笑脸左边的白色消息输入编辑框。输出严格JSON {"x":0.4,"y":0.96}，坐标归一化。不要定位聊天气泡或输入法工具栏。'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+before.png.toString('base64')}}]}]},v=>{if(!v||!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<.15||v.x>.7||v.y<.85||v.y>.99)throw Error('未确认手机底部编辑框');return v;});
   this.adb('shell','input tap '+Math.round(composer.x*width)+' '+Math.round(composer.y*height));await pause(600);
   const focused=await this.assertChat();if(!keyboardVisible(focused.texts))throw Error('Phone keyboard was not visually confirmed; no text entered');
  }
  this.adb('shell','input text '+quote(text.replace(/ /g,'%s')));await pause(700);
  const draft=await this.snapshot('phone-draft-'+this.sequence);
  if(!draft.texts.some(r=>r.y<.09&&String(r.text).trim().toLowerCase()===this.expectedHeader.toLowerCase()))throw Error('Phone left the authorized conversation; no send performed');
  if(!draft.texts.some(r=>r.y>.5&&r.x>.78&&r.text==='发送'))throw new Error('Phone send button was not visually confirmed; text left as a draft, not retried');
  const send=draft.texts.find(r=>r.y>.5&&r.x>.78&&r.text==='发送');this.adb('shell','input tap '+Math.round((send.x+send.width/2)*width)+' '+Math.round((send.y+send.height/2)*height));await pause(900);
  const after=await this.snapshot('phone-sent-'+this.sequence);
  if(after.texts.some(r=>r.y>.5&&r.x>.78&&r.text==='发送'))throw new Error('Phone send result is uncertain; no retry');
  fs.writeFileSync(journal,JSON.stringify({text:recordedText,at:Date.now(),state:'submitted-and-composer-cleared'}),{mode:0o600});
  return after;
 }
 async recordFixtureVoice(){
  const before=await this.assertChat(),width=before.png.readUInt32BE(16),height=before.png.readUInt32BE(20);
  const {value:toggle}=await require('../../src/main/agent-json').checkedJSON({vision:true,messages:[{role:'system',content:'只定位微信编辑区最左侧的语音/键盘切换圆形按钮，输出JSON {"x":0.06,"y":0.61}。不是输入法自己的话筒，也不是聊天气泡。坐标归一化。'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+before.png.toString('base64')}}]}]},v=>{if(!v||v.x<0||v.x>.15||v.y<.5||v.y>.99)throw Error('voice toggle not visually located');return v;});
  this.adb('shell',`input tap ${Math.round(toggle.x*width)} ${Math.round(toggle.y*height)}`);await pause(600);
  const ready=await this.assertChat(),hold=ready.texts.find(r=>/按住.*说话/u.test(r.text));if(!hold)throw Error('phone hold-to-talk button is not visible');
  const audioDevices=execFileSync('/usr/bin/say',['-a','?'],{encoding:'utf8'}),device=/^\s*(\d+)\s+Mac mini扬声器\s*$/mu.exec(audioDevices)?.[1];if(!device)throw Error('fixture speaker is unavailable; no voice recorded');
  const {spawn}=require('node:child_process'),run=(command,args)=>new Promise((resolve,reject)=>{const p=spawn(command,args,{stdio:'ignore',timeout:15000});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('voice fixture child failed')));});
  const x=Math.round((hold.x+hold.width/2)*width),y=Math.round((hold.y+hold.height/2)*height),pressed=run('adb',['-s',this.serial,'shell',`input swipe ${x} ${y} ${x} ${y} 9000`]);
  await pause(900);await Promise.all([pressed,run('/usr/bin/say',['-a',device,'-v','Tingting','-r','190','会议调整到明天下午三点。请回复你收到的会议时间。'])]);await pause(1000);
  return this.snapshot('phone-fixture-voice-sent');
 }
}
module.exports={VisualPhone,keyboardVisible};
