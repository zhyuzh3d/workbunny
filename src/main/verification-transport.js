'use strict';

const wb = require('./workbuddy');
const { freeModel } = require('./workbuddy-free');
const { normalizeOutputBudget } = require('./self-repair');

// Read-only checking may retry once after the broker's inline-response cap or
// an exhausted reasoning budget. Never retry a GUI action or pick a paid model.
async function requestVerification({ messages, signal, vision = false, maxTokens, budgetScale,inputBudgetTokens,extraBody,singleAttempt=false,recoveryReason,timeoutMs=25000 }, { chat = wb.chat, selectFree = freeModel } = {}) {
  const deadline=Math.min(180000,Math.max(1,Number.isFinite(Number(timeoutMs))?Number(timeoutMs):25000));
  const invoke = async (model, maxTokens, body=extraBody) => {
    if (signal?.aborted) throw new Error('交付检查已取消');
    let response;try{response = await chat({ model, thinking: 'low', maxTokens, budgetScale,inputBudgetTokens, signal, messages, timeoutMs:deadline,
      extraBody: { ...body,reasoning_effort: 'low', response_format: { type: 'json_object' } } });}catch(error){if(error.code==='E_MODEL_TIMEOUT')error.diagnostic={...error.diagnostic,modelRequest:{timeoutMs:deadline,requestStarted:true,externalAction:false}};throw error;}
    if (response.model && response.model !== model) throw new Error('验收模型与所选模型不符');
    return response;
  };
  const requested=normalizeOutputBudget({maxTokens,vision});
  // Prices/capabilities change independently of model IDs. The catalog is
  // the authority for both the first read-only request and its bounded retry.
  const selected=await selectFree({vision,signal});
  if(typeof selected!=='string'||!selected.trim())throw Object.assign(Error('当前目录没有确认可用的免费核查模型'),{code:'E_FREE_MODEL_UNAVAILABLE'});
  try { return { response: await invoke(selected,requested), model:selected }; }
  catch (error) {
    if (singleAttempt || signal?.aborted || !['E_PAYLOAD_TOO_LARGE', 'E_EMPTY_RESPONSE', 'E_OUTPUT_LIMIT'].includes(error.code)) throw error;
    const model = await selectFree({ vision, signal });
    if (signal?.aborted) throw new Error('交付检查已取消');
    if(typeof model!=='string'||!model.trim())throw Object.assign(Error('当前目录没有确认可用的免费核查模型'),{code:'E_FREE_MODEL_UNAVAILABLE'});
    const repaired=require('./self-repair').responseRecovery({maxTokens:requested,extraBody},error);
    return { response: await invoke(model,repaired?.maxTokens??requested,repaired?.extraBody??extraBody), model, fallbackReason: error.code };
  }
}

module.exports = { requestVerification };
