'use strict';

const wb = require('./workbuddy');
const { freeModel } = require('./workbuddy-free');
const FLASH = 'deepseek-v4.1-flash';

// Read-only checking may retry once after the broker's inline-response cap or
// an exhausted reasoning budget. Never retry a GUI action or pick a paid model.
async function requestVerification({ messages, signal, vision = false, maxTokens, budgetScale,inputBudgetTokens,extraBody,singleAttempt=false,recoveryReason }, { chat = wb.chat, selectFree = freeModel } = {}) {
  const invoke = async (model, maxTokens, body=extraBody) => {
    if (signal?.aborted) throw new Error('交付检查已取消');
    const response = await chat({ model, thinking: 'low', maxTokens, budgetScale,inputBudgetTokens, signal, messages, timeoutMs:25000,
      extraBody: { ...body,reasoning_effort: 'low', response_format: { type: 'json_object' } } });
    if (response.model && response.model !== model) throw new Error('验收模型与所选模型不符');
    return response;
  };
  const requested=maxTokens===undefined?(vision?4096:2048):Math.min(8192,Math.max(1,Number(maxTokens)||1));
  const recovering=singleAttempt&&['E_PAYLOAD_TOO_LARGE','E_EMPTY_RESPONSE','E_OUTPUT_LIMIT'].includes(recoveryReason);
  const selected=recovering?await selectFree({vision,signal}):FLASH;
  if(recovering&&selected!=='hy3')throw new Error('当前目录未确认免费 Hy3，保留结果等待核对，没有切换付费模型。');
  try { return { response: await invoke(selected,requested), model:selected }; }
  catch (error) {
    if (singleAttempt || signal?.aborted || !['E_PAYLOAD_TOO_LARGE', 'E_EMPTY_RESPONSE', 'E_OUTPUT_LIMIT'].includes(error.code)) throw error;
    const model = await selectFree({ vision, signal });
    if (signal?.aborted) throw new Error('交付检查已取消');
    if (model !== 'hy3') throw new Error('当前目录未确认免费 Hy3，保留结果等待核对，没有切换付费模型。');
    const repaired=require('./self-repair').responseRecovery({maxTokens:requested,extraBody},error);
    return { response: await invoke(model,repaired?.maxTokens??requested,repaired?.extraBody??extraBody), model, fallbackReason: error.code };
  }
}

module.exports = { requestVerification };
