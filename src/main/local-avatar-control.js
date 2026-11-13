'use strict';
// Avatar diagnostics use the same settings and body execution as the UI.
function createLocalAvatarControl({ getScene, isReady, list, current, body, select }) {
  const guard = signal => {
    if (signal?.aborted) throw Object.assign(Error('形象操作已取消'), { code: 'E_LOCAL_CANCELLED' });
    if (getScene() !== 'life') throw Object.assign(Error('形象开发控制仅允许生活场景'), { code: 'E_LOCAL_SCENE' });
    if (!isReady()) throw Object.assign(Error('形象控制尚未就绪'), { code: 'E_LOCAL_UNAVAILABLE' });
  };
  const status = (_args, { signal } = {}) => {
    guard(signal);
    const view = body();
    const avatar = current();
    return { avatar: avatar ? { key: avatar.key, name: avatar.name, kind: avatar.kind } : null,
      ready: !!view.capabilities, performance: view.performance,
      avatars: list().map(({ key, label, kind }) => ({ key, name: label, kind: kind || 'vrm' })) };
  };
  return { status, async select({ key }, { signal } = {}) {
    guard(signal);
    if (typeof key !== 'string' || !list().some(avatar => avatar.key === key)) throw Object.assign(Error('形象不存在'), { code: 'E_LOCAL_PARAMS' });
    const receipt = await select(key, { signal, isCurrent: () => !signal?.aborted && getScene() === 'life' && isReady() });
    if (receipt?.ok === false) throw Object.assign(Error(receipt.error || '形象尚未加载成功'), { code: signal?.aborted ? 'E_LOCAL_CANCELLED' : 'E_AVATAR_NOT_READY' });
    return status({}, { signal });
  } };
}
module.exports = { createLocalAvatarControl };
