#ifndef WORKBUNNY_ECHO_CANCELLATION_H
#define WORKBUNNY_ECHO_CANCELLATION_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WBAEC WBAEC;

enum {
    WB_AEC_OK = 0,
    WB_AEC_INVALID_ARGUMENT = -1000,
    WB_AEC_NOT_INITIALIZED = -1001,
    WB_AEC_INTERNAL_ERROR = -1002
};

typedef struct {
    uint64_t render_frames;
    uint64_t capture_frames;
    uint64_t resets;
    int last_error;
    /* -1 / NaN means WebRTC has not produced the corresponding estimate. */
    int estimated_delay_ms;
    double echo_return_loss_db;
    double echo_return_loss_enhancement_db;
} WBAECStats;

/* WebRTC AudioProcessing 2.1 / AEC3. Serial ownership is required: do not call
 * render, capture, reset, delay, or stats concurrently on the same instance.
 * Supported rates: 16000 / 32000 / 48000 Hz. Capture is mono; render is 1 or 2
 * deinterleaved channels. Every frame is exactly sample_rate / 100 samples.
 * Samples use normalized Float32 [-1, 1]. AEC3 includes automatic acoustic
 * delay estimation and double-talk handling. Standard noise suppression is enabled
 * with upstream defaults shared by all input devices.
 * All automatic microphone / digital gain controls are disabled. */
WBAEC *wb_aec_create(int sample_rate, int render_channels);
void wb_aec_destroy(WBAEC *aec);
int wb_aec_reset(WBAEC *aec);

/* Supply actual chronological speaker frames before the corresponding capture
 * processing. Silent render frames are valid and must not be omitted. Device
 * changes / discarded reference history require reset. No reference means the
 * caller should bypass this processor and keep microphone capture alive. */
int wb_aec_process_render(WBAEC *aec, const float *const *channels,
                          size_t num_samples);
/* Input and output may alias. On an APM error, valid input is copied to output
 * and the nonzero error is returned; callers must not report active AEC then. */
int wb_aec_process_capture(WBAEC *aec, const float *input, float *output,
                           size_t num_samples);

/* Buffering delay as defined by WebRTC, not an acoustic-delay guess. 0 is
 * suitable when both streams are fed promptly from time-aligned device taps.
 * AEC3 estimates the remaining acoustic path delay itself. Range 0..500 ms. */
int wb_aec_set_stream_delay_ms(WBAEC *aec, int delay_ms);
int wb_aec_get_stats(WBAEC *aec, WBAECStats *stats);
const char *wb_aec_version(void);

#ifdef __cplusplus
}
#endif
#endif
