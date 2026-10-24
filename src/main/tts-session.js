'use strict';

// Persist the engine that actually produced audio. An old in-flight request
// must not overwrite a newer engine/voice selection when it eventually fails.
function createTTSSession({ getConfig, saveConfig, synthesize, onFallback }) {
  let revision = 0;
  function useSystem(reason, from, voice) {
    if (getConfig().tts.engine !== from || from === 'system') return;
    const config = saveConfig({ tts: { engine: 'system', voice,
      lastFallback: { from, reason: reason || '所选语音引擎不可用', at: Date.now() } } });
    revision++;
    onFallback?.(config, { reason });
  }
  async function speak(text, requested = getConfig().tts, options = {}) {
    const startedAt = revision;
    const result = await synthesize(text, requested, options);
    if (result.degraded && result.engine === 'system' && revision === startedAt &&
        getConfig().tts.engine === requested.engine) {
      useSystem(result.reason, requested.engine, result.voice);
    }
    return result;
  }
  return { synthesize: speak, changed: () => { revision++; }, useSystem };
}

module.exports = { createTTSSession };
