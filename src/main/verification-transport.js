'use strict';

const wb = require('./workbuddy');
const { freeModel } = require('./workbuddy-free');
const FLASH = 'deepseek-v4.1-flash';

// Read-only checking may retry once after the broker's inline-response cap or
// an exhausted reasoning budget. Never retry a GUI action or pick a paid model.
async function requestVerification({ messages, signal, vision = false }, { chat = wb.chat, selectFree = freeModel } = {}) {
  const invoke = async (model, maxTokens) => {
    if (signal?.aborted) throw new Error('交付检查已取消');
    const response = await chat({ model, thinking: 'low', maxTokens, signal, messages,
      extraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } } });
    if (response.model && response.model !== model) throw new Error('验收模型与所选模型不符');
    return response;
  };
  try { return { response: await invoke(FLASH, 2048), model: FLASH }; }
  catch (error) {
    if (signal?.aborted || !['E_PAYLOAD_TOO_LARGE', 'E_EMPTY_RESPONSE'].includes(error.code)) throw error;
    const model = await selectFree({ vision, signal });
    if (signal?.aborted) throw new Error('交付检查已取消');
    if (model !== 'hy3') throw new Error('当前目录未确认免费 Hy3，保留结果等待核对，没有切换付费模型。');
    return { response: await invoke(model, 4096), model, fallbackReason: error.code };
  }
}

module.exports = { requestVerification };
