// Interpret only reported state; an unavailable device is not proof of a denied permission.
export function boperView(status) {
  if (!status) return { kind: 'loading', title: '正在检查键鼠组件', description: '请稍候。' };
  const native = status.native || {};
  const state = status.state || native.state;
  if (state === 'transitioning') return { kind: 'working', title: '正在准备键鼠组件', description: '请完成系统可能显示的提示。' };
  if (state === 'fault' || state === 'faulted' && native.error) return { kind: 'fault', title: '键鼠组件遇到问题', description: '输入已暂停。可尝试修复组件，再重新检测。' };
  if (!status.enabled) return { kind: 'disabled', title: '尚未启用虚拟键鼠', description: '普通应用可使用系统输入；微信需要启用虚拟键鼠。' };
  if (state === 'ready') return { kind: 'ready', title: '已就绪，可以使用', description: '虚拟键鼠已启用。' };
  if (state === 'install-required' || native.installed === false) return { kind: 'install', title: '需要安装键鼠组件', description: '启用时 macOS 可能要求输入本机管理员密码。' };
  if (state === 'update-required' || native.updateRequired === true || native.driverVersionMismatched === true) return { kind: 'update', title: '需要更新键鼠组件', description: '请更新组件，再按系统提示完成授权。' };
  if (['requires-approval', 'needsApproval'].includes(state) || native.approvalRequired === true || native.settingsRequired === true) return { kind: 'approval', title: '等待系统授权', description: '请在系统设置中允许所需项目，完成后重新检测。' };
  if (native.helperConnected && (native.connected === false || native.keyboardReady === false || native.pointingReady === false)) return { kind: 'driver', title: '虚拟键鼠尚未就绪', description: '请检查系统是否需要允许虚拟键鼠驱动，完成后重新检测。' };
  return { kind: 'unavailable', title: '键鼠组件尚未就绪', description: '可先重新检测；若仍未就绪，请尝试修复组件。' };
}

export function cleanBoperError(error) {
  return String(error?.message || error || '').replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^(?:Error:\s*)+/i, '').trim();
}

