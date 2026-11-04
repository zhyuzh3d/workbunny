'use strict';

const GUI_IDLE_MS = 5000;

// Admission only: never call this between steps while an action owns the GUI.
// HID timestamps also include our injected events, so they cannot identify
// human interference with an action that has already started.
function createGuiAdmission({native,lease,ready=()=>true}) {
  return async () => {
    if (!ready() || !lease.isFree()) return false;
    const idle = await native.request('inputIdle', {}, 5000);
    // Readiness and ownership can change while the native request is pending.
    return ready() && lease.isFree() && Number.isFinite(idle.hidIdleMs) && idle.hidIdleMs >= GUI_IDLE_MS;
  };
}

module.exports = {GUI_IDLE_MS,createGuiAdmission};
