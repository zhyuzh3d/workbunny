#!/usr/bin/env python3
"""Actual upstream speech waveforms -> convolved speaker echo -> native AEC3.

Requires numpy + scipy only for test fixture convolution and metrics.
No microphone, device-volume changes, app launch, or recognition is involved.
Download fixtures once with --download-fixtures; subsequent DSP tests are offline.
Test audio and results remain under .local/ and are never source dependencies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.request import urlopen

import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = {
    "far48_stereo.pcm": ("69c679d06f275c1bb4a616dc626a9a893d9c11f9",
                         "7d73652d87fa553e5455a30927c26c899f536d3c64713ba485e37319d5447632"),
    "pc_quality_smoke_test_bob_source.wav": (
        "b18e0d654b84e6150dc79140f40dac3f8e675e7d",
        "002ae38b132806de58f16cf2533b21a4de57c92b1bb847cf8bfcddfade7413d8")
}


def power(x):
    return float(np.mean(x * x))


def db_ratio(a, b):
    return float(10 * np.log10(max(a, 1e-20) / max(b, 1e-20)))


def speech_metrics(expected, actual, rate, start, end):
    # Align only the processor's small fixed DSP latency, never the echo path.
    offset = int(start * rate)
    a = expected[offset:int(end * rate)]
    b = actual[offset:int(end * rate)]
    correlation = signal.correlate(b, a, mode="full", method="fft")
    center = len(a) - 1
    bound = int(rate * .03)
    lag = int(np.argmax(correlation[center - bound:center + bound + 1])) - bound
    if lag > 0:
        a, b = a[:-lag], b[lag:]
    elif lag < 0:
        a, b = a[-lag:], b[:lag]
    gain = float(np.dot(a, b) / max(np.dot(a, a), 1e-20))
    projected = gain * a
    return {"latency_ms": lag * 1000 / rate,
            "near_gain_db": db_ratio(power(projected), power(a)),
            "near_correlation": float(np.corrcoef(a, b)[0, 1]),
            "near_si_sdr_db": db_ratio(power(projected), power(b - projected))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-fixtures", action="store_true")
    parser.add_argument("--fixtures", type=Path,
                        default=ROOT / ".local/aec3-test/fixtures")
    parser.add_argument("--output", type=Path, default=ROOT / ".local/aec3-test")
    parser.add_argument("--library", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.fixtures.mkdir(parents=True, exist_ok=True)
    for name, (sha1, sha256) in FIXTURES.items():
        target = args.fixtures / name
        if not target.exists() and args.download_fixtures:
            # Content-addressed WebRTC upstream test speech, as referenced by
            # https://webrtc.googlesource.com/src/+/refs/heads/main/resources/
            url = "https://storage.googleapis.com/chromium-webrtc-resources/" + sha1
            target.write_bytes(urlopen(url, timeout=60).read())
        if not target.exists():
            parser.error("Missing " + str(target) + "; use --download-fixtures once")
        data = target.read_bytes()
        if hashlib.sha256(data).hexdigest() != sha256:
            parser.error("Fixture SHA-256 mismatch: " + name)
    library = args.library
    if library is None:
        library = Path(subprocess.check_output(
            ["zsh", "tools/build-echo-cancellation.sh", str(args.output / "build")],
            cwd=ROOT, text=True).strip())
    runner = args.output / "echo-cancellation-runner"
    subprocess.run(["xcrun", "clang++", "-O2", "-std=c++17",
                    "-target", "arm64-apple-macos26.0", "-I", str(ROOT / "native"),
                    str(ROOT / "test/echo-cancellation-runner.cpp"), str(library),
                    "-framework", "Foundation", "-framework", "CoreFoundation",
                    "-o", str(runner)], check=True, cwd=ROOT)
    far_original = np.fromfile(args.fixtures / "far48_stereo.pcm", dtype="<i2").reshape(-1, 2) / 32768.
    near_rate, near_waveform = wavfile.read(args.fixtures / "pc_quality_smoke_test_bob_source.wav")
    assert near_rate == 48000 and near_waveform.ndim == 1
    near_original = near_waveform.astype(np.float64) / 32768.
    # The legacy near48/far48 fixture pair contains recorded echo and cannot
    # establish double-talk preservation. Use independent clean speech instead.
    cross = signal.correlate(far_original[:, 0], near_original, method="fft")
    independence = float(np.max(np.abs(cross)) /
                         np.sqrt(np.dot(far_original[:, 0], far_original[:, 0]) *
                                 np.dot(near_original, near_original)))
    assert independence < .12, "Near and far speech must be independent"
    duration = 35
    results = {"source": "WebRTC upstream recorded speech; SHA-256 verified",
               "echo_model": "stereo speaker paths, 120 ms delay, signed reflections through 72 ms",
               "duration_seconds": duration, "scenarios": {}}
    results["maximum_input_cross_correlation"] = independence

    for rate in (48000, 16000):
        down = 48000 // rate
        far = signal.resample_poly(far_original, 1, down, axis=0)
        near = signal.resample_poly(near_original, 1, down)
        count = rate * duration
        far = np.tile(far, (int(np.ceil(count / len(far))), 1))[:count]
        near = np.tile(near, int(np.ceil(count / len(near))))[:count]
        far *= .08 / np.sqrt(power(far))
        near *= .055 / np.sqrt(power(near))
        impulse = np.zeros(int(rate * .2))
        for seconds, amplitude in ((.120, .60), (.125, -.21), (.137, .15),
                                    (.160, -.09), (.192, .04)):
            impulse[round(seconds * rate)] = amplitude
        echo = signal.fftconvolve(far[:, 0], impulse)[:count]
        echo += signal.fftconvolve(far[:, 1], np.roll(impulse, round(rate * .003)) * .35)[:count]
        zero_render = np.zeros_like(far)
        double_near = near.copy()
        double_near[:rate * 12] = 0
        scenarios = [
            ("echo", far, echo, None, -1, False),
            ("near_silent_reference", zero_render, near, near, -1, False),
            ("double_talk", far, echo + double_near, double_near, -1, False),
            ("no_reference", zero_render, near, near, -1, True),
            ("reset_echo", far, echo, None, 1500, False),
        ]
        for name, render, capture, clean, reset, no_render in scenarios:
            case = args.output / (str(rate) + "-" + name)
            case.mkdir(exist_ok=True)
            assert np.max(np.abs(capture)) < 1, "Unclipped test input required"
            render.astype("<f4").tofile(case / "render.f32")
            capture.astype("<f4").tofile(case / "capture.f32")
            process = subprocess.run([str(runner), str(rate), "2",
                                      str(case / "render.f32"), str(case / "capture.f32"),
                                      str(case / "output.f32"), str(reset),
                                      str(int(no_render)), "0"], capture_output=True, text=True)
            (case / "native.log").write_text(process.stderr)
            if process.returncode:
                raise RuntimeError(name + " native error " + str(process.returncode) + ": " + process.stderr)
            output = np.fromfile(case / "output.f32", dtype="<f4").astype(np.float64)
            row = json.loads(process.stdout)
            assert len(output) == count and np.all(np.isfinite(output))
            if clean is None:
                row["measured_erle_db"] = db_ratio(power(echo[rate * 25:]), power(output[rate * 25:]))
                assert row["measured_erle_db"] > 20, row
            else:
                row.update(speech_metrics(clean, output, rate, 20, 35))
                # AEC3 + high-pass / low NS deliberately modifies the waveform;
                # validate near-signal retention, not bit-exact audio.
                # Full numeric fidelity is reported even above these floors.
                assert row["near_correlation"] > .70, row
                assert row["near_si_sdr_db"] > 0, row
                assert -6 < row["near_gain_db"] < 2, row
            results["scenarios"][str(rate) + "-" + name] = row
            print(str(rate) + "-" + name + ": " + json.dumps(row), flush=True)
    (args.output / "metrics.json").write_text(json.dumps(results, indent=2) + "\n")
    print("PASS: " + str(args.output / "metrics.json"))


if __name__ == "__main__":
    main()
