// Persistent, private stdio worker for the pinned llama.cpp TTS runtime.
// Model weights stay resident; every utterance gets fresh generation/KV state.
#include "arg.h"
#include "common.h"
#include "sampling.h"
#include "log.h"
#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
static long elapsed(Clock::time_point start) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}
static void reply(const json & value) { std::cout << value.dump() << std::endl; }
struct Reference { std::filesystem::file_time_type modified; uintmax_t size; mtmd::bitmap_ptr bitmap; };

int main(int argc, char ** argv) {
    const auto boot = Clock::now();
    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_TTS)) return 1;
    params.embedding = true;
    llama_backend_init();
    auto runtime = common_init_from_params(params);
    auto * model = runtime->model();
    auto * context = runtime->context();
    if (!model || !context) return 2;
    auto options = mtmd_context_params_default();
    options.use_gpu = params.mmproj_use_gpu;
    options.device = params.mmproj_device;
    mtmd::context_ptr projector(mtmd_init_from_file(params.mmproj.path.c_str(), model, options));
    if (!projector || mtmd_gen_audio_get_info(projector.get()).type == MTMD_GEN_AUDIO_TYPE_NONE) return 3;
    mtmd_helper::gen_audio generator(context, projector.get());
    std::map<std::string, Reference> references;
    reply({{"type", "ready"}, {"initMs", elapsed(boot)}});
    std::string line;
    while (std::getline(std::cin, line)) {
        int64_t id = 0;
        try {
            if (line.size() > 32768) throw std::runtime_error("request too large");
            const auto request = json::parse(line);
            id = request.at("id").get<int64_t>();
            const auto text = request.at("text").get<std::string>();
            const auto language = request.value("language", std::string("zh"));
            const auto reference = request.value("reference", std::string());
            if (text.empty() || text.size() > 8192) throw std::runtime_error("invalid text");
            const auto start = Clock::now();
            mtmd_bitmap * speaker = nullptr;
            if (!reference.empty()) {
                const auto modified = std::filesystem::last_write_time(reference);
                const auto bytes = std::filesystem::file_size(reference);
                auto found = references.find(reference);
                if (found == references.end() || found->second.modified != modified || found->second.size != bytes) {
                    auto decoded = mtmd_helper_bitmap_init_from_file(projector.get(), reference.c_str(), false, mtmd_helper_init_opt_default());
                    if (!decoded.bitmap) throw std::runtime_error("invalid reference");
                    if (references.size() >= 3) references.clear();
                    references.insert_or_assign(reference, Reference{modified, bytes, mtmd::bitmap_ptr(decoded.bitmap)});
                }
                speaker = references.at(reference).bitmap.get();
            }
            generator.reset();
            llama_memory_clear(llama_get_memory(context), true);
            auto sampling = params.sampling;
            sampling.seed = request.value("seed", params.sampling.seed);
            std::unique_ptr<common_sampler, decltype(&common_sampler_free)> sampler(common_sampler_init(model, sampling), common_sampler_free);
            if (!sampler) throw std::runtime_error("sampler failed");
            mtmd_helper_gen_audio_inp input{};
            input.seq_id = 0;
            input.prompt = text.c_str();
            input.prompt_len = text.size();
            input.lang = language.c_str();
            input.speaker_ref = speaker;
            input.top_k = params.sampling.top_k;
            input.top_p = params.sampling.top_p;
            input.seed = sampling.seed;
            input.out_type = MTMD_HELPER_GEN_AUDIO_OUTTYPE_WAV;
            if (generator.set_input(&input) != 0) throw std::runtime_error("input failed");
            for (;;) {
                const int ret = generator.step_prompt(params.n_batch);
                if (ret < 0) throw std::runtime_error("prompt failed");
                if (ret == 0) break;
            }
            auto sample = [&]() {
                const auto token = common_sampler_sample(sampler.get(), context, -1);
                common_sampler_accept(sampler.get(), token, true);
                return token;
            };
            auto token = sample();
            const float * hidden = llama_get_embeddings_ith(context, -1);
            bool stop = false;
            int frames = 0;
            const int limit = params.n_predict > 0 ? params.n_predict : 512;
            while (!stop && frames < limit) {
                const float * next = nullptr;
                if (generator.step_gen(token, hidden, &next, &stop) != 0) throw std::runtime_error("generation failed");
                if (!next) break;
                ++frames;
                hidden = next;
                token = sample();
            }
            if (!stop && frames >= limit) throw std::runtime_error("audio length limit");
            int32_t rate = 0;
            const char * audio = nullptr;
            size_t length = 0;
            int64_t samples = 0;
            if (generator.get_output(&rate, &audio, &length, &samples) != 0 || length < 44) throw std::runtime_error("audio failed");
            FILE * output = fopen(params.out_file.c_str(), "wb");
            if (!output) throw std::runtime_error("output failed");
            const bool written = fwrite(audio, 1, length, output) == length;
            fclose(output);
            if (!written) throw std::runtime_error("output incomplete");
            reply({{"id", id}, {"ok", true}, {"bytes", length}, {"ms", elapsed(start)},
                {"frames", frames}, {"audioSeconds", rate ? double(samples) / rate : 0.0}});
        } catch (...) {
            reply({{"id", id}, {"ok", false}, {"error", "本地语音合成失败"}});
        }
    }
    return 0;
}
