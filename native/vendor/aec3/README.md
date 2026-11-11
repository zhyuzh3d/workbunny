# WebRTC AEC3 dependency

WorkBunny uses the maintained freedesktop extraction of Google's WebRTC
AudioProcessing, release **2.1**, based on **WebRTC M131**. Its non-mobile echo
controller is AEC3. The bridge uses upstream automatic delay estimation,
multichannel render analysis, double-talk handling, a high-pass filter and standard
noise suppression with upstream defaults, shared by all devices. Analog/digital automatic gain control, preamplification and
capture level adjustment are disabled. The DSP never changes device volumes.

`sources.json` locks the two unmodified source archives and their SHA-256 hashes.
The Abseil version and checksum match upstream's included Meson wrap. Sources
are downloaded and cached outside tracked source, rather than adding several
megabytes of third-party code. No local Homebrew library is linked or required
by the packaged app. Xcode command line tools, Python 3, CMake and pkg-config are
build prerequisites. Meson and Ninja are pinned with wheel hashes and installed
into an isolated build venv. Builds perform no unpinned Meson wrap downloads.

Build with `zsh tools/build-echo-cancellation.sh OUTPUT_DIRECTORY`. stdout is the
absolute static archive path. Link that archive with libc++ and Apple's
Foundation/CoreFoundation frameworks. Default deployment target is macOS 26.0,
matching the ASR helper; `MACOSX_DEPLOYMENT_TARGET` overrides it. Cache is
`.cache/native-aec3`, or `WORKBUNNY_AEC_BUILD_CACHE`. Clean-cache rebuilding is
supported. Upstream source needs no patches; only the library target is built,
because its standalone example omits a macOS CoreFoundation link.

Distribute `LICENSES/` (or the build output's `aec3-licenses/`) with the binary.
It includes WebRTC's BSD license, patent grant and authors, Abseil's Apache 2.0
license and authors, and upstream bundled FFT/rnnoise license notices. Dependency
licenses apply independently of WorkBunny's own license.

The C API requires serialized 10 ms Float32 frames, chronological render before
capture, and resets after device/history discontinuities. Silent reference is
valid. When reference acquisition fails or becomes stale, callers must preserve
raw microphone capture and expose the fallback status. WebRTC statistics are
estimates, not proof of physical echo removal; real-device calibration and
speaker/microphone tests remain necessary.

DSP regression: `python3 test/test-echo-cancellation.py --download-fixtures`
(NumPy and SciPy required for fixture generation / measurement). This fetches
content-addressed upstream WebRTC speech with locked SHA-256 hashes into
`.local/aec3-test/fixtures`; omit the download flag to run fully offline after
that. No test audio is committed or included in the application. The test uses
independent near speech (maximum normalized cross-correlation under 0.12), two
speaker paths with a 120 ms unknown delay and signed reflected taps spanning
72 ms, and reports measured ERLE, near gain, correlation, SI-SDR and DSP latency.
It covers stereo reference at 48/16 kHz, double talk, silent/missing reference,
filter reset and invalid frames. Numeric results are saved under `.local/`.
The full-waveform ERLE measurement includes nonlinear residual suppression;
upstream's internal ERLE estimate describes its adaptive filter and differs.
Neither number establishes recognition accuracy or physical-room performance.

Primary upstream sources:

- https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/
- https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/
- https://github.com/abseil/abseil-cpp/releases/tag/20240722.0
