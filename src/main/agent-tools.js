'use strict';
const { fields, clone } = require('./agent-contract');
class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(definition) {
    const { name, description, effect, capabilities, execute, validate = value => value, scope } = definition;
    if (!/^[a-z][a-z0-9_.]+$/u.test(name) || !description || !['read','write'].includes(effect) || !Array.isArray(capabilities) || typeof execute !== 'function' || this.tools.has(name)) throw new Error('工具定义不合法或重复');
    this.tools.set(name, Object.freeze({ name, description, effect, capabilities: Object.freeze([...capabilities]), execute, validate, scope }));
    return this;
  }
  get(name) { const tool = this.tools.get(name); if (!tool) throw new Error('未注册的工具：' + name); return tool; }
  catalog(names = [...this.tools.keys()]) { return names.map(name => { const { name: id, description, effect, capabilities } = this.get(name); return { name: id, description, effect, capabilities }; }); }
  check(name, args, task, skill) {
    const tool = this.get(name);
    if (!skill.tools.includes(name) || tool.capabilities.some(c => !task.capabilities.includes(c))) throw new Error('任务未授权此工具：' + name);
    const input = tool.validate(clone(args ?? {}));
    const target = tool.scope?.(input);
    if (target && !task.subjects.some(s => s.application === target.application && (!target.recipient || s.recipient === target.recipient))) throw new Error('工具对象不属于主人交办范围');
    return { tool, input };
  }
}
function scriptPlan(value, registry, task, skill) {
  fields(value, ['steps'], '脚本');
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 20) throw new Error('脚本须包含1到20步');
  const keys = new Set();
  return value.steps.map(step => {
    fields(step, ['tool','args','key'], '脚本步骤');
    if (typeof step.key !== 'string' || !step.key || step.key.length > 160 || keys.has(step.key) || step.tool === 'script.run') throw new Error('脚本步骤标识不合法');
    keys.add(step.key); registry.check(step.tool, step.args, task, skill);
    return clone(step);
  });
}
module.exports = { ToolRegistry, scriptPlan };
