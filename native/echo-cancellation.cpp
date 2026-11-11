#include "echo-cancellation.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <new>

#include "api/audio/audio_processing.h"
#include "api/audio/audio_processing_statistics.h"

struct WBAEC {
    rtc::scoped_refptr<webrtc::AudioProcessing> apm;
    webrtc::StreamConfig capture;
    webrtc::StreamConfig render;
    WBAECStats counters{};
    int delay_ms = 0;
};

namespace {
int record(WBAEC *aec, int error) {
    if (aec) aec->counters.last_error = error;
    return error;
}

bool valid_frame(const float *samples, size_t count) {
    if (!samples) return false;
    // Invalid samples must not poison the adaptive filter or its history.
    for (size_t i = 0; i < count; ++i) {
        if (!std::isfinite(samples[i]) || std::abs(samples[i]) > 1.0f) return false;
    }
    return true;
}

int initialize(WBAEC *aec) {
    webrtc::ProcessingConfig streams;
    streams.input_stream() = aec->capture;
    streams.output_stream() = aec->capture;
    streams.reverse_input_stream() = aec->render;
    streams.reverse_output_stream() = aec->render;
    int error = aec->apm->Initialize(streams);
    if (error == 0) error = aec->apm->set_stream_delay_ms(aec->delay_ms);
    aec->counters.estimated_delay_ms = -1;
    aec->counters.echo_return_loss_db =
        std::numeric_limits<double>::quiet_NaN();
    aec->counters.echo_return_loss_enhancement_db =
        std::numeric_limits<double>::quiet_NaN();
    return record(aec, error);
}

void update_statistics(WBAEC *aec) {
    // Upstream's statistics channel holds only one update and discards newer
    // updates while full. Drain every frame so infrequent callers do not see
    // startup metrics masquerading as the current convergence/delay state.
    const auto stats = aec->apm->GetStatistics();
    const double unknown = std::numeric_limits<double>::quiet_NaN();
    aec->counters.estimated_delay_ms = stats.delay_ms.value_or(-1);
    aec->counters.echo_return_loss_db = stats.echo_return_loss.value_or(unknown);
    aec->counters.echo_return_loss_enhancement_db =
        stats.echo_return_loss_enhancement.value_or(unknown);
}
}  // namespace

extern "C" WBAEC *wb_aec_create(int sample_rate, int render_channels) {
    if ((sample_rate != 16000 && sample_rate != 32000 && sample_rate != 48000) ||
        (render_channels != 1 && render_channels != 2)) return nullptr;
    try {
        auto aec = std::make_unique<WBAEC>();
        aec->capture = webrtc::StreamConfig(sample_rate, 1);
        aec->render = webrtc::StreamConfig(sample_rate, render_channels);
        webrtc::AudioProcessing::Config config;
        config.pipeline.multi_channel_render = render_channels > 1;
        config.echo_canceller.enabled = true;
        config.echo_canceller.mobile_mode = false;  // Select upstream AEC3.
        config.high_pass_filter.enabled = true;
        config.noise_suppression.enabled = true;
        // Use upstream's common noise-suppression defaults, without local
        // microphone-specific suppression levels or gain calibration.
        config.pre_amplifier.enabled = false;
        config.capture_level_adjustment.enabled = false;
        config.gain_controller1.enabled = false;
        config.gain_controller1.analog_gain_controller.enabled = false;
        config.gain_controller2.enabled = false;
        config.gain_controller2.input_volume_controller.enabled = false;
        config.gain_controller2.adaptive_digital.enabled = false;
        aec->apm = webrtc::AudioProcessingBuilder().SetConfig(config).Create();
        if (!aec->apm || initialize(aec.get()) != 0) return nullptr;
        return aec.release();
    } catch (...) {
        return nullptr;
    }
}

extern "C" void wb_aec_destroy(WBAEC *aec) { delete aec; }

extern "C" int wb_aec_reset(WBAEC *aec) {
    if (!aec || !aec->apm) return WB_AEC_NOT_INITIALIZED;
    try {
        int error = initialize(aec);
        if (error == 0) ++aec->counters.resets;
        return error;
    } catch (...) { return record(aec, WB_AEC_INTERNAL_ERROR); }
}

extern "C" int wb_aec_process_render(WBAEC *aec,
                                      const float *const *channels,
                                      size_t num_samples) {
    if (!aec || !aec->apm) return WB_AEC_NOT_INITIALIZED;
    if (!channels || num_samples != aec->render.num_frames())
        return record(aec, WB_AEC_INVALID_ARGUMENT);
    for (size_t ch = 0; ch < aec->render.num_channels(); ++ch) {
        if (!valid_frame(channels[ch], num_samples))
            return record(aec, WB_AEC_INVALID_ARGUMENT);
    }
    try {
        const int error = aec->apm->AnalyzeReverseStream(channels, aec->render);
        if (error == 0) ++aec->counters.render_frames;
        return record(aec, error);
    } catch (...) { return record(aec, WB_AEC_INTERNAL_ERROR); }
}

extern "C" int wb_aec_process_capture(WBAEC *aec, const float *input,
                                       float *output, size_t num_samples) {
    if (!aec || !aec->apm) return WB_AEC_NOT_INITIALIZED;
    if (!output || num_samples != aec->capture.num_frames() ||
        !valid_frame(input, num_samples))
        return record(aec, WB_AEC_INVALID_ARGUMENT);
    std::array<float, 480> in_place_backup;
    const float *capture_input = input;
    if (input == output) {
        std::copy_n(input, num_samples, in_place_backup.data());
        capture_input = in_place_backup.data();
    }
    try {
        const float *source[] = {capture_input};
        float *destination[] = {output};
        int error = aec->apm->set_stream_delay_ms(aec->delay_ms);
        if (error == 0)
            error = aec->apm->ProcessStream(source, aec->capture, aec->capture,
                                            destination);
        if (error == 0) {
            ++aec->counters.capture_frames;
            update_statistics(aec);
        }
        else std::memmove(output, capture_input, num_samples * sizeof(float));
        return record(aec, error);
    } catch (...) {
        std::memmove(output, capture_input, num_samples * sizeof(float));
        return record(aec, WB_AEC_INTERNAL_ERROR);
    }
}

extern "C" int wb_aec_set_stream_delay_ms(WBAEC *aec, int delay_ms) {
    if (!aec || !aec->apm) return WB_AEC_NOT_INITIALIZED;
    if (delay_ms < 0 || delay_ms > 500)
        return record(aec, WB_AEC_INVALID_ARGUMENT);
    aec->delay_ms = delay_ms;
    return record(aec, WB_AEC_OK);
}

extern "C" int wb_aec_get_stats(WBAEC *aec, WBAECStats *stats) {
    if (!aec || !aec->apm) return WB_AEC_NOT_INITIALIZED;
    if (!stats) return WB_AEC_INVALID_ARGUMENT;
    *stats = aec->counters;
    return WB_AEC_OK;
}

extern "C" const char *wb_aec_version(void) {
    return "webrtc-audio-processing/2.1 (M131 AEC3); abseil/20240722.0";
}
