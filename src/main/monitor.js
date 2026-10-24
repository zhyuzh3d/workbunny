'use strict';
/**
 * 任务级监控
 * ─────────────────────────────────────────────────────────────
 * 数据源：WorkBuddy 自己的会话落盘 ~/.workbuddy/projects/<slug>/<sessionId>.jsonl
 * 不抓包、不注入，只 tail 这个文件（逐行 append，读增量就行）。
 * 每行都自带 timestamp（ms），所以回放历史时用的是真实时间，不会假装"刚刚发生"。
 *
 * 设计原则（主人明确要求）：
 *   1. **只看任务，不看命令行**。工具调用只用来数"推进了几步"、判"有没有反复撞墙"，
 *      绝不把命令、报错、文件路径当作要汇报的内容，也绝不因为某条命令失败就开口。
 *   2. **任务结束才播报**。一条用户消息 = 一个任务；任务交付（助手给出最终答复、
 *      之后没有新的工具调用/思考）才算结束，才值得说话。
 *   3. **答得出进度**。context() 给模型一份"人话版"战况：在做什么、多久了、
 *      到哪一步、最近几件做完了什么 —— 主人中途问进度必须答得上来。
 *
 * 状态机（任务级）
 *   user 消息（有实义文字）→ beginTask()   phase=running
 *   assistant 文字          → 记候选最终答复（candidateAt）
 *   之后又出现工具调用/思考 → 候选作废（说明那句只是中间汇报）
 *   静默 IDLE_MS 且候选有效 → finishTask('done')  → emit taskDone
 *
 * 事件：update / taskStart / taskDone / taskLong / taskStall
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SCAN_MS = 1200;          // 读当前文件增量的频率
const FULL_SCAN_MS = 6000;     // 全树找"是不是换会话了"的频率（这个贵）
const IDLE_MS = 3200;          // 候选最终答复出现后，静默这么久 = 这一轮真交付了
const HISTORY_MAX = 8;         // 记住最近多少个已完成任务（给"给建议"用）
const STALL_MS = 8 * 60e3;     // 运行中这么久没任何动静 = 卡住了
const LONG_MS = 6 * 60e3;      // 一个任务超过这么久 = 长任务，值得关心一次
const LONG_MS2 = 20 * 60e3;    // 再久一次
const ABANDON_MS = 25 * 60e3;  // 一直在跑却连答复都没有、也没动静 → 当它已经放下了
const TAIL_ON_ATTACH = 1500 * 1024;  // 首次接入回看的字节数（要够看到最近几个任务）

/** 只有「助手自己说这件事没办成」才算失败 —— 不看命令行回显 */
const FAIL_WORDS = /失败|没能|没能完成|无法完成|做不到|没有成功|还是不行|权限不足|没跑通/;

/** 压缩/续接类消息不是主人下的新指令，不能当成新任务 */
const NOT_A_TASK = /<conversation_history_summary>|<compact-summary>|This session is being continued|Please continue with the conversation based on the summarized context/i;

function stripSystemReminders(s) {
  return String(s || '')
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
    .replace(/<memory_and_skills_reminder>[\s\S]*?<\/memory_and_skills_reminder>/g, '')
    .replace(/<\/?user_query>/g, '')
    .trim();
}

function textOf(content) {
  if (typeof content === 'string') return stripSystemReminders(content);
  if (!Array.isArray(content)) return '';
  return stripSystemReminders(
    content
      .map((p) => (typeof p === 'string' ? p : (p && (p.text || (p.type === 'text' ? p.text : ''))) || ''))
      .filter(Boolean)
      .join('\n')
  );
}

/** 这条 user 消息是不是"主人在下一个新指令" */
function isRealInstruction(txt) {
  const t = String(txt || '').trim();
  if (t.length < 2) return false;
  if (NOT_A_TASK.test(t)) return false;
  return true;
}

