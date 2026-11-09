#include "echo-cancellation.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <vector>

int main(int argc, char **argv) {
    if (argc != 9) return 2;
    const int rate = std::atoi(argv[1]), channels = std::atoi(argv[2]);
    const int reset_frame = std::atoi(argv[6]);
    const bool no_render = std::atoi(argv[7]) != 0;
    const int delay_ms = std::atoi(argv[8]);
    const size_t samples = static_cast<size_t>(rate / 100);
    std::ifstream render_file(argv[3], std::ios::binary);
    std::ifstream capture_file(argv[4], std::ios::binary);
    std::ofstream output_file(argv[5], std::ios::binary);
    if (!render_file || !capture_file || !output_file) return 3;
    if (wb_aec_create(44100, 2) || wb_aec_create(rate, 3)) return 4;
    auto aec = wb_aec_create(rate, channels);
    if (!aec || wb_aec_set_stream_delay_ms(aec, delay_ms) != 0) return 5;
    std::vector<float> input(samples), output(samples), interleaved(samples * channels);
    std::vector<float> left(samples), right(samples);
    const float *render[] = {left.data(), right.data()};
    if (wb_aec_process_capture(aec, input.data(), output.data(), samples - 1)
        != WB_AEC_INVALID_ARGUMENT) return 6;
    if (wb_aec_set_stream_delay_ms(aec, -1) != WB_AEC_INVALID_ARGUMENT) return 7;
    if (wb_aec_set_stream_delay_ms(aec, 501) != WB_AEC_INVALID_ARGUMENT) return 8;
    input[0] = std::numeric_limits<float>::quiet_NaN();
    if (wb_aec_process_capture(aec, input.data(), output.data(), samples)
        != WB_AEC_INVALID_ARGUMENT) return 9;
    size_t frames = 0;
    double max_us = 0, total_us = 0;
    while (capture_file.read(reinterpret_cast<char *>(input.data()), samples * sizeof(float))) {
        if (!render_file.read(reinterpret_cast<char *>(interleaved.data()),
                              interleaved.size() * sizeof(float))) return 10;
        if (static_cast<int>(frames) == reset_frame && wb_aec_reset(aec) != 0) return 11;
        for (size_t i = 0; i < samples; ++i) {
            left[i] = interleaved[i * channels];
            if (channels == 2) right[i] = interleaved[i * channels + 1];
        }
        const auto started = std::chrono::steady_clock::now();
        if (!no_render && wb_aec_process_render(aec, render, samples) != 0) return 12;
        float *destination = frames % 2 ? input.data() : output.data();
        if (wb_aec_process_capture(aec, input.data(), destination, samples) != 0) return 13;
        if (destination == input.data()) output = input;
        const double us = std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - started).count();
        total_us += us;
        max_us = std::max(max_us, us);
        for (float sample : output) if (!std::isfinite(sample) || std::abs(sample) > 1.0f) return 14;
        output_file.write(reinterpret_cast<const char *>(output.data()), samples * sizeof(float));
        ++frames;
    }
    WBAECStats stats{};
    if (wb_aec_get_stats(aec, &stats) != 0 || stats.capture_frames != frames ||
        stats.render_frames != (no_render ? 0 : frames) ||
        stats.resets != static_cast<uint64_t>(reset_frame >= 0 && reset_frame < frames)) return 15;
    wb_aec_destroy(aec);
    auto number = [](double value) {
        return std::isfinite(value) ? std::to_string(value) : "null";
    };
    std::cout << "{\"frames\":" << frames << ",\"delay_ms\":" << stats.estimated_delay_ms
              << ",\"apm_erle_db\":" << number(stats.echo_return_loss_enhancement_db)
              << ",\"average_frame_us\":" << total_us / frames
              << ",\"max_frame_us\":" << max_us << "}\n";
    return 0;
}
