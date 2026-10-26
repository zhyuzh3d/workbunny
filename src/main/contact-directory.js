'use strict';

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

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
    this.loaded = null;
    this.contacts = [];
  }

  async load() {
    if (!this.loaded) {
      this.loaded = Promise.resolve().then(() => this.read()).then(value => {
        const records = Array.isArray(value) ? value : (Array.isArray(value?.contacts) ? value.contacts : []);
        this.contacts = records.map(record => this.validateRecord(record));
      }).catch(error => { this.loaded = null; throw error; });
    }
    await this.loaded;
    return this.snapshot();
  }

  validateRecord(record) {
    const recipient = cleanName(record?.recipient ?? record?.canonical, 'recipient');
    const aliases = Array.isArray(record?.aliases) ? record.aliases.map(alias => cleanName(alias, 'alias')) : [];
    const unique = [...new Map([recipient, ...aliases].map(name => [normalizedName(name), name])).values()];
    return { recipient, aliases: unique.filter(name => normalizedName(name) !== normalizedName(recipient)),
      source: typeof record?.source === 'string' ? record.source.slice(0, 80) : 'user-confirmed' };
  }

  snapshot() {
    return this.contacts.map(contact => ({ ...contact, aliases: [...contact.aliases] }));
  }

  async resolve(spoken) {
    const input = cleanName(spoken, 'spoken recipient');
    await this.load();
    const key = normalizedName(input);
    const matches = this.contacts.filter(contact => [contact.recipient, ...contact.aliases].some(name => normalizedName(name) === key));
    const uniqueRecipients = [...new Set(matches.map(contact => normalizedName(contact.recipient)))];
    if (uniqueRecipients.length !== 1) {
      return { recipient: input, aliases: [input], confirmed: false,
        ...(uniqueRecipients.length > 1 ? { ambiguous: true, candidates: matches.map(item => item.recipient) } : {}) };
    }
    const match = matches.find(item => normalizedName(item.recipient) === uniqueRecipients[0]);
    return { recipient: match.recipient, aliases: [match.recipient, ...match.aliases], confirmed: true, source: match.source };
  }

  async remember(canonical, aliases = [], { source = 'user-confirmed' } = {}) {
    const recipient = cleanName(canonical, 'canonical recipient');
    if (!Array.isArray(aliases) || aliases.length > 20) throw new TypeError('aliases must contain at most 20 names');
    const names = [...new Map([recipient, ...aliases.map(alias => cleanName(alias, 'alias'))]
      .map(name => [normalizedName(name), name])).values()];
    if (typeof source !== 'string' || !source.trim() || source.length > 80) throw new TypeError('source must be 1–80 characters');
    await this.load();
    const nameKeys = new Set(names.map(normalizedName));
    for (const record of this.contacts) {
      if (normalizedName(record.recipient) !== normalizedName(recipient) &&
          [record.recipient, ...record.aliases].some(name => nameKeys.has(normalizedName(name)))) {
        throw new Error('联系人名称与已确认的其他联系人冲突');
      }
    }
    const existing = this.contacts.find(record => normalizedName(record.recipient) === normalizedName(recipient));
    const merged = [...new Map([...(existing?.aliases || []), ...names]
      .map(name => [normalizedName(name), name])).values()];
    const next = this.contacts.filter(record => normalizedName(record.recipient) !== normalizedName(recipient));
    next.push({ recipient, aliases: merged.filter(name => normalizedName(name) !== normalizedName(recipient)), source: source.trim() });
    const snapshot = next.map(contact => ({ ...contact, aliases: [...contact.aliases] }));
    await this.write({ contacts: snapshot });
    this.contacts = next;
    return this.resolve(recipient);
  }
}

function createContactDirectory(options) { return new ContactDirectory(options); }

module.exports = { ContactDirectory, createContactDirectory, normalizedName };
