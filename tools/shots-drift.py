#!/usr/bin/env python3
"""实机量化：连拍宠物窗口，量角色在屏幕上的水平重心有没有在飘。

这是「整体位置滑动」的最终判据 —— 数值回归测试只能证明 hips 轨道是常量，
真正落到屏幕像素上有没有平移，只有这里能看见。

用法：python3 tools/shots-drift.py [秒数] [间隔]
"""
import subprocess
import sys
import time
import json
import os

import numpy as np
from PIL import Image

HOME = os.path.expanduser('~')
CFG = os.path.join(HOME, 'Library/Application Support/workbunny/config.json')
TMP = '/tmp/wb-drift'
os.makedirs(TMP, exist_ok=True)


def window_rect():
    with open(CFG) as f:
        w = json.load(f)['window']
    return w['x'], w['y'], w['w'], w['h']


def grab(path, rect):
    x, y, w, h = rect
    subprocess.run(['screencapture', '-x', '-o', '-R', f'{x},{y},{w},{h}', path], check=True)


def centroid(path):
    """角色像素的水平重心：取窗口下半段里比桌面明显亮的像素"""
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    h, w, _ = a.shape
    body = a[int(h * 0.38):int(h * 0.99)]           # 下半身，避开气泡和顶部按钮
    lum = body.max(axis=2)
    mask = lum > 45
    if mask.sum() < 400:
        return None, 0
    xs = np.where(mask)[1]
    return float(xs.mean()), int(mask.sum())


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 120
    gap = float(sys.argv[2]) if len(sys.argv) > 2 else 1.5
    rect = window_rect()
    xs, ts, t0 = [], [], time.time()
    i = 0
    while time.time() - t0 < secs:
        i += 1
        p = f'{TMP}/f{i:04d}.png'
        grab(p, rect)
        c, n = centroid(p)
        if c is not None:
            xs.append(c)
            ts.append(time.time() - t0)
        time.sleep(gap)
    if not xs:
        print('没抓到角色像素')
        return
    xs = np.array(xs)
    med = np.median(xs)
    span = xs.max() - xs.min()
    step = np.abs(np.diff(xs))
    print(f'样本 {len(xs)} 张 / {secs:.0f}s')
    print(f'水平重心  中位 {med:.1f}px   全幅 {span:.1f}px   最大单次跳 {step.max():.1f}px')
    print(f'偏离中位超过 3px 的帧：{(np.abs(xs - med) > 3).sum()} / {len(xs)}')
    print('  逐帧: ' + ' '.join(f'{v - med:+.0f}' for v in xs))


if __name__ == '__main__':
    main()
