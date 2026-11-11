# Offline SpeechAnalyzer replay

Requires an Apple Silicon Mac running macOS 26 and an **already installed** speech locale. Reads existing diagnostic PCM or an audio file; never opens a microphone, requests permission, downloads speech assets, calls an LLM, or runs WorkBunny code. No production ASR files are compiled into the tool.

```sh
mkdir -m 700 /private/tmp/speech-replay-results
zsh tools/speech-replay/run.sh \
  --diagnostic /absolute/private/diagnostic-directory \
  --output /private/tmp/speech-replay-results/none.json \
  --detector none --reporting volatile-fast --speed 1
```

Use `--wav /absolute/audio.wav` instead of `--diagnostic` for WAV input. Diagnostic input requires `native-events.ndjson` `audio-buffer` records and `processed-audio.pcm`; it reconstructs each buffer from the recorded PCM format, plane byte offsets, and lengths, without guessing the encoding. Format changes inside one recording are rejected. WAV input is split into 40 ms buffers. If needed, `AVAudioConverter` converts the recorded format to the analyzer's compatible format.

Options:

- `--detector none|low|medium|high` (default `none`). Detector results are recorded, and the detector participates in the analyzer's input processing.
- `--reporting volatile|volatile-fast` (default `volatile-fast`). Both provide volatile results; the latter also enables `fastResults`.
- `--generation INTEGER` selects diagnostic buffers offered to that original analyzer generation via `audio-offer` records with route `direct`/`replay` and outcome `enqueued`. It uses offer generation rather than capture generation, which can differ for queued buffers. These records establish producer queue admission, not consumer acknowledgment. This mode is essential when a short original session hallucinated only after endpoint finalization; whole-recording replay can hide that behavior.
- `--context-file FILE` supplies a private JSON array of already expanded contextual strings. The tool does not apply WorkBunny's wake-name alias expansion. Use recorded historical context when available; current settings are an explicitly weaker approximation.
- `--speed 1` (default) delivers callbacks at their accumulated audio duration. `0` submits as fast as possible; its wall time is throughput, not live latency. This reproduces samples and buffer boundaries, not original inter-callback scheduling jitter, analyzer generations, or WorkBunny endpoint decisions.
- `--reference-file FILE` optionally supplies a UTF-8 human transcript. Scoring ignores punctuation, whitespace, and case. `orderedCharacterRecall` uses longest common subsequence; `characterErrorRate` uses edit distance. An existing recognizer transcript can be a comparison proxy but is not ground truth.
- `--lang zh-CN` and `--timeout 90` are defaults. The deadline covers setup, replay, and finalization and terminates a stalled process with exit 124.

Stdout contains only metrics and the output path. The new output file is opened exclusively with permissions `0600`, and includes full private transcripts and native output evidence. Put it in a private directory; do not commit these files. No actual recordings or account information belong in this folder.

`firstResultSeconds` starts after analyzer preparation/start, immediately before replay. `rangeEndLagP50Seconds` is result-arrival wall time minus the result's audio range end divided by replay speed. It includes internal buffering and end-of-input finalization; it is not latency from a manually annotated spoken-word boundary. `firstResultSubmittedAudioSeconds` shows how much audio had been delivered by the first result. Empty result sets omit latency fields.

The last transcript is reconstructed from non-overlapping latest range revisions. Final and volatile text lengths are reported separately. A successful process means the finalizer and both result sequences completed; a text length alone does not establish sentence recall or speech authenticity. Analyzer/result failures are retained in the private output, with completion flags and exit 1, so a rejection is distinguishable from a normal empty result. Setup failures and absolute deadline termination report an error without a completed result file.

For a grid, compile `replay.swift` once with the command in `run.sh`, then invoke the binary sequentially for each mode; concurrent analyzers distort latency. The API signatures were checked against the local macOS SDK's `Speech.swiftinterface` (`SpeechAnalyzer`, `SpeechTranscriber.ReportingOption`, `SpeechDetector.DetectionOptions`, and `AnalyzerInput`).
