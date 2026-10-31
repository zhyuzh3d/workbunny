const eyeKeys=new Set(['gx','gy','wl','wr','wide','joy','angry','sad','sleepy','heart','star','diamond','wavy','red','gold','blue']);
const channels=['x','y','z','px','py','pz','axial','squash','inflate','lx','lz','rx','rz','gx','gy','wl','wr','wide','joy','angry','sad','sleepy','heart','star','diamond','wavy','red','gold','blue','blush','earRed','coverL','coverR','earTurn','earClap','earHeart','cry','flash','giggle','fire','frost','step','bx','by','bz'];
const GRAVITY=6.0;
export function samplePerformance(item,time){
 const phase=Math.max(0,Math.min(1,time/item.duration)),f=item.frames;let i=0;
 while(i<f.length-2&&phase>f[i+1][0])i++;
 const [ta,a]=f[i],[tb,b,mode='soft']=f[i+1],u=Math.max(0,Math.min(1,(phase-ta)/(tb-ta)));
 // Fast hits have a much steeper middle than a soft move, while starting and
 // ending at rest. Wind-ups accelerate into their contact or launch.
 const e=mode==='cut'?(u>=1?1:0):mode==='snap'?(u<.5?4*u*u*u:1-4*(1-u)**3):mode==='wind'?u**3:mode==='linear'?u:u*u*(3-2*u);
 const out={},defaults={bx:2.1,by:-.53,bz:.8};
 for(const k of channels){
  const av=a[k]??defaults[k]??0,bv=b[k]??defaults[k]??0;
  // Eyes lead a head turn; blinking closes quickly and opens more gently.
  // Shape changes keep their own timing instead of inheriting the body's ease.
  let amount=e;
  if(eyeKeys.has(k)&&mode!=='cut'&&mode!=='linear'&&av!==bv){
   const rate=k==='wl'||k==='wr'?(bv>av?1.75:1.28):(k==='gx'||k==='gy'?1.45:(bv>av?1.35:1.12));
   const v=Math.min(1,u*rate);amount=v*v*(3-2*v);
  }
  out[k]=av+(bv-av)*amount;
 }
 // Constant downward acceleration during flight. A straight line connects
 // takeoff and landing heights; the parabolic lift gives the authored apex.
 function applyFlight(windows,key){for(const w of windows)if(phase>=w.from&&phase<=w.to){
  const q=(phase-w.from)/(w.to-w.from),seconds=(w.to-w.from)*item.duration;
  out[key]=w.y0+(w.y1-w.y0)*q+.5*GRAVITY*seconds*seconds*q*(1-q);break;
 }}
 applyFlight(item.flights,'y');applyFlight(item.ballFlights,'by');
 // On decisive head movements the eyes briefly gather focus before the move,
 // then reopen on the reaction. The pulse follows the authored beat rather
 // than a global timer, and never overrides an authored wink or special eye.
 if(mode==='snap'&&!item.ballSpec&&item.vfx!=='ice'){
  const authoredEye=['wl','wr','heart','star','diamond'].some(key=>(a[key]||0)>.04||(b[key]||0)>.04);
  const magnitude=Math.min(1,(Math.abs((b.py||0)-(a.py||0))*.75+Math.abs((b.pz||0)-(a.pz||0))*.7+Math.abs((b.px||0)-(a.px||0))*.6+Math.abs((b.x||0)-(a.x||0))*.25));
  if(!authoredEye&&magnitude>.18){
   const anticipation=Math.max(0,1-Math.abs(u-.18)/.18)*magnitude;
   out.wl=Math.max(out.wl,.18*anticipation);out.wr=Math.max(out.wr,.15*anticipation);
   if((out.angry||0)<.25&&(out.sad||0)<.25&&(out.sleepy||0)<.25){const reaction=Math.max(0,1-Math.abs(u-.78)/.22)*magnitude;out.wide=Math.min(1,out.wide+.12*reaction)}
  }
 }
 // A quick close, a short contact and a slower release; avoid adding a blink
 // over a keyed wink, strong emotion, or special-shaped eye.
 const blinkEligible=item.autoBlink===true;
 if(blinkEligible){
  const start=.55+(item.id%5)*.14;
  function blinkAt(local){if(local<0||local>.235)return 0;if(local<.065){const v=local/.065;return 1-(1-v)*(1-v)}if(local<.09)return 1;const v=(local-.09)/.145;return (1-v)*(1-v)}
  out.wl=Math.max(out.wl,blinkAt(time-start));out.wr=Math.max(out.wr,blinkAt(time-start-.009));
 }

 if(item.orbit){
  // The ball leads on a real horizontal ellipse; the head follows the same
  // track at a phase delay and recedes into depth before returning.
  const theta=phase*Math.PI*2,lead=1.25;
  out.x=1.9*Math.sin(theta);out.z=1.65*(Math.cos(theta)-1);out.py=theta;
  const stride=(phase*12)%1,strideTime=item.duration/12,hopHeight=GRAVITY*strideTime*strideTime/8;
  out.step=Math.sin(theta*6);out.y=4*hopHeight*stride*(1-stride);
  out.squash=.45*Math.max(0,1-Math.min(stride,1-stride)*10);out.bx=1.9*Math.sin(theta+lead);out.bz=1.65*(Math.cos(theta+lead)-1);out.by=-.53;
 }
 return out;
}
