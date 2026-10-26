'use strict';
const { normalizeScene, scopeOf, canRead, withSources } = require('./memory-scope');

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function canReadContact(scene, record) { try { return canRead(normalizeScene(scene), record); } catch { return false; } }

function cleanName(value, label) {
  if (typeof value !== 'string') throw new TypeError(label + ' must be text');
  const name = value.trim();
  if (!name || [...name].length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) throw new TypeError(label + ' must be 1–100 visible characters');
  return name;
}

class ContactDirectory {
  constructor({ read = async () => [], write = async () => {} } = {}) {
    if (typeof read !== 'function' || typeof write !== 'function') throw new TypeError('read and write must be functions');
    this.read = read;
    this.write = write;
    this.loaded = new Map();
    this.contacts = new Map();
    this.generation = 0;
  }

  invalidate() {
    this.generation++;
    this.loaded.clear();
    this.contacts.clear();
    return this.generation;
  }

  assertGeneration(generation) {
    if (generation !== this.generation) throw new Error('联系人资料已失效，请重试');
  }

  async load(scene = 'life') {
    scene = normalizeScene(scene);
    const generation = this.generation;
    if (!this.loaded.has(scene)) {
      let loading;
      loading = Promise.resolve().then(() => this.read({ scene })).then(value => {
        this.assertGeneration(generation);
        if (this.loaded.get(scene) !== loading) throw new Error('联系人资料已失效，请重试');
        const records = Array.isArray(value) ? value : (Array.isArray(value?.contacts) ? value.contacts : []);
        this.contacts.set(scene, records.map(record => this.validateRecord(record)).filter(record => canReadContact(scene, record)));
      }).catch(error => {
        // An older read must not erase a newer generation's replacement load.
        if (this.generation === generation && this.loaded.get(scene) === loading) this.loaded.delete(scene);
        throw error;
      });
      this.loaded.set(scene, loading);
    }
    const loading = this.loaded.get(scene);
    await loading;
    this.assertGeneration(generation);
    if (this.loaded.get(scene) !== loading) throw new Error('联系人资料已失效，请重试');
    return this.snapshot(scene);
  }

  validateRecord(record) {
    const recipient = cleanName(record?.recipient ?? record?.canonical, 'recipient');
    const aliases = Array.isArray(record?.aliases) ? record.aliases.map(alias => cleanName(alias, 'alias')) : [];
    const unique = [...new Map([recipient, ...aliases].map(name => [normalizedName(name), name])).values()];
    const scene = normalizeScene(record?.scene, 'private');
    const domain = typeof record?.domain === 'string' ? record.domain : scene;
    let scope;
    try { scope = scopeOf({ ...record, domain, visibilityFloor: record?.visibilityFloor }, 'private'); }
    catch { scope = scopeOf({}, 'private'); }
    const floor = scope.visibilityFloor;
    return { recipient, aliases: unique.filter(name => normalizedName(name) !== normalizedName(recipient)),
      source: typeof record?.source === 'string' ? record.source.slice(0, 80) : 'user-confirmed',
      ...(typeof record?.id === 'string' ? { id: record.id } : {}),
      sources: Array.isArray(record?.sources) ? [...new Set(record.sources.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, 200) : [],
      scene, domain, visibilityFloor: floor };
  }

  snapshot(scene = 'life') {
    scene = normalizeScene(scene);
    return (this.contacts.get(scene) || []).map(contact => ({ ...contact, aliases: [...contact.aliases] }));
  }

  async resolve(spoken, { scene = 'life' } = {}) {
    scene = normalizeScene(scene);
    const generation = this.generation;
    const input = cleanName(spoken, 'spoken recipient');
    await this.load(scene);
    this.assertGeneration(generation);
    const key = normalizedName(input);
    const records = this.snapshot(scene);
    const matches = records.filter(contact => [contact.recipient, ...contact.aliases].some(name => normalizedName(name) === key));
    const uniqueRecipients = [...new Set(matches.map(contact => normalizedName(contact.recipient)))];
    if (uniqueRecipients.length !== 1) {
      return { recipient: input, aliases: [input], confirmed: false,
        ...(uniqueRecipients.length > 1 ? { ambiguous: true, candidates: matches.map(item => item.recipient) } : {}) };
    }
    const canonicalMatches = records.filter(item => normalizedName(item.recipient) === uniqueRecipients[0]);
    const match = canonicalMatches[0];
    const aliases = [...new Map(canonicalMatches.flatMap(item => [item.recipient, ...item.aliases])
      .map(name => [normalizedName(name), name])).values()];
    return { recipient: match.recipient, aliases, confirmed: true, source: match.source };
  }

  async remember(canonical, aliases = [], { source = 'user-confirmed', scene = 'life', visibilityFloor, sources = [] } = {}) {
    scene = normalizeScene(scene);
    const generation = this.generation;
    if (!Array.isArray(sources) || sources.length > 200 || sources.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new TypeError('sources must contain at most 200 valid IDs');
    const floor = withSources(scene, [], visibilityFloor).visibilityFloor;
    const recipient = cleanName(canonical, 'canonical recipient');
    if (!Array.isArray(aliases) || aliases.length > 20) throw new TypeError('aliases must contain at most 20 names');
    const names = [...new Map([recipient, ...aliases.map(alias => cleanName(alias, 'alias'))]
      .map(name => [normalizedName(name), name])).values()];
    if (typeof source !== 'string' || !source.trim() || source.length > 80) throw new TypeError('source must be 1–80 characters');
    await this.load(scene);
    this.assertGeneration(generation);
    const contacts = this.snapshot(scene);
    const nameKeys = new Set(names.map(normalizedName));
    for (const record of contacts) {
      if (normalizedName(record.recipient) !== normalizedName(recipient) &&
          [record.recipient, ...record.aliases].some(name => nameKeys.has(normalizedName(name)))) {
        throw new Error('联系人名称与已确认的其他联系人冲突');
      }
    }
    const existing = contacts.filter(record => normalizedName(record.recipient) === normalizedName(recipient));
    const merged = [...new Map([...existing.flatMap(record => record.aliases), ...names]
      .map(name => [normalizedName(name), name])).values()];
    const next = contacts.filter(record => normalizedName(record.recipient) !== normalizedName(recipient));
    const priorFloor = Math.max(0, ...existing.map(record => record.visibilityFloor));
    const priorSources = existing.flatMap(record => record.sources || []);
    const resultFloor = Math.max(floor, priorFloor);
    const sameScope = existing.find(record => record.scene === scene && record.domain === scene && record.visibilityFloor === resultFloor);
    next.push({ ...(sameScope?.id ? { id: sameScope.id } : {}), recipient,
      aliases: merged.filter(name => normalizedName(name) !== normalizedName(recipient)), source: source.trim(),
      sources: [...new Set([...priorSources, ...sources])].slice(0, 200),
      scene, domain: scene, visibilityFloor: resultFloor });
    const persisted = next.map(contact => ({ ...contact, aliases: [...contact.aliases] }));
    // The persistence adapter must replace/merge only this scene partition.
    await this.write({ scene, contacts: persisted.filter(contact => contact.scene === scene) });
    this.assertGeneration(generation);
    this.contacts.set(scene, next.filter(contact => canReadContact(scene, contact)));
    return this.resolve(recipient, { scene });
  }
}

function createContactDirectory(options) { return new ContactDirectory(options); }

module.exports = { ContactDirectory, createContactDirectory, normalizedName, normalizeScene, canReadContact };
