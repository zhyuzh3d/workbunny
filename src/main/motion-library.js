'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const core = require('../shared/motion-core');
const assets = require('./asset-library');
const { containsSecret } = require('./conversation-input');
const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max) => String(value ?? '').trim().slice(0, max);
function validateMotion(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 28 || stat.size > 32 * 1024 ** 2) throw Error('请选择32MiB以内的独立VRMA文件');
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length || data.toString('ascii', 16, 20) !== 'JSON') throw Error('不是有效的VRMA文件');
  const size = data.readUInt32LE(12);
  if (size > data.length - 20 || size > 4 * 1024 ** 2) throw Error('VRMA描述过大或不完整');
  const doc = JSON.parse(data.subarray(20, 20 + size).toString());
  if (!doc.extensions?.VRMC_vrm_animation || !doc.animations?.length) throw Error('动作缺少VRM动画扩展或动画轨道');
  if ([...(doc.buffers || []), ...(doc.images || [])].some(b => b.uri && !b.uri.startsWith('data:'))) throw Error('动作不能依赖外部文件');
  return data;
}
class MotionLibrary {
  constructor({ motions, groups, getConfig, saveConfig, random = Math.random }) {
    this.base = motions.map(m => ({ ...m, idle: m.idle ?? m.slot === 'idle', builtin: !m.personal, weight: 1 }));
    this.groups = clone(groups); Object.assign(this, { getConfig, saveConfig, random });
  }
  catalog(config = this.getConfig()) {
    const library = config.motions?.library || {}, removed = new Set(library.removed || []);
    const categories = Array.isArray(library.categories) ? library.categories : this.groups;
    const groups = categories.filter(g => g && ID.test(g.id) && text(g.label, 40)).map(g => ({ id: g.id, label: text(g.label, 40), description: text(g.description, 240) }));
    const groupIds = new Set(groups.map(g => g.id)), disabled = config.motions?.disabled || [];
    const baseIds = new Set(this.base.map(m => m.key));
    const added = (library.items || []).filter(m => m && ID.test(m.key) && !baseIds.has(m.key) && m.file === m.key + '.vrma')
      .flatMap(m => { const file = assets.personalFile('motion', m.file); return file ? [{ ...m, builtin: false, personal: true, url: assets.url(file) }] : []; });
    const motions = [...this.base, ...added].filter(m => !removed.has(m.key)).map(m => {
      const override = library.overrides?.[m.key] || {};
      const slot = groupIds.has(override.slot) ? override.slot : groupIds.has(m.slot) ? m.slot : groups[0]?.id;
      return { ...m, posture: m.posture || 'standing', slot, label: text(override.label || m.label, 80), use: text(override.use ?? m.use, 300),
        loop: override.loop === undefined ? !!m.loop : !!override.loop, weight: 1,
        enabled: !disabled.includes(m.key), tag: 'llm', idle: override.idle === undefined ? !!m.idle : !!override.idle };
    });
    return { categories: groups, motions, revision: config.settingsRevision || 0 };
  }
  select(selector, { config = this.getConfig(), exact = false, loaded, posture = 'standing', allowPostureChange = false, manual = false, autonomous = false } = {}) {
    const view = this.catalog(config), allowed = m => m.enabled && (!loaded || loaded.has(m.key)) && (manual || !m.requiresProp) && (!autonomous || m.autonomous !== false) && (allowPostureChange || !m.postureChanging) && (allowPostureChange || (!m.transition && m.posture !== (posture === 'sitting' ? 'standing' : 'sitting')));
    const direct = view.motions.find(m => m.key === selector);
    if (direct) return allowed(direct) ? direct : null;
    if (exact) return null;
    const pool = view.motions.filter(m => m.slot === selector && allowed(m) && (manual || m.autonomous !== false));
    return core.choose(pool, this.random);
  }
  idle(config = this.getConfig()) { return core.choose(this.catalog(config).motions.filter(m => m.idle && m.enabled), this.random); }
  validate(config) {
    const lib = config.motions?.library || {}, view = this.catalog(config);
    if ((lib.items || []).length > 256 || (lib.categories || []).length > 64 || !view.categories.length) throw Error('动作库规模不正确（最多64个分类、256个个人动作）');
    if (view.categories.length !== new Set(view.categories.map(g => g.id)).size || (lib.categories && lib.categories.length !== view.categories.length)) throw Error('分类名称或标识不正确');
    if (!view.motions.some(m => m.idle && m.enabled)) throw Error('至少保留一个可随机使用的空闲动作');
    if ([...view.categories.flatMap(g => [g.label, g.description]), ...view.motions.flatMap(m => [m.label, m.use])].some(containsSecret)) throw Error('动作说明会提供给模型，请不要填写密码或密钥');
    for (const override of Object.values(lib.overrides || {})) {
      if (override.weight !== undefined && (!Number.isFinite(Number(override.weight)) || Number(override.weight) < 0 || Number(override.weight) > 100)) throw Error('随机权重应在0到100之间');
      if (override.slot !== undefined && !view.categories.some(g => g.id === override.slot)) throw Error('动作分类不存在');
    }
    return view;
  }
  save(change) {
    const current = this.getConfig(), library = clone(current.motions?.library || {});
    library.categories ||= clone(this.groups); library.items ||= []; library.overrides ||= {}; library.removed ||= [];
    if (change.expected) {
      const entity = change.type === 'category-update' ? this.catalog(current).categories.find(g => g.id === change.id) : this.catalog(current).motions.find(m => m.key === change.key);
      if (!entity || Object.entries(change.expected).some(([k,v]) => entity[k] !== v)) throw Error('内容刚被更新，请重新打开编辑');
    }
    if (change.type === 'category-add') {
      const id = 'group_' + crypto.randomUUID().replaceAll('-', '');
      library.categories.push({ id, label: text(change.label, 40), description: text(change.description, 240) });
    } else if (change.type === 'category-update') {
      const group = library.categories.find(g => g.id === change.id); if (!group) throw Error('分类不存在');
      group.label = text(change.label, 40); group.description = text(change.description, 240);
    } else if (change.type === 'category-delete') {
      if (library.categories.length < 2) throw Error('至少保留一个分类');
      const target = library.categories.find(g => g.id !== change.id && (!change.moveTo || g.id === change.moveTo));
      if (!target) throw Error('请选择接收动作的分类');
      for (const m of this.catalog(current).motions.filter(m => m.slot === change.id)) library.overrides[m.key] = { ...library.overrides[m.key], slot: target.id };
      library.categories = library.categories.filter(g => g.id !== change.id);
    } else if (change.type === 'motion-update') {
      if (!this.catalog(current).motions.some(m => m.key === change.key)) throw Error('动作不存在');
      const allowed = ['slot', 'label', 'use', 'loop', 'idle'];
      library.overrides[change.key] = { ...library.overrides[change.key], ...Object.fromEntries(allowed.filter(k => change[k] !== undefined).map(k => [k, change[k]])) };
    } else if (change.type === 'motion-delete') {
      if (!this.catalog(current).motions.some(m => m.key === change.key)) throw Error('动作不存在');
      if (library.items.some(m => m.key === change.key)) {
        library.items = library.items.filter(m => m.key !== change.key); delete library.overrides[change.key];
      } else library.removed = [...new Set([...library.removed, change.key])];
    } else if (change.type === 'restore-defaults') {
      const baseKeys = new Set(this.base.filter(m => m.builtin).map(m => m.key)), defaultGroups = new Set(this.groups.map(g => g.id));
      library.categories = [...clone(this.groups), ...library.categories.filter(g => !defaultGroups.has(g.id))];
      library.overrides = Object.fromEntries(Object.entries(library.overrides).filter(([key]) => !baseKeys.has(key)));
      library.removed = library.removed.filter(key => !baseKeys.has(key));
    } else throw Error('未知的动作库操作');
    const next = { ...current, motions: { ...current.motions, library } }; this.validate(next);
    this.saveConfig({ motions: { library } }); return this.catalog();
  }
  import(file, { slot, label, use = '', loop = false } = {}) {
    const current = this.getConfig();
    if (!this.catalog(current).categories.some(g => g.id === slot)) throw Error('请先选择动作分类');
    const data = validateMotion(file), digest = crypto.createHash('sha256').update(data).digest('hex'), key = 'user_' + digest.slice(0, 24);
    const dir = assets.directory('motion'); if (!dir) throw Error('个人动作目录未准备好');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink()) throw Error('个人动作目录不能是符号链接');
    const target = path.join(dir, key + '.vrma'), existed = fs.existsSync(target);
    if (existed && !assets.personalFile('motion', key + '.vrma')) throw Error('动作文件不是普通文件');
    if (existed && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== digest) throw Error('动作文件内容与标识不一致');
    const temporary = path.join(dir, '.' + crypto.randomUUID() + '.tmp');
    if (!existed) {
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.linkSync(temporary, target);
      }
      finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    }
    try {
      const library = clone(current.motions?.library || {}); library.items ||= []; library.removed = (library.removed || []).filter(k => k !== key);
      if (!library.items.some(m => m.key === key)) library.items.push({ key, file: key + '.vrma', slot, label: text(label || path.basename(file, path.extname(file)), 80), use: text(use, 300), loop: !!loop || slot === 'idle', idle: slot === 'idle', weight: 1 });
      this.validate({ ...current, motions: { ...current.motions, library } }); this.saveConfig({ motions: { library } });
      return { key, ...this.catalog() };
    } catch (error) { if (!existed) try { fs.unlinkSync(target); } catch {} throw error; }
  }
  prompt(query = '') {
    const view = this.catalog();
    // Offer matching concrete IDs without flooding every turn with the full library.
    const q = String(query).replace(/\s+/g, '');
    const score = m => {
      const description = (m.label + ' ' + m.use).replace(/\s+/g, '');
      let n = q.includes(m.label) || q.includes(m.key) ? 20 : 0;
      for (let i = 0; i + 1 < q.length; i++) if (description.includes(q.slice(i, i + 2))) n++;
      return n;
    };
    const selected = view.motions.filter(m => m.enabled && score(m) > 0).sort((a,b) => score(b) - score(a)).slice(0, 10);
    return view.categories.map(g => {
      const motions = view.motions.filter(m => m.slot === g.id && m.enabled);
      return motions.length ? { category: g.id, meaning: g.label, use: g.description.slice(0,60),
        actions: selected.filter(m => m.slot === g.id).map(m => ({ id: m.key, name: m.label, meaning: m.use.slice(0,80), posture: m.posture, requiresProp: m.requiresProp })) } : null;
    }).filter(Boolean);
  }
}
module.exports = { MotionLibrary, validateMotion };
