#ifndef WORKBUNNY_SPEECH_VAD_H
#define WORKBUNNY_SPEECH_VAD_H
#include <stddef.h>
#include <stdint.h>
typedef struct WBSpeechVad WBSpeechVad;
WBSpeechVad *wb_speech_vad_new(int sample_rate);
void wb_speech_vad_free(WBSpeechVad *vad);
// -1 invalid, 0 quiet, 1 direct speech, >1 continuity hangover.
// libfvad's public API intentionally collapses the last two states. Retaining
// the core distinction prevents its synthetic tail from authenticating words.
int wb_speech_vad_process(WBSpeechVad *vad, const int16_t *samples, size_t count);
#endif
