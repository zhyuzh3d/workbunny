'use strict';
const { fields, clone } = require('./agent-contract');
class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(definition) {
    const { name, description, effect, capabilities, execute, validate = value => value, scope,inputSchema,lifecycle,available } = definition;
    if (!/^[a-z][a-z0-9_.]+$/u.test(name) || !description || !['read','write'].includes(effect) || !Array.isArray(capabilities) || typeof execute !== 'function' || this.tools.has(name)) throw new Error('工具定义不合法或重复');
    this.tools.set(name, Object.freeze({ name, description, effect, capabilities: Object.freeze([...capabilities]), execute, validate, scope,inputSchema,lifecycle,available }));
    return this;
  }
  get(name) { const tool = this.tools.get(name); if (!tool) throw new Error('未注册的工具：' + name); return tool; }
  catalog(names = [...this.tools.keys()],task) {
    return names.flatMap(name => { const { name: id, description, effect, capabilities,inputSchema,available } = this.get(name);
      if(task&&capabilities.some(c=>!task.capabilities.includes(c)))return [];
      if(task&&available&&!available(task))return [];
      const schema=inputSchema?clone(inputSchema):null,application=schema?.properties?.application;
      if(task&&application){const allowed=[...new Set(task.subjects.map(s=>s.application))].filter(a=>application.const?a===application.const:application.enum?application.enum.includes(a):true);if(!allowed.length)return [];if(!application.const)application.enum=allowed;}
      return [{name:id,description,effect,capabilities,...(schema?{inputSchema:schema}:{})}];
    });
  }
  check(name, args, task) {
    const tool = this.get(name);
    if(require('./owner-security').contains(JSON.stringify(args)))throw Object.assign(Error('Identity credential cannot be passed to tools'),{code:'E_IDENTITY_OUTPUT',dispatched:false});
    if(task.state?.sensitiveContext&&(name==='terminal.execute'||name==='screen.action'&&['wechat','workbuddy'].includes(args?.application)))throw Object.assign(Error('本任务已读取敏感信息，请使用受控的工作委派或会话交付通道'),{dispatched:false,code:'E_SENSITIVE_ROUTE'});
    // Skill lists describe familiar methods, not authority. The task's actual
    // capabilities, the validated target, and the host authorization check
    // remain mandatory for every call.
    if (tool.capabilities.some(c => !task.capabilities.includes(c)) || tool.available && !tool.available(task)) throw new Error('任务未授权此工具：' + name);
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
