'use strict';
/**
 * 任务级监控（多会话）
 * ─────────────────────────────────────────────────────────────
 * 数据源：WorkBuddy 自己的会话落盘 ~/.workbuddy/projects/<slug>/<sessionId>.jsonl
 * 不抓包、不注入，只 tail 这些文件（逐行 append，读增量就行）。
 * 每行都自带 timestamp（ms），所以回放历史时用的是真实时间，不会假装"刚刚发生"。
 *
 * 为什么要多会话：主人会**同时**开好几个 WorkBuddy 任务（几个窗口、几件事一起推）。
 * 只盯 mtime 最新的那个文件，就会出现「A 在跑却显示 B」「A 做完了没播报」这种漏报。
 * 现在每个 jsonl 各有一套独立的任务状态机，互不干扰；对外给一份汇总视图。
 *
 * 设计原则（主人明确要求）：
 *   1. **只看任务，不看命令行**。工具调用只用来数"推进了几步"、判"有没有反复撞墙"，
 *      绝不把命令、报错、文件路径当作要汇报的内容，也绝不因为某条命令失败就开口。
 *   2. **任务结束才播报**。一条用户消息 = 一个任务；任务交付（助手给出最终答复、
 *      之后没有新的工具调用/思考）才算结束，才值得说话。
 *   3. **答得出进度**。context() 给模型一份"人话版"战况：在做什么、多久了、
 *      到哪一步、最近几件做完了什么 —— 主人中途问进度必须答得上来（还可能是好几件一起）。
 *
 * 状态机（任务级，每个会话一份）
 *   user 消息（有实义文字）→ beginTask()   phase=running
 *   assistant 文字          → 记候选最终答复（candidateAt）
 *   之后又出现工具调用/思考 → 候选作废（说明那句只是中间汇报）
 *   静默 IDLE_MS 且候选有效 → finishTask('done')  → emit taskDone
 *
 * 事件：update（汇总）/ taskStart / taskDone / taskLong / taskStall（都带单个会话的 snap）
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { createHash } = require('crypto');

const SCAN_MS = 1200;          // 读文件增量的频率
const FULL_SCAN_MS = 6000;     // 全树找"有没有新会话"的频率（这个贵）
const IDLE_MS = 3200;          // 候选最终答复出现后，静默这么久 = 这一轮真交付了
const HISTORY_MAX = 8;         // 每个会话记住最近多少个已完成任务
const STALL_MS = 8 * 60e3;     // 运行中这么久没任何动静 = 卡住了
const LONG_MS = 6 * 60e3;      // 一个任务超过这么久 = 长任务，值得关心一次
const LONG_MS2 = 20 * 60e3;    // 再久一次
const ABANDON_MS = 25 * 60e3;  // 一直在跑却连答复都没有、也没动静 → 当它已经放下了
const TAIL_ON_ATTACH = 1500 * 1024;  // 首次接入回看的字节数（要够看到最近几个任务）

/* 多会话的边界 */
const MAX_SESSIONS = 6;              // 同时跟几个会话（再多也没意义，界面也放不下）
const ATTACH_WINDOW_MS = 6 * 3600e3; // 只接 6 小时内动过的会话文件
const KEEP_DONE_MS = 40 * 60e3;      // 已完成且静了这么久就让它退场，别无限涨

/** 只有正文开头明确由助手自述本次任务未完成才算失败；正文里的报错、引用和分析只是内容。 */
const SELF_FAILURE_OPENING = /^(?:(?:很)?抱歉|对不起)[，,:：\s]*(?:(?:我|我们)(?:这次|本次|目前|仍然)?(?:没能|未能|无法|不能|没法|做不到)(?:完成|办成|交付|解决|处理|执行)|(?:这次|本次|这个|该)(?:任务|工作)(?:我|我们)(?:没能|未能|无法|不能|没法|做不到)(?:完成|办成|交付|解决|处理|执行))|^(?:(?:我|我们)(?:这次|本次|目前|仍然)?(?:没能|未能|无法|不能|没法|做不到)(?:完成|办成|交付|解决|处理|执行)|(?:这次|本次|这个|该)(?:任务|工作)(?:我|我们)(?:没能|未能|无法|不能|没法|做不到)(?:完成|办成|交付|解决|处理|执行))|^I\s+(?:couldn't|could\s+not|was\s+unable\s+to)\s+(?:complete|finish|fulfill)\b/i;

/** 压缩/续接类消息不是主人下的新指令，不能当成新任务 */
const NOT_A_TASK = /<conversation_history_summary>|<compact-summary>|This session is being continued|Please continue with the conversation based on the summarized context/i;

function stripSystemReminders(s) {
  return String(s || '')
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
    .replace(/<memory_and_skills_reminder>[\s\S]*?<\/memory_and_skills_reminder>/g, '')
    .replace(/<\/?user_query>/g, '')
    .trim();
}

/** 把 content 拼成原始文本（不洗） */
function rawOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : (p && (p.text || (p.type === 'text' ? p.text : ''))) || ''))
    .filter(Boolean)
    .join('\n');
}

