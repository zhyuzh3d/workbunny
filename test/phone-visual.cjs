'use strict';
// Device interaction is exclusively screenshots + generic touch/keyboard input.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function keyboardVisible(texts){const keys=new Set(texts.filter(r=>r.y>.7&&/^[a-z]$/iu.test(r.text)).map(r=>r.text.toLowerCase()+':'+Math.round(r.x*20)+':'+Math.round(r.y*20)));return keys.size>=6&&texts.some(r=>r.y>.9&&r.text==='123');}
class VisualPhone{
 constructor({serial,directory,ocr,expectedHeader='zhyuzh'}){Object.assign(this,{serial,directory,ocr,expectedHeader});this.sequence=0;}
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
 async send(text){
  if(!/^[\x20-\x7e]+$/u.test(text)||text.length>800)throw new Error('Phone fixture messages must be bounded ASCII text');
  const before=await this.assertChat();this.sequence++;
  const width=before.png.readUInt32BE(16),height=before.png.readUInt32BE(20);
  const journal=path.join(this.directory,'phone-send-'+this.sequence+'.json');
  fs.writeFileSync(journal,JSON.stringify({text,at:Date.now(),state:'intent'}),{mode:0o600});
  if(!keyboardVisible(before.texts)){
   const {value:composer}=await require('../src/main/agent-json').checkedJSON({vision:true,messages:[{role:'system',content:'手机软键盘未展开。只定位微信最底部、语音按钮右边、笑脸左边的白色消息输入编辑框。输出严格JSON {"x":0.4,"y":0.96}，坐标归一化。不要定位聊天气泡或输入法工具栏。'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+before.png.toString('base64')}}]}]},v=>{if(!v||!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<.15||v.x>.7||v.y<.85||v.y>.99)throw Error('未确认手机底部编辑框');return v;});
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
  fs.writeFileSync(journal,JSON.stringify({text,at:Date.now(),state:'submitted-and-composer-cleared'}),{mode:0o600});
  return after;
 }
}
module.exports={VisualPhone,keyboardVisible};
