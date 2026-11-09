#include "speech-vad.h"
#include "vendor/libfvad/src/vad/vad_core.h"
#include <stdlib.h>

// Use the pinned WebRTC core through a separate owner. The upstream libfvad
// API, source and release notices remain unchanged.
struct WBSpeechVad { VadInstT core; int rate; };
WBSpeechVad *wb_speech_vad_new(int sample_rate) {
    if (sample_rate != 8000 && sample_rate != 16000 && sample_rate != 32000 && sample_rate != 48000) return NULL;
    WBSpeechVad *vad = calloc(1, sizeof(*vad));
    if (!vad) return NULL;
    if (WebRtcVad_InitCore(&vad->core) != 0 || WebRtcVad_set_mode_core(&vad->core, 0) != 0) { free(vad); return NULL; }
    vad->rate = sample_rate;
    return vad;
}
void wb_speech_vad_free(WBSpeechVad *vad) { free(vad); }
int wb_speech_vad_process(WBSpeechVad *vad, const int16_t *samples, size_t count) {
    if (!vad || !samples || count != (size_t)vad->rate / 100) return -1;
    switch (vad->rate) {
        case 8000: return WebRtcVad_CalcVad8khz(&vad->core, samples, count);
        case 16000: return WebRtcVad_CalcVad16khz(&vad->core, samples, count);
        case 32000: return WebRtcVad_CalcVad32khz(&vad->core, samples, count);
        case 48000: return WebRtcVad_CalcVad48khz(&vad->core, samples, count);
        default: return -1;
    }
}
