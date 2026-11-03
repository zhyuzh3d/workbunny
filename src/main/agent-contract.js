'use strict';
const { normalizeScene, rank } = require('./memory-scope');
const TASK_SCHEMA = 'bunny.task/v2';
const STATES = new Set(['queued','ready','running','waiting','waiting_permission','paused','needs_attention','stopping','completed','stopped','expired']);
const TERMINAL = new Set(['completed','stopped','expired']);
const MAX_ACTIVE_TASKS = 5;
const occupiesSlot = task => task.skill !== 'task.resolve' && !TERMINAL.has(task.status) && !['queued','paused'].includes(task.status);
const capacityNote = '同时最多启动5个任务。请打开“任务与工作”，停止不需要的任务后，手动启动这项任务。';
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
  fields(value, ['skill','goal','criteria','subjects','policy','parameters','schedule','completion','context','delivery','workContext','workRequest','title'], '任务');
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
  const visualWatch=['conversation.manage','screen.watch'].includes(skill);
  const intervalSeconds = schedule.intervalSeconds ?? (visualWatch?5:60), activeIntervalSeconds = schedule.activeIntervalSeconds ?? (visualWatch?3:10);
  for (const v of [intervalSeconds, activeIntervalSeconds]) if (!Number.isInteger(v) || v < 3 || v > 3600) throw new Error('观察间隔须为3到3600秒');
  if (schedule.durationMinutes != null && (!Number.isInteger(schedule.durationMinutes) || schedule.durationMinutes < 1 || schedule.durationMinutes > 43200)) throw new Error('任务时长不合法');
  const completion = value.completion ?? 'manual';
  if (!['manual','first_match','goal'].includes(completion)) throw new Error('任务完成条件不合法');
  const parameters = value.parameters ?? {};
  if (!plain(parameters) || Buffer.byteLength(JSON.stringify(parameters)) > 32000) throw new Error('任务参数过大或不合法');
  let delivery,workContext,workRequest;
  if(value.workRequest!==undefined){fields(value.workRequest,['goal','criteria','context','output'],'制作任务');if(!['work.delegate','software.execute','system.operate'].includes(skill))throw Error('制作任务只适用于工作委派');if(value.workRequest.output!==undefined&&!['auto','text','files'].includes(value.workRequest.output))throw Error('制作输出类型无效');workRequest={...(value.workRequest.output?{output:value.workRequest.output}:{}),goal:text(value.workRequest.goal,'制作目标',6000),...(value.workRequest.criteria?{criteria:text(value.workRequest.criteria,'制作条件',3000)}:{}),...(value.workRequest.context?{context:text(value.workRequest.context,'制作背景',12000)}:{})};}
  if(value.delivery!==undefined){fields(value.delivery,['channel','recipient','includeFiles'],'结果渠道');if(!['speech','wechat'].includes(value.delivery.channel))throw new Error('结果渠道不合法');
    if(value.delivery.channel==='speech'&&value.delivery.recipient!==undefined)throw new Error('语音渠道不能指定收件人');
    if(value.delivery.includeFiles!==undefined&&typeof value.delivery.includeFiles!=='boolean')throw Error('附件交付选项无效');delivery={channel:value.delivery.channel,...(value.delivery.includeFiles===undefined?{}:{includeFiles:value.delivery.includeFiles}),...(value.delivery.channel==='wechat'?{recipient:text(value.delivery.recipient??'文件传输助手','结果收件人',100)}:{})};}
  if(value.workContext!==undefined){fields(value.workContext,['workspace','directory','mode'],'工作位置');if(!['work.delegate','software.execute'].includes(skill))throw new Error('工作位置只适用于工作委派');
    if(value.workContext.mode!==undefined&&!['auto','none','workspace'].includes(value.workContext.mode))throw new Error('工作位置模式不合法');
    workContext=Object.fromEntries(Object.entries(value.workContext).map(([key,v])=>[key,text(v,'工作位置',key==='directory'?1000:160)]));}
  return { skill,...(value.title?{title:text(value.title,'任务标题',80)}:{}), goal: text(value.goal,'任务目标',6000), criteria: text(value.criteria ?? value.goal,'验收条件',3000), subjects,
    policy: text(value.policy ?? '', '任务规则', 6000, true), parameters: clone(parameters), completion,
    ...(value.context===undefined?{}:{context:text(value.context,'任务上下文',12000,true)}),...(delivery?{delivery}:{}),...(workContext?{workContext}:{}),...(workRequest?{workRequest}:{}),
    schedule: { intervalSeconds, activeIntervalSeconds, ...(schedule.durationMinutes == null ? {} : { durationMinutes: schedule.durationMinutes }) } };
}
function authority(value, scene = 'life') {
  if (!plain(value) || value.role !== 'owner' || value.verified !== true || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 200 ||
      value.sources.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('任务缺少已核实的主人交办来源');
  scene = normalizeScene(scene);
  if(value.originSourceId!==undefined&&(!value.sources.includes(value.originSourceId)||typeof value.originSourceId!=='string'))throw Error('交办原始来源无效');
  if (value.visibilityFloor !== undefined && (!Number.isInteger(value.visibilityFloor) || value.visibilityFloor < rank(scene) || value.visibilityFloor > 2)) throw new Error('交办资料范围不合法');
  return { role: 'owner', verified: true, channel: text(value.channel ?? 'dialogue','交办渠道',100),
    sources: [...new Set(value.sources)],...(value.originSourceId?{originSourceId:value.originSourceId}:{}), scene, visibilityFloor: Math.max(rank(scene), value.visibilityFloor ?? rank(scene)),
    ...(Array.isArray(value.capabilities) ? { capabilities: [...new Set(value.capabilities.map(c => text(c,'能力',100)))] } : {}) };
}
module.exports = { TASK_SCHEMA, STATES, TERMINAL, MAX_ACTIVE_TASKS, occupiesSlot, capacityNote, taskSpec, authority, fields, plain, text, clone };
