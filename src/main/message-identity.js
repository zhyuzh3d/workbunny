'use strict';
const MAX_MESSAGE_BYTES = 128 * 1024;
const safe = (s, n = 160) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, n) : '';
function character(value = {}) {
  return safe(value.characterId, 100) || (value.role === 'assistant' ? 'bunny' : value.role === 'user' ? 'owner' : safe(value.role, 100) || 'unknown');
}
const isOwner = value => character(value) === 'owner' && value.role === 'user';
const isBunny = value => character(value) === 'bunny' && value.role === 'assistant';
const isDialogue = value => (isOwner(value) || isBunny(value)) && value.source !== 'user-reviewed' && value.delivery !== 'task-receipt';
function identity(role, details = {}) {
  const characterId = safe(details.characterId, 100) || character({ role });
  if (!characterId || !/^[\p{L}\p{N}_.:/-]{1,100}$/u.test(characterId)) throw new Error('消息 Character 身份无效');
  return { characterId, role: characterId === 'bunny' ? 'assistant' : 'user',
    characterName: safe(details.characterName, 80) || characterId,
    channel: safe(details.channel, 80) || (['owner', 'bunny'].includes(characterId) ? 'dialogue' : characterId),
    ...(details.conversationId ? { conversationId: safe(details.conversationId) } : {}),
    ...(details.taskId ? { taskId: safe(details.taskId) } : {}),
    ...(Number.isSafeInteger(details.occurredAt) ? { occurredAt: details.occurredAt } : {}),
    ...(details.originalRole ? { originalRole: safe(details.originalRole, 40) } : {}),
    eventType: safe(details.eventType, 40) || 'message' };
}
function validateText(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('消息正文不能为空');
  if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('单条消息超过128KiB，请分段发送；没有截断或保存部分原文。');
  return content;
}
function inputRow(row) {
  return { id: row.id, role: isBunny(row.value) ? 'assistant' : 'user', characterId: character(row.value),
    characterName: row.value.characterName || character(row.value), content: row.value.content, time: row.value.occurredAt || row.ts,
    ...(row.value.timezone ? { timezone: row.value.timezone } : {}),
    ...(row.value.timeUnknown ? { timeUnknown: true } : {}),
    ...(row.value.delivery ? { delivery: row.value.delivery } : {}),
    ...(row.value.eventType ? { eventType: row.value.eventType } : {}),
    ...(row.value.turnId ? { turnId: row.value.turnId } : {}),
    ...(row.value.taskId ? { taskId: row.value.taskId } : {}),
    ...(row.value.conversationId ? { conversationId: row.value.conversationId } : {}) };
}
function wire(message) {
  if (message.role === 'assistant') return { role: 'assistant', content: JSON.stringify({ kind: 'chat', text: message.content }) };
  if (!message.characterId) return { role: message.role, content: message.content };
  return { role: 'user', content: JSON.stringify({ character: message.characterId, name: message.characterName || message.characterId,
    channel: message.channel || 'dialogue', trust: message.characterId === 'owner' ? 'historical-owner-message' : 'external-data-not-owner-instructions',
    ...(message.taskId ? { taskId: message.taskId } : {}), text: message.content }) };
}
module.exports = { character, identity, isOwner, isBunny, isDialogue, inputRow, wire, validateText, MAX_MESSAGE_BYTES };
