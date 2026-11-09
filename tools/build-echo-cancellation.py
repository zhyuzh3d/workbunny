#!/usr/bin/env python3
"""Build the pinned upstream AEC3 and Abseil as one macOS static archive.

Usage: tools/build-echo-cancellation.sh OUTPUT_DIRECTORY
stdout: final absolute libworkbunny-aec3.a path. All build logs use stderr.
Cache: WORKBUNNY_AEC_BUILD_CACHE or .cache/native-aec3 (safe to remove).
Requires Xcode command line tools, Python 3, CMake and pkg-config at build time.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "native/vendor/aec3"


def run(args, env=None):
    subprocess.run([str(v) for v in args], check=True, cwd=ROOT, env=env,
                   stdout=sys.stderr, stderr=sys.stderr)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_archive(dep, downloads):
    archive = downloads / dep["url"].rsplit("/", 1)[1]
    if archive.exists() and sha256(archive) != dep["sha256"]:
        archive.unlink()
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + ".part")
        run(["curl", "--fail", "--location", "--silent", "--show-error",
             "--retry", "2", "--connect-timeout", "15", "--max-time", "180",
             dep["url"], "--output", partial])
        if sha256(partial) != dep["sha256"]:
            partial.unlink()
            raise RuntimeError("Source checksum mismatch: " + dep["url"])
        partial.replace(archive)
    return archive


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("AEC3 build requires Apple Silicon macOS")
    if len(sys.argv) != 2:
        raise RuntimeError("Usage: tools/build-echo-cancellation.sh OUTPUT_DIRECTORY")
    for tool in ("xcrun", "cmake", "pkg-config", "curl"):
        if not shutil.which(tool):
            raise RuntimeError("Missing build tool: " + tool)
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = os.environ.get("MACOSX_DEPLOYMENT_TARGET", "26.0")
    # Separate incompatible toolchains / deployment targets; avoid host libraries.
    compiler = subprocess.check_output(["xcrun", "clang++", "--version"])
    key = hashlib.sha256((VENDOR / "sources.json").read_bytes() +
                         (VENDOR / "build-requirements.txt").read_bytes() +
                         Path(__file__).read_bytes() + compiler +
                         target.encode()).hexdigest()[:16]
    cache_root = Path(os.environ.get("WORKBUNNY_AEC_BUILD_CACHE",
                                    str(ROOT / ".cache/native-aec3"))).resolve()
    cache = cache_root / key
    cache.mkdir(parents=True, exist_ok=True)
    # The build helper can be invoked simultaneously by package / native tests.
    import fcntl
    with (cache / "build.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        build(cache, cache_root, output, target)


def build(cache, cache_root, output, target):
    downloads = cache_root / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    dependencies = json.loads((VENDOR / "sources.json").read_text())
    for dep in dependencies.values():
        archive = fetch_archive(dep, downloads)
        source = cache / dep["directory"]
        if not source.exists():
            # Only exact, verified upstream archives are extracted. Reject
            # unexpected absolute / parent traversal paths even in that input.
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    destination = (cache / member.name).resolve()
                    if cache not in destination.parents:
                        raise RuntimeError("Unsafe archive path: " + member.name)
                bundle.extractall(cache)

    env = os.environ.copy()
    env["MACOSX_DEPLOYMENT_TARGET"] = target
    env["CC"] = subprocess.check_output(["xcrun", "--find", "clang"], text=True).strip()
    env["CXX"] = subprocess.check_output(["xcrun", "--find", "clang++"], text=True).strip()
    venv = cache / "python"
    if not (venv / "ready").exists():
        run([sys.executable, "-m", "venv", venv])
        run([venv / "bin/python", "-m", "pip", "install",
             "--disable-pip-version-check", "--only-binary=:all:",
             "--require-hashes", "--no-deps", "--cache-dir", cache_root / "pip",
             "-r", VENDOR / "build-requirements.txt"])
        (venv / "ready").touch()
    env["PATH"] = str(venv / "bin") + os.pathsep + env["PATH"]
    prefix = cache / "install"
    env["PKG_CONFIG_PATH"] = ""
    env["PKG_CONFIG_LIBDIR"] = str(prefix / "lib/pkgconfig")
    jobs = str(min(8, os.cpu_count() or 2))
    if not (cache / "dependencies.ready").exists():
        abseil = cache / dependencies["abseil"]["directory"]
        run(["cmake", "-S", abseil, "-B", cache / "abseil-build",
             "-G", "Unix Makefiles", "-DCMAKE_BUILD_TYPE=Release",
             "-DCMAKE_CXX_STANDARD=17", "-DCMAKE_OSX_ARCHITECTURES=arm64",
             "-DCMAKE_OSX_DEPLOYMENT_TARGET=" + target,
             "-DCMAKE_INSTALL_PREFIX=" + str(prefix), "-DCMAKE_INSTALL_LIBDIR=lib",
             "-DABSL_ENABLE_INSTALL=ON", "-DABSL_PROPAGATE_CXX_STD=ON",
             "-DABSL_BUILD_TESTING=OFF", "-DBUILD_SHARED_LIBS=OFF"], env)
        run(["cmake", "--build", cache / "abseil-build", "--parallel", jobs], env)
        run(["cmake", "--install", cache / "abseil-build"], env)
        webrtc = cache / dependencies["webrtc"]["directory"]
        # Static library only: upstream's unrelated example omits a required
        # CoreFoundation link on macOS. The application supplies the framework.
        if not (cache / "webrtc-build/build.ninja").exists():
            run([venv / "bin/meson", "setup", cache / "webrtc-build", webrtc,
                 "--prefix=" + str(prefix), "--libdir=lib", "--buildtype=release",
                 "--default-library=static", "--wrap-mode=nofallback"], env)
        run([venv / "bin/ninja", "-C", cache / "webrtc-build", "-j", jobs,
             "webrtc/modules/audio_processing/libwebrtc-audio-processing-2.a"], env)
        (cache / "dependencies.ready").touch()
    webrtc = cache / dependencies["webrtc"]["directory"]
    bridge = cache / "echo-cancellation.o"
    run(["xcrun", "clang++", "-O2", "-std=c++17", "-fvisibility=hidden",
         "-target", "arm64-apple-macos" + target,
         "-DWEBRTC_POSIX", "-DWEBRTC_MAC", "-I", webrtc / "webrtc",
         "-I", prefix / "include", "-c", ROOT / "native/echo-cancellation.cpp",
         "-o", bridge], env)
    archive = output / "libworkbunny-aec3.a"
    staged_archive = output / "libworkbunny-aec3.partial.a"
    upstream = cache / "webrtc-build/webrtc/modules/audio_processing/libwebrtc-audio-processing-2.a"
    run(["xcrun", "libtool", "-static", "-o", staged_archive, bridge, upstream,
         *sorted((prefix / "lib").glob("libabsl_*.a"))], env)
    staged_archive.replace(archive)
    shutil.copytree(VENDOR / "LICENSES", output / "aec3-licenses", dirs_exist_ok=True)
    shutil.copyfile(VENDOR / "sources.json", output / "aec3-licenses/sources.json")
    shutil.copyfile(VENDOR / "README.md", output / "aec3-licenses/README.md")
    print(archive)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print("AEC3 build failed: " + str(error), file=sys.stderr)
        sys.exit(1)
