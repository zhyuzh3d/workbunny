#!/usr/bin/env python3
"""给 .vrma 补上规范要求的 VRMC_vrm_animation.specVersion。

这批公开动作文件（vrm-viewer / AIRI）都没写 specVersion，官方 loader 会 console.warn
并按 1.0 处理。补上之后行为不变，但不再刷警告，文件也是合规的。
"""
import glob
import json
import os
import struct
import sys

FIX = "1.0"


def patch(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, total = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF", path
    off = 12
    jlen, jtype = struct.unpack("<II", data[off:off + 8])
    assert jtype == 0x4E4F534A  # JSON
    jstart = off + 8
    jraw = data[jstart:jstart + jlen]
    js = json.loads(jraw)

    va = (js.get("extensions") or {}).get("VRMC_vrm_animation")
    if va is None:
        return "no-ext"
    if va.get("specVersion") == FIX:
        return "already"

    va["specVersion"] = FIX
    new_json = json.dumps(js, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    pad = (4 - (len(new_json) % 4)) % 4
    new_json += b" " * pad

    rest = data[jstart + jlen:]
    # 重算总长
    new_total = 12 + 8 + len(new_json) + len(rest)
    out = struct.pack("<4sII", magic, version, new_total)
    out += struct.pack("<II", len(new_json), jtype) + new_json + rest
    with open(path, "wb") as f:
        f.write(out)
    return f"patched (+{len(new_json) - jlen}B)"


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "src/renderer/assets/motions"
    for p in sorted(glob.glob(os.path.join(root, "*.vrma"))):
        print(f"{os.path.basename(p):22s} {patch(p)}")
