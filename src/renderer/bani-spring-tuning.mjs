// User-facing strength percentages relative to the spring values in the model.
// Only settings change; vertices, weights, rest positions and other chains stay intact.
export function createSpringTuner(joints) {
  const groups={hair:[],chest:[]};
  for(const joint of joints||[]){
    const name=joint?.bone?.name||'',type=/^Hair/.test(name)?'hair':/^Breast/.test(name)?'chest':null;
    if(!type||!joint.settings)continue;
    const {stiffness,dragForce}=joint.settings;
    if(!Number.isFinite(stiffness)||!Number.isFinite(dragForce))continue;
    groups[type].push({joint,stiffness,dragForce});
  }
  return {
    count(type){return groups[type]?.length||0},
    set(type,percent){
      if(!groups[type])throw Error('未知弹性部位');
      const value=Number(percent);if(!Number.isFinite(value)||value<50||value>(type==='hair'?500:300))throw Error('弹性强度超出范围');
      const factor=100/value;
      for(const item of groups[type]){
        item.joint.settings.stiffness=item.stiffness*factor;
        item.joint.settings.dragForce=Math.max(0,Math.min(1,item.dragForce*factor));
      }
    }
  };
}