export function mountBoperSettings(root, api, options = {}) {
  if (!root || !api.boperStatus || !api.boperControl) return;
  let status = null, busy = false, failure = '', tested = false, pendingStatus = null, receivedStatus = false;
  let guideOpen = null, advancedOpen = false, detailsOpen = false;
  let active = false, activationPending = false, screenRequested = false;
  const merge = next => ({ ...next, setupGuide: next.setupGuide || status?.setupGuide, permissions: next.permissions ?? status?.permissions });
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, action, primary = false, disabled = false) => {
    const node = el('button', 'mini' + (primary ? ' boper-primary' : ''), label);
    node.type = 'button'; node.disabled = busy || disabled; node.onclick = action;
    return node;
  };
  const details = (label, isOpen, setOpen) => {
    const node = el('details', 'boper-details'); node.open = isOpen;
    const summary = el('summary', '', label);
    summary.onclick = () => setOpen(!node.open);
    node.append(summary); return node;
  };
  function paint(next) {
    if (next) status = merge(next);
    const view = !status && failure
      ? { kind: 'unavailable', title: '无法检查键鼠组件', description: '请重新检测。' }
      : boperView(status), guide = status?.setupGuide || {};
    const section = el('div', 'boper-settings');
    const header = el('header', 'boper-heading');
    header.append(el('h2', '', '键盘与鼠标'), el('p', '', '让 Bunny 使用键盘和鼠标操作电脑。'), el('p', 'boper-instant', '本页操作即时生效。'));
    section.append(header);
    const card = el('section', 'boper-status boper-' + view.kind);
    card.setAttribute('role', 'status');
    const progress = {
      enable: ['正在启用虚拟键鼠', '请完成安装及可能出现的 macOS 授权提示。'],
      refresh: ['正在重新检测', '请稍候。'],
      settings: ['正在打开授权设置', '请稍候。'],
      disable: ['正在关闭虚拟键鼠', '请稍候。'],
      test: ['正在验证输入', '请暂停使用键盘和鼠标，验证约需 15 秒。'],
      permissions: ['正在检查屏幕识别权限', '请稍候。'],
      authorize_screen: ['正在请求屏幕识别权限', '请按 macOS 提示操作。'],
    }[busy];
    card.append(el('div', 'boper-status-title', progress?.[0] || view.title));
    card.append(el('p', '', progress?.[1] || view.description));
    if (failure) card.append(el('p', 'boper-error', '操作未完成，请查看详情后重试。'));
    const actions = el('div', 'boper-actions');
    if (['disabled', 'install', 'update'].includes(view.kind)) actions.append(button(view.kind === 'update' ? '更新并启用' : '启用虚拟键鼠', () => perform('enable'), true));
    if (['approval', 'driver'].includes(view.kind)) {
      actions.append(button('打开授权设置', () => perform('settings'), true), button('我已允许，重新检测', () => perform('refresh')));
      const path = Array.isArray(guide.approvalPath) ? guide.approvalPath.join(' › ') : guide.approvalPath;
      card.append(el('p', 'boper-hint', path ? `授权位置：${path}` : '请按系统提示打开设置并检查所需授权。'));
      if (view.kind === 'driver') card.append(el('p', 'boper-hint', `驱动：${guide.driverName || 'Karabiner VirtualHIDDevice'}${guide.publisher ? `（${guide.publisher}）` : ''}`));
    }
    if (['fault', 'unavailable'].includes(view.kind)) actions.append(button('修复并启用', () => perform('enable'), true), button('重新检测', () => perform('refresh')));
    if (view.kind === 'ready') actions.append(button('重新检测', () => perform('refresh')));
    if (actions.children.length) card.append(actions);
    const technical = cleanBoperError(failure || status?.error || status?.native?.error);
    if (technical) {
      const info = details('技术详情', detailsOpen, value => { detailsOpen = value; });
      info.append(el('pre', '', technical)); card.append(info);
    }
    section.append(card);
    const instruction = details('首次使用说明', guideOpen ?? view.kind !== 'ready', value => { guideOpen = value; });
    const steps = el('ol', 'boper-steps');
    for (const text of ['点击“启用虚拟键鼠”，系统可能要求输入本机管理员密码。', `按系统提示允许 ${guide.driverName || 'Karabiner VirtualHIDDevice'} 驱动${guide.publisher ? `（${guide.publisher}）` : ''}。`, '返回这里重新检测，确认已就绪。']) steps.append(el('li', '', text));
    instruction.append(steps); section.append(instruction);
    const screenAllowed = status?.permissions?.screenCaptureAllowed;
    const screen = el('section', 'boper-screen');
    const screenHead = el('div', 'boper-screen-heading');
    screenHead.append(el('h3', '', '屏幕识别'), el('span', screenAllowed === true ? 'boper-screen-ok' : 'boper-screen-pending', screenAllowed === true ? '已允许' : screenAllowed === false ? '未允许' : '尚未检查'));
    screen.append(screenHead, el('p', '', '用于识别屏幕上的界面。'));
    if (screenAllowed !== true) {
      if (screenAllowed === false) screen.append(button('允许识别屏幕', () => perform('authorize_screen'), true));
      screen.append(button('重新检测屏幕权限', () => perform('permissions')));
      if (screenRequested) screen.append(el('p', 'boper-hint', `${screenAllowed === false ? '仍未允许' : '如尚未允许'}，请前往${guide.screenApprovalPath || '系统设置 → 隐私与安全性 → 屏幕录制'}允许 WorkBunny，然后重新检测。`));
    }
    section.append(screen);
    if (view.kind === 'ready') {
      const test = el('section', 'boper-test');
      test.append(el('h3', '', '验证输入（可选）'), el('p', '', '测试约需 15 秒，会移动鼠标并输入合成文字。请先暂停使用键盘和鼠标，并切换到生活场景。'));
      const scene = options.getScene?.();
      if (scene !== 'life') {
        test.append(el('p', 'boper-hint', '请先在场景设置中切换到生活场景。'));
        if (options.onChooseScene) test.append(button('前往场景设置', options.onChooseScene));
      }
      if (screenAllowed !== true) test.append(el('p', 'boper-hint', screenAllowed === false ? '请先允许屏幕识别，才能验证输入。' : '请先检查屏幕识别权限。'));
      test.append(button('开始验证', () => perform('test'), true, scene !== 'life' || screenAllowed !== true));
      if (tested) test.append(el('p', 'boper-tested', '本次输入验证已通过。'));
      section.append(test);
    }
    if (status?.enabled) {
      const advanced = details('高级设置', advancedOpen, value => { advancedOpen = value; });
      advanced.append(el('p', '', '关闭后，普通软件使用系统输入；微信键鼠操作将暂停，重新启用虚拟键鼠后才能继续。'), button('关闭虚拟模式', () => perform('disable')));
      section.append(advanced);
    }
    root.replaceChildren(section);
  }
  async function perform(action) {
    if (busy || action === 'test' && (options.getScene?.() !== 'life' || boperView(status).kind !== 'ready' || status?.permissions?.screenCaptureAllowed !== true)) return;
    busy = action; pendingStatus = null; failure = ''; if (action !== 'settings') tested = false;
    if (action === 'authorize_screen') screenRequested = true;
    if (action === 'permissions' || action === 'refresh') { if (status) status = { ...status, permissions: undefined }; }
    paint();
    try {
      let result = await api.boperControl(action);
      if (result) status = merge(result);
      if (action === 'refresh') {
        result = await api.boperControl('permissions');
        if (result) status = merge(result);
      }
      if (action === 'test') tested = true;
    } catch (error) {
      if (pendingStatus) status = merge(pendingStatus);
      if (action === 'permissions' || action === 'refresh' || action === 'authorize_screen') { if (status) status = { ...status, permissions: undefined }; }
      failure = cleanBoperError(error);
    } finally {
      busy = false; paint();
      if (active && activationPending) { activationPending = false; void perform('permissions'); }
    }
  }
  api.on(event => {
    if (event.type !== 'boper') return;
    receivedStatus = true;
    if (busy) { pendingStatus = event; return; }
    if (event.state !== 'ready' || !event.enabled) tested = false;
    paint(event);
  });
  paint();
  void api.boperStatus().then(result => {
    if (!busy && !receivedStatus) paint(result);
    else if (result?.setupGuide && status && !status.setupGuide) { status = { ...status, setupGuide: result.setupGuide }; if (!busy) paint(); }
  }).catch(error => { if (!busy && !receivedStatus) { failure = cleanBoperError(error); paint(); } });
  return { paint, refreshView: () => paint(),
    activate: () => { if (active) { paint(); return; } active = true; if (busy) activationPending = true; else void perform('permissions'); },
    deactivate: () => { active = false; activationPending = false; },
  };
}
