#!/usr/bin/env python3
"""看清 .vrma 里到底有什么：时长、通道、hips 位移（水平/竖直）、循环接缝。

诊断"上下抖动"只需要三个数：hips 竖直位移的极差、每帧变化量、首尾差值。
"""
import json
import os
import struct
import sys

import numpy as np

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    data = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<4sII', data[:12])
    assert magic == b'glTF'
    off, js, bin_ = 12, None, b''
    while off < len(data):
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        body = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(body)
        elif ctype == 0x004E4942:
            bin_ = body
        off += 8 + clen
    return js, bin_


def read_accessor(js, bin_, idx):
    acc = js['accessors'][idx]
    n, nc = acc['count'], NCOMP[acc['type']]
    fmt, size = COMP[acc['componentType']]
    bv = js['bufferViews'][acc['bufferView']]
    base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = bv.get('byteStride') or nc * size
    out = np.empty((n, nc), dtype=np.float32)
    for i in range(n):
        o = base + i * stride
        out[i] = struct.unpack_from('<' + fmt * nc, bin_, o)
    return out


def probe(path):
    js, bin_ = load(path)
    name = os.path.basename(path)
    nodes = js.get('nodes', [])
    anim = js['animations'][0]
    # 时长
    dur = 0.0
    for s in anim['samplers']:
        t = read_accessor(js, bin_, s['input'])
        dur = max(dur, float(t[-1, 0]))

    # 找 hips 节点（VRMC_vrm_animation.humanoid 里 key 为 hips）
    hum = (js.get('extensions') or {}).get('VRMC_vrm_animation', {}).get('humanoid', {}).get('humanBones', {})
    hips_node = (hum.get('hips') or {}).get('node')
    hips_name = nodes[hips_node]['name'] if hips_node is not None else '?'

    info = {'name': name, 'dur': dur, 'channels': len(anim['channels']), 'hips': hips_name, 'nodes': len(nodes)}
    # hips 的 translation / rotation 轨道
    for ch in anim['channels']:
        node = ch['target']['node']
        path_ = ch['target']['path']
        if node != hips_node:
            continue
        s = anim['samplers'][ch['sampler']]
        t = read_accessor(js, bin_, s['input'])[:, 0]
        v = read_accessor(js, bin_, s['output'])
        info['interp'] = s.get('interpolation', 'LINEAR')
        info['keys'] = len(t)
        if path_ == 'translation':
            d = np.linalg.norm(np.diff(v, axis=0), axis=1)
            info['ty'] = (float(v[:, 1].min()), float(v[:, 1].max()), float(v[:, 1].max() - v[:, 1].min()))
            info['txz'] = (float(np.ptp(v[:, 0])), float(np.ptp(v[:, 2])))
            info['seam'] = (float(v[0, 1]), float(v[-1, 1]))
            info['step_max'] = float(d.max()) if len(d) else 0.0
            info['ty_series'] = v[:, 1].copy()
        elif path_ == 'rotation':
            info['q_seam'] = float(np.abs(v[0] - v[-1]).max())
    # 也看有没有别的节点带位移（根节点抖动）
    moved = []
    for ch in anim['channels']:
        if ch['target']['path'] != 'translation':
            continue
        s = anim['samplers'][ch['sampler']]
        v = read_accessor(js, bin_, s['output'])
        rng = np.ptp(v, axis=0).max()
        if rng > 1e-4:
            moved.append((nodes[ch['target']['node']].get('name', '?'), float(rng), float(np.ptp(v[:, 1]))))
    info['moved'] = moved
    return info


if __name__ == '__main__':
    paths = sys.argv[1:]
    for p in paths:
        i = probe(p)
        print(f"\n=== {i['name']}  {i['dur']:.2f}s  {i['channels']}通道 {i['nodes']}节点  hips={i['hips']}")
        if 'ty' in i:
            lo, hi, rng = i['ty']
            print(f"  hips.Y: {lo*100:.2f} ~ {hi*100:.2f} cm  极差 {rng*100:.2f} cm  "
                  f"单帧最大跳 {i['step_max']*100:.2f} cm")
            print(f"  hips.XZ 极差: {i['txz'][0]*100:.1f} / {i['txz'][1]*100:.1f} cm   "
                  f"接缝 Y: {i['seam'][0]*100:.2f} → {i['seam'][1]*100:.2f} cm "
                  f"(差 {(i['seam'][1]-i['seam'][0])*100:.2f})")
            s = i['ty_series']
            # 每 10% 采样，肉眼看抖动
            print('  Y 采样:', ' '.join(f'{x*100:.1f}' for x in s[::max(1, len(s)//12)]))
        else:
            print('  hips 无 translation 通道')
        if 'q_seam' in i:
            print(f"  hips 旋转接缝: max|dq| = {i['q_seam']:.4f}")
        if i['moved']:
            print('  带位移的节点:', ', '.join(f'{n}(range {r*100:.1f}cm, Y {y*100:.1f}cm)' for n, r, y in i['moved'][:6]))
