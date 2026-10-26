'use strict';

const { canRead, normalizeScene, rank } = require('./memory-scope');

function scopeFor(task, scopes, externalScope) {
  const id = task?.bunnyTaskId;
  if (typeof id !== 'string' || !id) return externalScope;
  const record = scopes instanceof Map ? scopes.get(id) : scopes?.[id];
  // A UUID-like marker is only a correlation hint. Require a durable row for
  // exactly that ID; missing/legacy/untrusted WorkBuddy tasks fail closed.
  if (!record || record.id !== id) return null;
  try {
    const candidate = { domain: record.domain, visibilityFloor: record.visibilityFloor };
    return canRead(normalizeScene('private'), candidate) && Number.isInteger(candidate.visibilityFloor) ? candidate : null;
  } catch { return null; }
}

function filterMonitorView(view, { scene = 'life', taskScopes = new Map(), bootAt, ready = false,
  externalScope = { domain: 'work', visibilityFloor: 0 } } = {}) {
  rank(scene);
  if (ready !== true) return { primary: null, running: [], done: [], count: 0 };
  try { if (!canRead('private', externalScope)) throw new Error('invalid external scope'); }
  catch { throw new Error('外部 WorkBuddy 场景范围无效'); }
  const afterBoot = row => !Number.isFinite(bootAt) || Math.max(Number(row?.endedAt) || 0, Number(row?.startedAt) || 0) >= bootAt;
  const visible = snap => {
    const task = snap?.task;
    const scope = scopeFor(task, taskScopes, externalScope);
    if (!scope || !canRead(scene, scope)) return false;
    // Historical unmarked WorkBuddy tasks have no durable Bunny record. Keep
    // currently running external work, but do not replay completed pre-boot work.
    if (!task?.bunnyTaskId && task?.status !== 'running' && !afterBoot(task)) return false;
    return true;
  };
  const clone = snap => ({ ...snap, task: snap.task ? { ...snap.task } : null,
    history: (snap.history || []).filter(item => {
      const scope = scopeFor(item, taskScopes, externalScope);
      return !!scope && canRead(scene, scope) && (!!item?.bunnyTaskId || afterBoot(item));
    }).map(item => ({ ...item })) });
  const running = (view?.running || []).filter(visible).map(clone);
  const done = (view?.done || []).filter(visible).map(clone);
  const primaryCandidate = view?.primary && visible(view.primary) ? view.primary : null;
  const primary = primaryCandidate ? [...running, ...done].find(s => s.sessionId === primaryCandidate.sessionId) || clone(primaryCandidate)
    : running[0] || done[0] || null;
  return { primary, running, done, count: running.length };
}

function taskLabel(task) {
  const source = String(task?.userText || task?.title || '').replace(/\s+/gu, ' ').trim();
  const first = source.split(/[。！？!?\n]/u)[0].trim() || '一件事';
  return first.length > 44 ? first.slice(0, 44) + '…' : first;
}
function plain(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-*·>\d.]{1,3}\s+/gm, '')
    .replace(/\s+/gu, ' ').trim();
}
function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
function formatMonitorContext(view, now = Date.now()) {
  const running = view?.running || [], done = view?.done || [];
  if (!running.length && !done.length) return '（暂时读不到 WorkBuddy 的任务信息）';
  const lines = [];
  if (running.length === 1) {
    const t = running[0].task;
    lines.push(`【现在正在做】${taskLabel(t)}`);
    lines.push(`已经做了 ${duration(now - t.startedAt)}，还没交付。`);
    if (t.failures >= 3) lines.push('过程里反复遇到阻碍，可能需要查看当前状态。');
  } else if (running.length > 1) {
    lines.push(`【现在同时在做 ${running.length} 件】`);
    for (const snap of running) lines.push(`· ${taskLabel(snap.task)} —— 已经 ${duration(now - snap.task.startedAt)}`);
    lines.push('主人问进度时逐件说明当前状态。');
  } else lines.push('【现在】没有正在运行的 WorkBuddy 任务。');

  if (done.length) {
    lines.push(running.length ? '【另外，刚做完的】' : '【刚做完的那件事】');
    for (const snap of done.slice(0, 3)) {
      const task = snap.task, verdict = task.status === 'failed' ? '没办成' : task.status === 'abandoned' ? '没下文' : '已给出答复，交付仍需核对';
      const result = task.summary ? `结果：${plain(task.summary).slice(0, 110)}` : '';
      lines.push(`· ${taskLabel(task)} —— ${verdict}，用了 ${duration(task.durationMs)}。${result}`);
    }
  }
  const shown = [];
  const seen = new Set(done.map(s => `${s.sessionId}:${s.task?.id}`));
  for (const snap of [...running, ...done]) for (const item of snap.history || []) {
    const identity = `${item.sessionId || snap.sessionId}:${item.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity); shown.push({ ...item, sessionId: item.sessionId || snap.sessionId });
  }
  shown.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  if (shown.length) {
    lines.push('【再往前做的】');
    for (const item of shown.slice(0, 3)) {
      const verdict = item.status === 'failed' ? '没办成' : item.status === 'abandoned' ? '没下文' : '已给出答复，交付仍需核对';
      const result = item.summary ? `：${plain(item.summary).slice(0, 55)}` : '';
      lines.push(`· ${taskLabel(item)}（${verdict}，${duration(item.durationMs)}）${result}`);
    }
  }
  lines.push('（以上是当前场景可见的 WorkBuddy 任务信息；交付仍需核对。）');
  return lines.join('\n');
}

function scopedMonitorContext(view, options = {}) {
  const filtered = filterMonitorView(view, options);
  const sourceIds = [...new Set([...filtered.running, ...filtered.done, ...(filtered.primary ? [filtered.primary] : [])]
    .flatMap(snap => [snap.task, ...(snap.history || [])]).map(task => task?.bunnyTaskId).filter(Boolean))];
  return { view: filtered, text: formatMonitorContext(filtered, options.now), sourceIds };
}

module.exports = { filterMonitorView, formatMonitorContext, scopedMonitorContext };