function textOf(content) {
  const raw = rawOf(content);
  // 后台任务完成通知是运行时自己塞进来的（<task-notification>…），不是主人说的话：
  // 整条都不算新指令，也不该拿去当任务名 —— 否则状态条上会出现一堆尖括号标签。
  if (/<task-notification>/i.test(raw)) return '';
  return stripSystemReminders(raw);
}

/** 这条 user 消息是不是"主人在下一个新指令" */
function isRealInstruction(txt) {
  const t = String(txt || '').trim();
  if (t.length < 2) return false;
  if (NOT_A_TASK.test(t)) return false;
  return true;
}

/** 一句话概括任务名：主人原话压成一行，别超过 44 字。
 *  不做任何「看起来像地址就换掉」的过滤 —— 主人说什么就显示什么，是链接就显示链接。 */
function taskName(t) {
  const raw = plain((t && (t.userText || t.title)) || '');
  if (!raw) return '一件事';
  const firstLine = raw.split(/[。！？!?\n]/)[0].trim() || raw;
  return firstLine.length > 44 ? firstLine.slice(0, 44) + '…' : firstLine;
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 任务结局 → 人话 */
function verdict(status) {
  if (status === 'failed') return '没办成';
  if (status === 'abandoned') return '没下文';
  return '已给出答复，交付仍需核对';
}

/** 助手答复是 markdown，念出来/塞给模型之前先洗成人话 */
function plain(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*·>\d.]{1,3}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Monitor extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.enabled = false;
    this.sessions = new Map();   // file → { file, offset, buf, snap, priming }
    this.snap = this.blank();    // 主会话（最近在跑 / 最近做完的那条），兼容旧调用
    this.file = null;
    this.view = { primary: null, running: [], done: [], count: 0 };
    this.scanTimer = null;
    this.seq = 0;
    this.fullScanAt = 0;
    this.dirCache = null;
    this.dirCacheAt = 0;
    this.lastSig = '';
  }

  blank() {
    return {
      sessionId: null,
      cwd: null,
      sessionTitle: null,
      phase: 'idle',          // idle | running | done
      userText: '',
      assistantText: '',
      lastEventAt: 0,
      task: null,             // 当前/最近一个任务
      history: [],            // 已完成任务，新的在前
    };
  }

  taskBlank(userText, startedAt) {
    return {
      id: ++this.seq,
      userText: String(userText || '').slice(0, 500),
      title: '',
      startedAt: startedAt || Date.now(),
      endedAt: 0,
      durationMs: 0,
      steps: 0,             // 工具调用次数（只用来衡量"推进程度"，不对外讲细节）
      failures: 0,          // 工具失败次数（只进隐藏字段，绝不主动提）
      status: 'running',    // running | ok | failed | abandoned
      summary: '',
      candidateAt: 0,       // 候选最终答复出现的时刻
      longNoticed: 0,       // 已经提醒过几次"这事时间有点长"
      stallNoticed: false,
    };
  }

  start(root) {
    this.root = root;
    this.enabled = true;
    this.scan();
    this.scanTimer = setInterval(() => this.scan(), SCAN_MS);
  }

  stop() {
    this.enabled = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  /** 定时器做三件事：全树找会话（贵，低频）；读每个文件的增量（便宜）；逐会话跑状态机 */
  scan() {
    if (!this.enabled) return;
    const now = Date.now();
    if (!this.dirCache || now - this.fullScanAt > FULL_SCAN_MS) {
      this.fullScanAt = now;
      this.walk();
    }
    for (const e of this.sessions.values()) this.readNew(e);
    for (const e of this.sessions.values()) this.tick(e.snap);
    this.publish();
  }

  /** 全树扫一遍 jsonl（跨所有项目）。目录列表缓存 30 秒，别每次都 readdir */
  walk() {
    if (!this.dirCache || Date.now() - this.dirCacheAt > 30000) {
      try {
        this.dirCache = fs
          .readdirSync(this.root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(this.root, d.name));
        this.dirCacheAt = Date.now();
      } catch {
        return;
      }
    }
    const found = [];
    for (const dir of this.dirCache) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of files) {
        if (!n.endsWith('.jsonl')) continue;
        const p = path.join(dir, n);
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        found.push({ file: p, size: st.size, mtime: st.mtimeMs });
      }
    }
    const now = Date.now();
    // 只接最近动过的，且只接前 MAX_SESSIONS 个（同一秒里改过的都算）
    const live = found
      .filter((f) => now - f.mtime < ATTACH_WINDOW_MS)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SESSIONS);
    for (const f of live) {
      if (!this.sessions.has(f.file)) this.attach(f);
    }
    // 退场：文件已经不在活跃名单里、手上没有在跑的任务、而且静了很久
    const liveSet = new Set(live.map((f) => f.file));
    for (const [file, e] of this.sessions) {
      if (liveSet.has(file)) continue;
      const t = e.snap.task;
      if (t && t.status === 'running') continue;         // 在跑的绝不丢
      if (now - (e.snap.lastEventAt || 0) < KEEP_DONE_MS) continue;
      this.sessions.delete(file);
    }
  }

  /** 接上一个会话文件：从头查台账，但只回看尾部，别一次性灌几 MB */
  attach(f) {
    const e = { file: f.file, offset: 0, buf: '', decoder: new StringDecoder('utf8'), snap: this.blank(), priming: true };
    e.snap.sessionId = path.basename(f.file, '.jsonl');
    if (f.size > TAIL_ON_ATTACH) e.offset = f.size - TAIL_ON_ATTACH;
    this.sessions.set(f.file, e);
    this.readNew(e);                 // priming=true：只建台账，不发声
    e.priming = false;
  }

  readNew(e) {
    if (!e.file) return;
    let fd, reset = false;
    const wasPriming = e.priming;
    try {
      const st = fs.statSync(e.file);
      if (st.size < e.offset || (e.ino !== undefined && e.ino !== st.ino)) {
        e.offset = 0; e.buf = ''; e.decoder = new StringDecoder('utf8');
        e.snap = this.blank(); e.snap.sessionId = path.basename(e.file, '.jsonl');
        e.priming = true; reset = true;
      }
      e.ino = st.ino;
      if (st.size <= e.offset) return;
      fd = fs.openSync(e.file, 'r');
      const len = Math.min(st.size - e.offset, TAIL_ON_ATTACH);
      const b = Buffer.alloc(len);
      const count = fs.readSync(fd, b, 0, len, e.offset);
      e.offset += count;
      e.decoder ||= new StringDecoder('utf8');
      e.buf += e.decoder.write(b.subarray(0, count));
    } catch {
      return;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (reset && !e.buf) e.priming = wasPriming;
    }

    let nl;
    while ((nl = e.buf.indexOf('\n')) >= 0) {
      const line = e.buf.slice(0, nl).trim();
      e.buf = e.buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        this.handleEvent(o, e);
      } catch {}
    }
    if (reset) e.priming = wasPriming;
  }

  handleEvent(o, e) {
    const t = o.type;
    const s = e.snap;
    // 行里自带真实时间，回放历史时不会假装"刚刚发生"
    const ts = Number(o.timestamp) || Date.parse(String(o.timestamp)) || Date.now();

    if (t === 'session-meta') {
      if (o.cwd) s.cwd = o.cwd;
      return;
    }
    // 记「当前任务最新一次动静」—— 用行内时间，回放历史时不会假装刚刚发生
    if (ts) s.lastEventAt = ts;

    if (t === 'ai-title') {
      if (o.aiTitle) {
        s.sessionTitle = o.aiTitle;
        if (s.task && !s.task.title) s.task.title = o.aiTitle;
      }
      return;
    }

    if (t === 'message') {
      if (o.role === 'user') {
        const txt = textOf(o.content);
        if (isRealInstruction(txt)) {
          this.finishTask('superseded', ts, s);
          this.beginTask(txt, ts, s, e);
        }
      } else if (o.role === 'assistant') {
        const txt = textOf(o.content);
        if (txt && s.task && s.task.status === 'running') {
          const model = o.providerData?.model || o.model;
          if (typeof model === 'string') s.task.model = model;
          s.assistantText = txt;
          s.task.summary = txt;
          s.task.candidateAt = ts;
          if (!e.priming) this.emit('update', s);
        }
      }
      return;
    }

    // 只要又出现思考或工具调用，就说明刚才那段文字只是中间汇报
    if (t === 'reasoning') {
      if (s.task && s.task.status === 'running') {
        s.task.candidateAt = 0;
        const model = o.providerData?.model || o.model;
        if (typeof model === 'string') s.task.model = model;
      }
      return;
    }

    if (t === 'function_call') {
      if (s.task && s.task.status === 'running') {
        s.task.candidateAt = 0;
        s.task.steps += 1;
        s.phase = 'running';
        if (!e.priming) this.emit('update', s);
      }
      return;
    }

    if (t === 'function_call_result') {
      const st = o.status || 'completed';
      if (st !== 'completed' && s.task && s.task.status === 'running') s.task.failures += 1;
      return;
    }
  }

  beginTask(txt, ts, s, e) {
    s.task = this.taskBlank(txt, ts);
    // UI counters are process-local. Delegation needs an identity that survives
    // reattaching files in a different order or restarting the monitor.
    s.task.messageKey = createHash('sha256').update(`${s.sessionId || ''}\0${ts}\0${txt}`).digest('hex');
    // Extract before taskBlank bounds the public userText to 500 characters.
    const markers = [...txt.matchAll(/\[workbunny:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g)];
    if (new Set(markers.map(m => m[1])).size === 1) s.task.bunnyTaskId = markers[0][1];
    s.userText = s.task.userText;
    s.assistantText = '';
    s.phase = 'running';
    if (!(e && e.priming)) {
      this.emit('taskStart', s);
      this.emit('update', s);
    }
  }

  /** 收掉当前任务（正常交付 / 被新指令顶掉 / 超时放弃） */
  finishTask(reason, atTs, s) {
    const t = s.task;
    if (!t || t.status !== 'running') return;
    // 被新指令顶掉时，用新指令的时间当结束时间，这样耗时才是真的
    const endAt = reason === 'superseded' ? atTs || s.lastEventAt || Date.now() : s.lastEventAt || Date.now();
    t.endedAt = endAt;
    t.durationMs = Math.max(0, t.endedAt - t.startedAt);
    // 被新指令顶掉、而助手还没给出最终答复时，手里那段只是中间汇报，不能当结果记
    if (reason === 'superseded' && !t.candidateAt) t.summary = '';
    t.status =
      reason === 'abandoned' || (reason === 'superseded' && !t.summary)
        ? 'abandoned'
        : t.summary && SELF_FAILURE_OPENING.test(t.summary.trim())
          ? 'failed'
          : 'ok';
    t.endReason = reason || 'done';
    s.phase = 'done';

    s.history.unshift({
      id: t.id,
      userText: t.userText,
      title: t.title,
      summary: t.summary,
      status: t.status,
      durationMs: t.durationMs,
      endedAt: t.endedAt,
      sessionId: s.sessionId,
      startedAt: t.startedAt,
      bunnyTaskId: t.bunnyTaskId,
      model: t.model,
      endReason: t.endReason,
      messageKey: t.messageKey,
    });
    if (s.history.length > HISTORY_MAX) s.history.length = HISTORY_MAX;

    // 只有"正常交付"才值得播报；被新指令顶掉/超时的旧任务不必打扰主人
    if (reason === 'done') this.emit('taskDone', s);
    this.emit('update', s);
  }

  /** 每轮扫描后检查：该收工了吗？是不是拖太久了？是不是卡住了？（逐会话） */
  tick(s) {
    const t = s.task;
    if (!t || t.status !== 'running') return;
    const now = Date.now();
    const idle = now - (s.lastEventAt || now);
    const elapsed = now - t.startedAt;

    // 1) 交付判定：有候选最终答复 + 真静下来了
    if (t.candidateAt && idle > IDLE_MS) {
      this.finishTask('done', undefined, s);
      return;
    }

    // 2) 彻底没动静也没答复：当主人已经走开了，别一直挂着"正在进行"
    if (idle > ABANDON_MS) {
      this.finishTask('abandoned', undefined, s);
      return;
    }

    // 3) 卡住：一直在跑，但很久没有任何动静 —— 比"拖太久"更值得说，优先
    if (idle > STALL_MS) {
      if (!t.stallNoticed) {
        t.stallNoticed = true;
        this.emit('taskStall', { snap: s, idleMs: idle });
      }
      return;
    }

    // 4) 长任务（还在推进，只是慢）：第一次 6 分钟、第二次 20 分钟
    if (elapsed > LONG_MS && t.longNoticed === 0) {
      t.longNoticed = 1;
      this.emit('taskLong', { snap: s, elapsedMs: elapsed, round: 1 });
      return;
    }
    if (elapsed > LONG_MS2 && t.longNoticed === 1) {
      t.longNoticed = 2;
      this.emit('taskLong', { snap: s, elapsedMs: elapsed, round: 2 });
    }
  }

  /**
   * 汇总：在跑的全部排前面（越近动过越前），再往后排最近做完的。
   * 只在"结构真的变了"的时候发 update，避免每 1.2 秒吵一次前端。
   */
  publish() {
    const arr = [...this.sessions.values()].map((e) => e.snap).filter((s) => s.sessionId);
    const running = arr
      .filter((s) => s.task && s.task.status === 'running')
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
    const done = arr
      .filter((s) => s.task && s.task.status !== 'running')
      .sort((a, b) => (b.task.endedAt || 0) - (a.task.endedAt || 0));
    const primary = running[0] || done[0] || null;
    this.snap = primary || this.blank();
    this.file = primary ? this.primaryFileOf(primary) : null;
    const view = { primary, running, done: done.slice(0, 4), count: running.length };
    this.view = view;

    const sig = JSON.stringify([
      running.map((s) => [s.sessionId, s.task.id, s.task.steps, s.task.candidateAt > 0]),
      done.slice(0, 4).map((s) => [s.sessionId, s.task.id, s.task.status]),
    ]);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.emit('update', view);
    }
  }

  primaryFileOf(snap) {
    for (const [file, e] of this.sessions) if (e.snap === snap) return file;
    return null;
  }

  /**
   * 给大脑看的「人话战况」。
   * 只讲：在做什么、多久了、到哪一步、最近做完的几件事和结果。
   * 不讲：命令、路径、工具名、单条报错 —— 主人不关心这些。
   * 标题必须明确区分「正在做」和「刚做完」，否则模型会把几件事混成一件。
   * 多会话时按"几件同时在跑"来叙述，别说成一件。
   */
  context() {
    const v = this.view || { running: [], done: [], primary: null };
    const running = v.running || [];
    const done = v.done || [];
    if (!running.length && !done.length) return '（暂时读不到 WorkBuddy 的任务信息）';
    const L = [];

    if (running.length === 1) {
      const t = running[0].task;
      const mins = Math.round((Date.now() - t.startedAt) / 60000);
      L.push(`【现在正在做】${taskName(t)}`);
      L.push(`已经做了 ${dur(Date.now() - t.startedAt)}${mins >= 20 ? '（拖得有点久了）' : ''}，还没交付。`);
      if (t.steps >= 8) L.push(`（心里有数就行：这活不小，内部推进了 ${t.steps} 次操作。别把这个数字说出口。）`);
      if (t.failures >= 3) L.push('过程里反复撞了几次墙，可能卡在某个绕不过去的地方。');
    } else if (running.length > 1) {
      L.push(`【现在同时在做 ${running.length} 件】`);
      for (const s of running) {
        const t = s.task;
        const mins = Math.round((Date.now() - t.startedAt) / 60000);
        L.push(`· ${taskName(t)} —— 已经 ${dur(Date.now() - t.startedAt)}${mins >= 20 ? '（有点久了）' : ''}`);
      }
      L.push('（主人问"做到哪了"要先说清现在有几件在跑，再逐件说，别只答一件。）');
    } else {
      L.push('【现在】主人手上没有正在跑的事，WorkBuddy 是空的。');
    }

    if (done.length) {
      L.push(running.length ? '【另外，刚做完的】' : '【刚做完的那件事】');
      for (const s of done.slice(0, 3)) {
        const t = s.task;
        const tail = t.summary ? `结果：${plain(t.summary).slice(0, 110)}` : '';
        L.push(`· ${taskName(t)} —— ${verdict(t.status)}，用了 ${dur(t.durationMs)}。${tail}`);
      }
    }

    // 再往前的历史（跨会话合并，只看最近 3 件）
    const hist = [];
    for (const e of this.sessions.values()) {
      for (const h of e.snap.history || []) hist.push(h);
    }
    hist.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const shown = hist
      .filter((h) => !done.some((s) => s.task && s.task.id === h.id && s.sessionId === h.sessionId))
      .slice(0, 3);
    if (shown.length) {
      L.push('【再往前做的】');
      for (const h of shown) {
        const tail = h.summary ? `：${plain(h.summary).slice(0, 55)}` : '';
        L.push(`· ${taskName(h)}（${verdict(h.status)}，${dur(h.durationMs)}）${tail}`);
      }
    }

    L.push('（以上是你能看到的全部事实。问"做到哪了"就答正在做的那几件；问"成了没 / 结果"就答刚做完的。别编。）');
    return L.join('\n');
  }
}

module.exports = { Monitor, taskName, dur };