/** 一句话概括任务名：主人的原话压成一行，别超过 44 字 */
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
  return '做完了';
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
    this.file = null;
    this.offset = 0;
    this.offsets = new Map();
    this.buf = '';
    this.scanTimer = null;
    this.enabled = false;
    this.priming = false;      // 刚接上文件、正在回放历史：只建台账，不发声
    this.snap = this.blank();
    this.seq = 0;
    this.fullScanAt = 0;
    this.dirCache = null;
    this.dirCacheAt = 0;
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
      status: 'running',    // running | ok | failed
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
    this.scanTimer = setInterval(() => {
      this.scan();
      this.tick();
    }, SCAN_MS);
  }

  stop() {
    this.enabled = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  /** 定时器只做两件事：读当前文件增量（便宜）；偶尔全树找一下有没有换会话（贵） */
  scan() {
    if (!this.enabled) return;
    const now = Date.now();
    if (!this.file || now - this.fullScanAt > FULL_SCAN_MS) {
      this.fullScanAt = now;
      this.walk();
    }
    if (this.file) this.readNew();
  }

  /** 全树找最近被改过的 jsonl（跨所有项目）。目录列表缓存 30 秒，别每次都 readdir */
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
    let best = null;
    let bestMtime = 0;
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
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = { file: p, size: st.size };
        }
      }
    }
    if (best && best.file !== this.file) this.switchTo(best);
  }

  switchTo(best) {
    this.file = best.file;
    this.offset = this.offsets.get(best.file) || 0;
    this.buf = '';
    this.snap = this.blank();
    this.snap.sessionId = path.basename(best.file, '.jsonl');
    // 首次接入若文件很大，只看尾部，避免一次性灌几 MB
    if (this.offset === 0 && best.size > TAIL_ON_ATTACH) this.offset = best.size - TAIL_ON_ATTACH;
    this.priming = true;
    this.readNew();
    this.priming = false;
    this.emit('update', this.snap);
  }

  readNew() {
    if (!this.file) return;
    let fd;
    try {
      const st = fs.statSync(this.file);
      if (st.size <= this.offset) return;
      fd = fs.openSync(this.file, 'r');
      const len = Math.min(st.size - this.offset, TAIL_ON_ATTACH);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, this.offset);
      this.offset += len;
      this.offsets.set(this.file, this.offset);
      this.buf += b.toString('utf8');
    } catch {
      return;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }

    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        this.handleEvent(o);
      } catch {}
    }
  }

  handleEvent(o) {
    const t = o.type;
    const s = this.snap;
    // 行里自带真实时间，回放历史时不会假装"刚刚发生"
    const ts = Number(o.timestamp) || Date.now();

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
          this.finishTask('superseded', ts);
          this.beginTask(txt, ts);
        }
      } else if (o.role === 'assistant') {
        const txt = textOf(o.content);
        if (txt && s.task && s.task.status === 'running') {
          s.assistantText = txt;
          s.task.summary = txt;
          s.task.candidateAt = ts;
          if (!this.priming) this.emit('update', s);
        }
      }
      return;
    }

    // 只要又出现思考或工具调用，就说明刚才那段文字只是中间汇报
    if (t === 'reasoning') {
      if (s.task && s.task.status === 'running') s.task.candidateAt = 0;
      return;
    }

    if (t === 'function_call') {
      if (s.task && s.task.status === 'running') {
        s.task.candidateAt = 0;
        s.task.steps += 1;
        s.phase = 'running';
        if (!this.priming) this.emit('update', s);
      }
      return;
    }

    if (t === 'function_call_result') {
      const st = o.status || 'completed';
      if (st !== 'completed' && s.task && s.task.status === 'running') s.task.failures += 1;
      return;
    }
  }

  beginTask(txt, ts) {
    const s = this.snap;
    s.task = this.taskBlank(txt, ts);
    s.userText = s.task.userText;
    s.assistantText = '';
    s.phase = 'running';
    if (!this.priming) {
      this.emit('taskStart', s);
      this.emit('update', s);
    }
  }

  /** 收掉当前任务（正常交付 / 被新指令顶掉 / 超时放弃） */
  finishTask(reason, atTs) {
    const s = this.snap;
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
        : t.summary && FAIL_WORDS.test(t.summary)
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
    });
    if (s.history.length > HISTORY_MAX) s.history.length = HISTORY_MAX;

    if (!this.priming) {
      // 只有"正常交付"才值得播报；被新指令顶掉/超时的旧任务不必打扰主人
      if (reason === 'done') this.emit('taskDone', s);
      this.emit('update', s);
    }
  }

  /** 每轮扫描后检查：该收工了吗？是不是拖太久了？是不是卡住了？ */
  tick() {
    const s = this.snap;
    const t = s.task;
    if (!t || t.status !== 'running') return;
    const now = Date.now();
    const idle = now - (s.lastEventAt || now);
    const elapsed = now - t.startedAt;

    // 1) 交付判定：有候选最终答复 + 真静下来了
    if (t.candidateAt && idle > IDLE_MS) {
      this.finishTask('done');
      return;
    }

    // 2) 彻底没动静也没答复：当主人已经走开了，别一直挂着"正在进行"
    if (idle > ABANDON_MS) {
      this.finishTask('abandoned');
      return;
    }

    // 3) 卡住：一直在跑，但很久没有任何动静 —— 比"拖太久"更值得说，优先
    if (idle > STALL_MS) {
      if (!t.stallNoticed) {
        t.stallNoticed = true;
        if (!this.priming) this.emit('taskStall', { snap: s, idleMs: idle });
      }
      return;
    }

    // 4) 长任务（还在推进，只是慢）：第一次 6 分钟、第二次 20 分钟
    if (elapsed > LONG_MS && t.longNoticed === 0) {
      t.longNoticed = 1;
      if (!this.priming) this.emit('taskLong', { snap: s, elapsedMs: elapsed, round: 1 });
      return;
    }
    if (elapsed > LONG_MS2 && t.longNoticed === 1) {
      t.longNoticed = 2;
      if (!this.priming) this.emit('taskLong', { snap: s, elapsedMs: elapsed, round: 2 });
    }
  }

  /**
   * 给大脑看的「人话战况」。
   * 只讲：在做什么、多久了、到哪一步、最近做完的几件事和结果。
   * 不讲：命令、路径、工具名、单条报错 —— 主人不关心这些。
   * 标题必须明确区分「正在做」和「刚做完」，否则模型会把两件事混成一件。
   */
  context() {
    const s = this.snap;
    if (!s.sessionId) return '（暂时读不到 WorkBuddy 的任务信息）';
    const L = [];
    const t = s.task;
    const running = !!(t && t.status === 'running');

    if (running) {
      const mins = Math.round((Date.now() - t.startedAt) / 60000);
      L.push(`【现在正在做】${taskName(t)}`);
      L.push(`已经做了 ${dur(Date.now() - t.startedAt)}${mins >= 20 ? '（拖得有点久了）' : ''}，还没交付。`);
      // "步"这个数只给你自己判断轻重用 —— 千万别念给主人听。
      // 说过一次「你推进了六十三步」，像机器在报流水账，一点不像人。
      if (t.steps >= 8) L.push(`（心里有数就行：这活不小，内部推进了 ${t.steps} 次操作。别把这个数字说出口。）`);
      if (t.failures >= 3) L.push('过程里反复撞了几次墙，可能卡在某个绕不过去的地方。');
    } else {
      L.push('【现在】主人手上没有正在跑的事，WorkBuddy 是空的。');
    }

    if (t && t.endedAt) {
      const when = running ? '上一件做完的' : '刚做完的那件事';
      L.push(`【${when}】${taskName(t)} —— ${verdict(t.status)}，用了 ${dur(t.durationMs)}。`);
      if (t.summary) L.push(`结果：${plain(t.summary).slice(0, 160)}`);
    }

    const hist = s.history.filter((h) => h.id !== (t && t.id)).slice(0, 3);
    if (hist.length) {
      L.push('【再往前做的】');
      for (const h of hist) {
        const tail = h.summary ? `：${plain(h.summary).slice(0, 55)}` : '';
        L.push(`· ${taskName(h)}（${verdict(h.status)}，${dur(h.durationMs)}）${tail}`);
      }
    }

    L.push('（以上是你能看到的全部事实。问"做到哪了"就答正在做的那件；问"成了没 / 结果"就答刚做完那件。别编。）');
    return L.join('\n');
  }
}

module.exports = { Monitor, taskName, dur };
