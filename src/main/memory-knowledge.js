'use strict';

// Relations are navigation, doubts are questions, and reviewed facts are explicit
// user decisions. None of these are allowed to rewrite the common persona.
const crypto = require('node:crypto');
const { rank } = require('./memory-scope');
const { ORIGINS, marker, typeOf, LABELS } = require('./knowledge-records');
const { readRecords, verifySnapshots, evidenceFor, snapshotsOf } = require('./memory-evidence');
const { containsSecret } = require('./conversation-input');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const pairKey = row => hash(JSON.stringify([row.domain, row.visibilityFloor, [...row.value.memberIds].sort()]));
const questionId = row => 'memory-doubt:v1:' + pairKey(row);
const decisionId = (id, floor) => `doubt-resolution:v1:${hash(id)}:${floor}`;
const replacementMarker = id => 'bunny_replaces_' + hash(id).slice(0, 24);
const correctionMarker = id => 'bunny_corrects_' + hash(id).slice(0, 24);
const STOP = /^(?:你好|您好|谢谢|好的|嗯|好|在吗|hello|hi|ok)[！!。，,.？?\s]*$/iu;
const relationLabels = { equivalent: '同义陈述', update: '随时间变化', contextual: '不同条件', contradiction: '可能矛盾', uncertain: '需要核对' };

