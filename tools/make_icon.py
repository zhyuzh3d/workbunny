#!/usr/bin/env python3
"""生成托盘模板图标（黑形+透明底），macOS 菜单栏会自动反色。"""
import struct
import zlib
import math
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "res")


def png(path, size, pixels):
    """pixels: list of rows, each row list of (a) alpha 0-255 (灰度固定 0=黑)"""
    raw = b""
    for row in pixels:
        raw += b"\x00"
        for a in row:
            raw += bytes((0, 0, 0, a))  # RGBA
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    data += chunk(b"IDAT", zlib.compress(raw, 9))
    data += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def shape(size):
    """一只圆头带双耳的小生物剪影"""
    S = size
    c = (S - 1) / 2.0
    rows = []
    for y in range(S):
        row = []
        for x in range(S):
            a = 0.0
            dx, dy = x - c, y - c
            # 头：半径 0.40*S 的圆，中心略偏下
            hx, hy = x - c, y - (c + 0.06 * S)
            if hx * hx + hy * hy <= (0.375 * S) ** 2:
                a = 1.0
            # 两只耳朵：小三角
            for sx in (-1, 1):
                ex = c + sx * 0.255 * S
                ey = c - 0.285 * S
                # 三角形 (ex, ey) 顶点 + 底边两点
                p1 = (ex, ey)
                p2 = (ex - sx * 0.135 * S, ey + 0.20 * S)
                p3 = (ex + sx * 0.055 * S, ey + 0.22 * S)
                def sign(ax, ay, bx, by, px, py):
                    return (px - bx) * (ay - by) - (ax - bx) * (py - by)
                d1 = sign(*p1, *p2, x, y)
                d2 = sign(*p2, *p3, x, y)
                d3 = sign(*p3, *p1, x, y)
                neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
                pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
                if not (neg and pos):
                    a = 1.0
            # 眼睛挖空
            for sx in (-1, 1):
                ox = c + sx * 0.135 * S
                oy = c + 0.03 * S
                r = 0.075 * S
                if (x - ox) ** 2 + (y - oy) ** 2 <= r * r:
                    a = 0.0
            row.append(int(max(0.0, min(1.0, a)) * 255))
        rows.append(row)
    return rows


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size in (("trayTemplate.png", 22), ("trayTemplate@2x.png", 44), ("icon.png", 256)):
        n = png(os.path.join(OUT, name), size, shape(size))
        print(f"{name:24s} {size}x{size}  {n} bytes")
