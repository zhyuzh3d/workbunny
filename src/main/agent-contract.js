'use strict';
const { normalizeScene, rank } = require('./memory-scope');
const TASK_SCHEMA = 'bunny.task/v1';
const STATES = new Set(['ready','running','waiting','paused','needs_attention','completed','stopped','expired']);
const TERMINAL = new Set(['completed','stopped','expired']);
const text = (value, label, max = 3000, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label}不合法`);
  return value.trim();
};
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`${label}字段不合法`);
}
function clone(value) { return structuredClone(value); }
function taskSpec(value) {
  fields(value, ['skill','goal','criteria','subjects','policy','parameters','schedule','completion'], '任务');
  const skill = text(value.skill, '技能', 100);
  if (!/^[a-z][a-z0-9_.-]+$/u.test(skill)) throw new Error('技能标识不合法');
  if (!Array.isArray(value.subjects) || !value.subjects.length || value.subjects.length > 12) throw new Error('任务需要1到12个明确对象');
  const subjects = value.subjects.map(subject => {
    fields(subject, ['application','recipient'], '任务对象');
    const application = text(subject.application, '应用', 80);
    if (!/^[a-z][a-z0-9_.-]*$/u.test(application)) throw new Error('应用标识不合法');
    return { application, ...(subject.recipient === undefined ? {} : { recipient: text(subject.recipient, '联系人', 100) }) };
  });
  if (new Set(subjects.map(s => JSON.stringify(s))).size !== subjects.length) throw new Error('任务对象重复');
  const schedule = value.schedule ?? {};
  fields(schedule, ['intervalSeconds','activeIntervalSeconds','durationMinutes'], '任务周期');
  const intervalSeconds = schedule.intervalSeconds ?? 60, activeIntervalSeconds = schedule.activeIntervalSeconds ?? 10;
  for (const v of [intervalSeconds, activeIntervalSeconds]) if (!Number.isInteger(v) || v < 10 || v > 3600) throw new Error('观察间隔须为10到3600秒');
  if (schedule.durationMinutes !== undefined && (!Number.isInteger(schedule.durationMinutes) || schedule.durationMinutes < 1 || schedule.durationMinutes > 43200)) throw new Error('任务时长不合法');
  const completion = value.completion ?? 'manual';
  if (!['manual','first_match','goal'].includes(completion)) throw new Error('任务完成条件不合法');
  const parameters = value.parameters ?? {};
  if (!plain(parameters) || Buffer.byteLength(JSON.stringify(parameters)) > 32000) throw new Error('任务参数过大或不合法');
  return { skill, goal: text(value.goal,'任务目标',6000), criteria: text(value.criteria ?? value.goal,'验收条件',3000), subjects,
    policy: text(value.policy ?? '', '任务规则', 6000, true), parameters: clone(parameters), completion,
    schedule: { intervalSeconds, activeIntervalSeconds, ...(schedule.durationMinutes === undefined ? {} : { durationMinutes: schedule.durationMinutes }) } };
}
function authority(value, scene = 'life') {
  if (!plain(value) || value.role !== 'owner' || value.verified !== true || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 200 ||
      value.sources.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('任务缺少已核实的主人交办来源');
  scene = normalizeScene(scene);
  if (value.visibilityFloor !== undefined && (!Number.isInteger(value.visibilityFloor) || value.visibilityFloor < rank(scene) || value.visibilityFloor > 2)) throw new Error('交办资料范围不合法');
  return { role: 'owner', verified: true, channel: text(value.channel ?? 'dialogue','交办渠道',100),
    sources: [...new Set(value.sources)], scene, visibilityFloor: Math.max(rank(scene), value.visibilityFloor ?? rank(scene)),
    ...(Array.isArray(value.capabilities) ? { capabilities: [...new Set(value.capabilities.map(c => text(c,'能力',100)))] } : {}) };
}
module.exports = { TASK_SCHEMA, STATES, TERMINAL, taskSpec, authority, fields, plain, text, clone };
