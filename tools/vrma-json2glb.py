#!/usr/bin/env python3
"""把「.vrma 但内容是 glTF JSON」的文件原地转成标准 GLB。

为什么必须转：desktop-waifu 那批是 FBX2glTF 导出的 JSON（buffer 走 base64 data URI）。
three 的 GLTFLoader 也认，但走的是另一条分支 —— 一旦哪条分支对 VRMC_vrm_animation
的扩展处理不一致，就是"加载出来没动作"这种难查的坑。统一成 GLB，92 条全走同一条路。
"""
import base64
import json
import os
import struct
import sys

DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'renderer', 'assets', 'motions')


def to_glb(path):
    raw = open(path, 'rb').read()
    if raw[:4] == b'glTF':
        return False                      # 已经是 GLB
    try:
        js = json.loads(raw.decode('utf-8'))
    except Exception:
        return False
    bufs = js.get('buffers') or []
    if len(bufs) != 1 or not (bufs[0].get('uri') or '').startswith('data:'):
        print('  ! 跳过（buffer 不是单条 data URI）：', os.path.basename(path))
        return False
    head, b64 = bufs[0]['uri'].split(',', 1)
    bin_ = base64.b64decode(b64)
    bufs[0].pop('uri', None)              # GLB 里无 uri = 用 BIN chunk
    js_chunk = json.dumps(js, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    js_chunk += b' ' * ((4 - len(js_chunk) % 4) % 4)
    bin_chunk = bin_ + b'\x00' * ((4 - len(bin_) % 4) % 4)
    total = 12 + 8 + len(js_chunk) + 8 + len(bin_chunk)
    out = bytearray()
    out += struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<II', len(js_chunk), 0x4E4F534A)
    out += js_chunk
    out += struct.pack('<II', len(bin_chunk), 0x004E4942)
    out += bin_chunk
    open(path, 'wb').write(bytes(out))
    return True


if __name__ == '__main__':
    n = 0
    for f in sorted(os.listdir(DIR)):
        if not f.endswith('.vrma'):
            continue
        if to_glb(os.path.join(DIR, f)):
            n += 1
            print('  转 GLB：', f)
    print(f'共转换 {n} 条')
