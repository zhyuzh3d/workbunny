'use strict';
const diagnostics=require('./operation-diagnostics');

const GUI_IDLE_MS = 5000;

// Admission only: never call this between steps while an action owns the GUI.
// HID timestamps also include our injected events, so they cannot identify
// human interference with an action that has already started.
function createGuiAdmission({native,lease,ready=()=>true}) {
  return async () => {
    const record=(isReady,leaseFree,hidIdleMs)=>{
      const admissionReason=!isReady?'not-ready':!leaseFree?'gui-owned':!Number.isFinite(hidIdleMs)||hidIdleMs<0?'invalid-hid-idle':hidIdleMs<GUI_IDLE_MS?'recent-hid-input':'admitted';
      try{diagnostics.record('gui-admission',{ready:isReady,leaseFree,hidIdleMs,admissionReason,status:admissionReason==='admitted'?'confirmed':'not-dispatched'});}catch{}
      return admissionReason==='admitted';
    };
    let isReady=ready(),leaseFree=lease.isFree();
    if (!isReady || !leaseFree) return record(isReady,leaseFree);
    const idle = await native.request('inputIdle', {}, 5000);
    // Readiness and ownership can change while the native request is pending.
    isReady=ready();leaseFree=lease.isFree();
    return record(isReady,leaseFree,idle.hidIdleMs);
  };
}

module.exports = {GUI_IDLE_MS,createGuiAdmission};
