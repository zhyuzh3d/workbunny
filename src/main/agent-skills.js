'use strict';
const { clone } = require('./agent-contract');
class SkillRegistry {
  constructor(tools) { this.tools = tools; this.skills = new Map(); this.candidates = new Map(); }
  register(skill) {
    if (!skill || !/^[a-z][a-z0-9_.-]+$/u.test(skill.id) || !Number.isSafeInteger(skill.version) || skill.version < 1 ||
        typeof skill.run !== 'function' || (skill.activeAction!==undefined&&typeof skill.activeAction!=='function') || !skill.description || !Array.isArray(skill.tools) || !Array.isArray(skill.capabilities)) throw new Error('技能定义不合法');
    for (const name of skill.tools) this.tools.get(name);
    const prior = this.skills.get(skill.id);
    if (prior && skill.version <= prior.version) throw new Error('技能版本必须递增');
    this.skills.set(skill.id, Object.freeze({ ...skill, tools: Object.freeze([...skill.tools]), capabilities: Object.freeze([...skill.capabilities]) }));
    return this;
  }
  get(id) { const skill = this.skills.get(id); if (!skill) throw new Error('尚未安装技能：' + id); return skill; }
  catalog() { return [...this.skills.values()].filter(s=>!s.internal).map(({ id, title, version, description, capabilities, parameters,subjectApplications }) => ({ id, title:title||id, version, description, capabilities, parameters: parameters || {},...(subjectApplications?{subjectApplications}: {}) })); }
  stage({ id, instructions, source, evidence = [] }) {
    const current = this.get(id);
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 12000 || !source) throw new Error('技能经验缺少内容或来源');
    // Candidate knowledge has no executable code and cannot change tool grants.
    const candidate = { id, baseVersion: current.version, instructions, source, evidence: clone(evidence), status: 'candidate' };
    this.candidates.set(id, candidate); return clone(candidate);
  }
  promote(id, { passed, checks, source }) {
    const candidate = this.candidates.get(id), current = this.get(id);
    if (!candidate || candidate.baseVersion !== current.version || passed !== true || !Array.isArray(checks) || !checks.length || !source) throw new Error('技能更新尚未验证');
    this.register({ ...current, version: current.version + 1, instructions: candidate.instructions,
      verification: { checks: clone(checks), source } });
    this.candidates.delete(id); return this.get(id).version;
  }
}
module.exports = { SkillRegistry };