function createMemoryKnowledge({ memory, clock = Date.now } = {}) {
  if (!memory?.serial || !memory?.query) throw new TypeError('MemoryKnowledge requires MemoryService');

  const consolidation = require('./memory-consolidation').createMemoryConsolidation({ memory, clock });

  async function validRelation(row, scene) {
    if (typeOf(row) !== 'relation' || row.state !== 'active' || row.value.status !== 'proposed' || !Array.isArray(row.value.memberIds) ||
        row.value.memberIds.length < 2 || row.value.memberIds.length > 6 ||
        !Array.isArray(row.value.analysisSnapshots) || row.value.analysisSnapshots.length > 32) return null;
    const verified = await verifySnapshots(memory, row.value.analysisSnapshots, { scene });
    if (!verified.ok) return null;
    const members = [];
    for (const id of row.value.memberIds) {
      const member = verified.rows.find(item => item.id === id);
      if (!member || member.domain !== row.domain || member.visibilityFloor !== row.visibilityFloor || member.state !== 'active' ||
          !['pending', 'confirmed'].includes(member.value.status) || member.expiresAt && member.expiresAt <= clock()) return null;
      const evidence = await evidenceFor(memory, member, { scene });
      if (!evidence) return null;
      members.push({ ...member, evidence });
    }
    return { row, members };
  }

  async function validQuestion(row, scene) {
    if (typeOf(row) !== 'doubt' || !Array.isArray(row.value.memberIds)) return null;
    const relation = (await readRecords(memory, [row.value.relationId], { scene }))[0];
    const checked = relation && await validRelation(relation, scene);
    if (!checked || questionId(relation) !== row.id || row.value.claimSignature !== claimSignature(checked.members)) return null;
    return checked;
  }

  function claimSignature(members) {
    // Kept inside the encrypted body; status/tag changes do not revive a resolved question.
    return hash(JSON.stringify(members.map(row => [row.id, row.value.content, row.value.key || '',
      row.evidence.sourceId, row.evidence.quote]).sort((a, b) => a[0].localeCompare(b[0]))));
  }

  async function decisionFor(question, scene) {
    const ids = [];
    for (let floor = question.visibilityFloor; floor <= rank(scene); floor++) ids.push(decisionId(question.id, floor));
    const rows = await readRecords(memory, ids, { scene });
    return rows.filter(row => typeOf(row) === 'decision' && row.value.claimSignature === question.value.claimSignature)
      .sort((a, b) => b.visibilityFloor - a.visibilityFloor || b.ts - a.ts)[0] || null;
  }

  async function projectQuestion(row, scene) {
    const checked = await validQuestion(row, scene);
    if (!checked) return null;
    const decision = await decisionFor(row, scene);
    const active = decision?.value.action;
    const status = active === 'snooze' ? (decision.value.until > clock() ? 'snoozed' : 'open') :
      ['choose', 'both'].includes(active) ? 'resolved' : active === 'dismiss' ? 'dismissed' : 'open';
    return { checked, decision, status };
  }

  async function sync({ signal, canRun = () => true } = {}) {
    // A durable cursor bounds work even for a vault with years of relations.
    return memory.serial(async () => {
      if (signal?.aborted || !await canRun()) return { status: 'paused', created: 0, more: true };
      const checkpointId = 'knowledge:organize-cursor:v2';
      const checkpoint = (await readRecords(memory, [checkpointId]))[0];
      const rows = (await memory.query('state', 40, { scene: null, sort: 'ingestion', order: 'asc',
        afterSeq: checkpoint?.value.afterSeq || 0, requiredMarkers: [marker('relation')] }));
      let created = 0;
      for (const row of rows) {
        if (signal?.aborted || !await canRun()) return { status: 'paused', created, more: true };
        if (row.value.relation === 'equivalent') {
          const equivalent = await validRelation(row, ['work', 'life', 'private'][row.visibilityFloor]);
          if (equivalent) await consolidation.link(row, equivalent.members);
          continue;
        }
        if (!['contradiction', 'uncertain'].includes(row.value.relation)) continue;
        const scene = ['work', 'life', 'private'][row.visibilityFloor];
        const checked = await validRelation(row, scene);
        if (!checked) continue;
        const id = questionId(row), signature = claimSignature(checked.members);
        const previous = (await readRecords(memory, [id]))[0];
        if (previous?.value.claimSignature === signature && await validQuestion(previous, scene)) continue;
        const now = clock();
        await memory.write([{ id, kind: 'state', ts: now, updatedAt: now, domain: row.domain, visibilityFloor: row.visibilityFloor,
          value: { origin: ORIGINS.doubt, status: 'open', relationId: row.id, relation: row.value.relation,
            memberIds: row.value.memberIds, claimSignature: signature,
            content: checked.members.map(item => item.value.content).join(' / '),
            sources: [row.id, ...row.value.sources], tags: [...new Set(checked.members.flatMap(item => item.value.tags || []))].slice(0, 8) } }], memory.epoch);
        created++;
      }
      if (rows.length) await memory.write([{ id: checkpointId, kind: 'state', ts: 0, updatedAt: clock(), domain: 'private', visibilityFloor: 2,
        value: { afterSeq: rows.at(-1).ingestionSeq, sources: [] } }], memory.epoch, { notify: false });
      return { status: 'done', created, more: rows.length === 40 };
    });
  }

  async function resolve(id, { action, choiceId, note = '', scene = memory.scene() } = {}) {
    if (!['choose', 'both', 'snooze', 'dismiss'].includes(action)) throw new Error('请选择有效的核对方式');
    if (typeof note !== 'string' || note.length > 600 || containsSecret(note)) throw new Error('补充说明限600字，不保存密钥或密码');
    if (action === 'both' && note.trim().length < 3) throw new Error('请补充两种情况各自适用的条件（至少3字）');
    const generation = memory.generation, sceneEpoch = memory.sceneEpoch;
    return memory.serial(async () => {
      if (generation !== memory.generation || sceneEpoch !== memory.sceneEpoch || scene !== memory.scene()) throw new Error('场景已变化，请重新打开这条记录');
      const question = (await readRecords(memory, [id], { scene }))[0];
      const checked = question && await validQuestion(question, scene);
      if (!checked) throw new Error('来源已变化，这条问题已失效，请重新整理');
      const member = checked.members.find(row => row.id === choiceId);
      if (action === 'choose' && !member) throw new Error('请选择这条问题中的有效说法');
      const floor = Math.max(question.visibilityFloor, rank(scene));
      const did = decisionId(id, floor), previous = (await readRecords(memory, [did], { scene }))[0];
      const visiblePrevious = await decisionFor(question, scene);
      if (previous?.value.claimSignature === question.value.claimSignature && previous.value.action === action &&
          previous.value.choiceId === (choiceId || null) && previous.value.note === note.trim() &&
          (action !== 'snooze' || previous.value.until > clock())) return { ok: true, duplicate: true };
      const now = clock(), reviewId = crypto.randomUUID();
      const reviewText = action === 'choose' ? `我核对后采用这条说法：${member.value.content}` :
        action === 'both' ? `这些说法各有适用条件：${checked.members.map(row => row.value.content).join('；')}。适用条件：${note.trim()}` : action === 'snooze' ? '这条待核对问题以后再讨论。' : '这条待核对问题不再提醒。';
      // A panel decision is a new explicit user event, scoped to the active scene.
      await memory.write([{ id: reviewId, kind: 'message', ts: now, domain: question.domain, visibilityFloor: floor,
        value: { role: 'user', source: 'user-reviewed', content: reviewText, sources: [] } }], memory.epoch, { notify: false });
      const records = [], sources = [reviewId];
      let factId = null;
      if (member) sources.push(member.evidence.sourceId);
      const previousFact = visiblePrevious?.value.factId ? (await readRecords(memory, [visiblePrevious.value.factId], { scene }))[0] : null;
      const supersededMembers = [...checked.members, ...(previousFact ? [previousFact] : [])];
      const supersedesSnapshots = snapshotsOf([...supersededMembers, ...checked.members.map(row => row.evidence.source)]);
      if (action === 'choose') {
        factId = crypto.randomUUID();
        records.push({ id: factId, kind: 'memory', ts: now, domain: question.domain, visibilityFloor: floor,
          value: { content: member.value.content, memoryKind: member.value.memoryKind === 'candidate' ? 'fact' : member.value.memoryKind || 'fact',
            ...(member.value.key ? { key: member.value.key } : {}),
            ...(typeof member.value.canonicalValue === 'string' ? { canonicalValue: member.value.canonicalValue } : {}),
            ...(member.value.anniversary ? { anniversary: member.value.anniversary } : {}),
            ...(member.value.pinned ? { pinned: member.value.pinned } : {}),
            status: 'confirmed', origin: 'user-reviewed-doubt', evidence: member.evidence.quote,
            evidenceSourceId: member.evidence.sourceId, sources: [...sources],
            tags: member.value.tags || [], resolvedAt: now, resolvedFrom: question.value.memberIds,
            supersedes: supersededMembers.map(item => item.id), supersedesSnapshots, importance: member.value.importance || 0.7 } });
      } else if (action === 'both') {
        factId = crypto.randomUUID();
        records.push({ id: factId, kind: 'memory', ts: now, domain: question.domain, visibilityFloor: floor,
          value: { content: reviewText, memoryKind: 'fact', status: 'confirmed', origin: 'user-reviewed-doubt',
            evidence: note.trim(), evidenceSourceId: reviewId,
            sources: [...new Set([reviewId, ...checked.members.map(row => row.evidence.sourceId)])],
            resolvedAt: now, resolvedFrom: question.value.memberIds, supersedes: supersededMembers.map(item => item.id),
            supersedesSnapshots, importance: 0.7 } });
      }
      records.push({ id: did, kind: 'state', ts: now, updatedAt: now, domain: question.domain, visibilityFloor: floor,
        value: { origin: ORIGINS.decision, questionId: id, claimSignature: question.value.claimSignature,
          action, choiceId: choiceId || null, factId, note: note.trim(), until: action === 'snooze' ? now + 7 * 86400000 : null,
          content: reviewText, sources } });
      if (generation !== memory.generation || sceneEpoch !== memory.sceneEpoch) throw new Error('场景已变化，本次核对没有提交');
      await memory.write(records, memory.epoch);
      return { ok: true, factId };
    });
  }

  async function applyResolutions(rows, { scene = memory.scene() } = {}) {
    if (!rows.length) return { rows, facts: [], suppressed: [] };
    const ids = new Set(rows.map(row => row.id));
    const evidenceIds = [...new Set(rows.flatMap(r => r.kind === 'message' ? [r.id, ...(r.value.sources || [])] : [r.value.evidenceSourceId]).filter(Boolean))];
    const replacements = await memory.search([...ids].slice(0, 48).map(replacementMarker).concat(evidenceIds.slice(0, 48).map(correctionMarker)).join(' '), ['memory'], 50, { scene });
    const valid = replacements.filter(row => row.state === 'active' && row.value.status === 'confirmed' &&
      ['user-reviewed-doubt', 'user-reviewed'].includes(row.value.origin) && Array.isArray(row.value.supersedes) &&
      (row.value.supersedes.some(id => ids.has(id)) || row.value.supersedesClaims?.some(c => evidenceIds.includes(c.sourceId))));
    const facts = [];
    for (const row of valid) if (await evidenceFor(memory, row, { scene })) facts.push(row);
    const currentIds = new Set([...rows, ...facts].map(row => row.id));
    // A review suppresses only the exact versions the user compared. A later
    // correction under the same ID is new evidence and must remain visible.
    const suppressed = new Set();
    for (const row of facts) {
      if (row.value.origin === 'user-reviewed') {
        for (const old of rows) if (old.id !== row.id && (row.value.supersedes.includes(old.id) || row.value.supersedesClaims?.some(c =>
          c.sourceId === old.value.evidenceSourceId && typeof old.value.evidence === 'string' && (old.value.evidence.includes(c.quote) || c.quote.includes(old.value.evidence))))) suppressed.add(old.id);
        continue;
      }
      if (!Array.isArray(row.value.supersedesSnapshots) || !(await verifySnapshots(memory, row.value.supersedesSnapshots, { scene })).ok) continue;
      // verifySnapshots reads authoritative stored rows. Display projections may
      // intentionally add explanatory text and must not be used as fingerprints.
      for (const item of row.value.supersedesSnapshots) if (row.value.supersedes.includes(item.id) && currentIds.has(item.id)) suppressed.add(item.id);
    }
    return { rows: rows.filter(row => !suppressed.has(row.id)), facts: facts.filter(row => !suppressed.has(row.id)), suppressed: [...suppressed] };
  }

  async function list({ category = 'all', query = '', before, beforeId, scene = memory.scene() } = {}) {
    if (!['all', 'relation', 'doubt', 'experience', 'tool'].includes(category)) throw new Error('未知的资料类别');
    const requiredMarkers = [marker(category)];
    const options = { scene, before, beforeId, requiredMarkers, ...(category === 'all' ? { excludedMarkers: [marker('decision')] } : {}) };
    const rows = query ? await memory.search(query, ['state'], 50, options) : await memory.query('state', 50, options);
    const result = [];
    for (const row of rows) {
      const type = typeOf(row);
      if (!type || type === 'decision') continue;
      let status = row.value.status, choices = [];
      if (type === 'relation') {
        const checked = await validRelation(row, scene);
        if (!checked) continue;
        choices = checked.members.map(item => ({ id: item.id, content: item.value.content, evidence: item.evidence.quote }));
      } else if (type === 'doubt') {
        const projection = await projectQuestion(row, scene);
        if (!projection) continue;
        status = projection.status;
        choices = projection.checked.members.map(item => ({ id: item.id, content: item.value.content, evidence: item.evidence.quote }));
      } else {
        // Validate task receipts on read; merely finding an index is not proof.
        if (!await memory.experiences?.validateRecord(row, { scene })) continue;
      }
      result.push({ id: row.id, kind: row.kind, ts: row.ts, domain: row.domain, visibilityFloor: row.visibilityFloor,
        knowledgeType: type, label: type === 'relation' ? relationLabels[row.value.relation] : LABELS[type], status,
        tags: require('./memory-tags').tagged(row.value).tags,
        content: String(row.value.content || '').replace(/^bunny_knowledge_\w+\s*/u, ''),
        memberChoices: choices, sources: row.value.sources || [],
        ...(type === 'tool' ? { artifact: row.value.artifact, snapshotAvailable: typeof row.value.code === 'string', fileStatus: 'unknown' } : {}) });
    }
    const last = rows.at(-1);
    return { rows: result, next: last ? { ts: last.ts, id: last.id } : null, hasMore: !query && rows.length === 50 };
  }

  async function context(text, { scene = memory.scene(), budget = 1000 } = {}) {
    const empty = { text: '', sourceIds: [], suppressedIds: [] };
    if (!String(text || '').trim() || STOP.test(text)) return empty;
    // No marker is included in the text query: an unrelated question must not
    // match every indexed item just because it shares the type marker.
    const candidates = (await Promise.all(['doubt', 'relation'].map(type =>
      memory.search(text, ['state'], 6, { scene, requiredMarkers: [marker(type)] })))).flat()
      .sort((a, b) => (b.score || 0) - (a.score || 0) || b.ts - a.ts);
    const lines = [], sourceIds = [], suppressedIds = [], seenQuestions = new Set();
    let left = Math.max(0, Math.min(1600, budget)), activeQuestions = 0;
    for (const row of candidates) {
      let line = '';
      if (typeOf(row) === 'doubt') {
        const projection = await projectQuestion(row, scene);
        if (!projection || seenQuestions.has(row.id)) continue;
        seenQuestions.add(row.id);
        // An unresolved or deferred pair cannot sneak back in as two independent
        // confirmed facts through the ordinary-memory lane. Original history is
        // retained; only this exact, still-valid pair loses current-fact status.
        suppressedIds.push(...row.value.memberIds);
        sourceIds.push(row.id);
        if (projection.decision) sourceIds.push(projection.decision.id);
        if (projection.status === 'resolved') {
          if (projection.decision.value.action === 'both') line = '用户已说明适用条件：' + projection.decision.value.note;
          else {
            const fact = (await readRecords(memory, [projection.decision.value.factId], { scene }))[0];
            if (fact && await evidenceFor(memory, fact, { scene })) {
              line = '用户已核对的当前说法：' + fact.value.content;
              suppressedIds.push(...row.value.memberIds); sourceIds.push(fact.id);
            }
          }
          sourceIds.push(projection.decision.id);
        } else if (projection.status === 'open' && activeQuestions < 2) {
          line = '只在本轮确实相关时简短核对，不擅自选一项：' + projection.checked.members.map(item => JSON.stringify(item.value.content)).join(' / ');
          activeQuestions++;
        }
      } else if (typeOf(row) === 'relation') {
        const checked = await validRelation(row, scene);
        if (!checked) continue;
        // An acknowledged question must not reappear through its relation card.
        if (['contradiction', 'uncertain'].includes(row.value.relation)) continue;
        line = `${relationLabels[row.value.relation]}（索引，不改变原记录的确认状态）：` + checked.members.map(item => item.value.content).join(' / ');
      }
      if (!line || containsSecret(line) || line.length + 1 > left) continue;
      lines.push(line); left -= line.length + 1; sourceIds.push(row.id);
    }
    return { text: lines.join('\n'), sourceIds: [...new Set(sourceIds)], suppressedIds: [...new Set(suppressedIds)] };
  }

  async function backfillExperiences({ signal, canRun = () => true } = {}) {
    const checkpointId = 'knowledge:experience-cursor:v1';
    await memory.tail;
    const checkpoint = (await readRecords(memory, [checkpointId]))[0];
    const rows = await memory.query('task', 30, { scene: null, sort: 'ingestion', order: 'asc', afterSeq: checkpoint?.value.afterSeq || 0 });
    let processed = 0;
    for (const row of rows) {
      if (signal?.aborted || !await canRun()) return { status: 'paused', more: true, processed };
      if (row.value.status === 'accepted' && row.value.verification?.verdict === 'pass') await memory.experiences?.recordAcceptedTask(row.id, { epoch: memory.generation });
      await memory.serial(() => memory.write([{ id: checkpointId, kind: 'state', ts: 0, updatedAt: clock(), domain: 'private', visibilityFloor: 2,
        value: { afterSeq: row.ingestionSeq, sources: [] } }], memory.epoch, { notify: false }));
      processed++;
    }
    return { status: 'done', more: rows.length === 30, processed };
  }

  async function projectMemories(rows, options) {
    const result = await applyResolutions(await consolidation.project(rows, options), options);
    return [...new Map([...result.facts, ...result.rows].filter(r => !result.suppressed.includes(r.id)).map(r => [r.id, r])).values()];
  }
  return { projectMemories, sync, resolve, list, context, applyResolutions, backfillExperiences, validRelation, projectQuestion };
}

module.exports = { createMemoryKnowledge, replacementMarker, correctionMarker };
