#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 15x15 交叉点的「灰度均值 / 方差」矩阵打出来，看清哪些点是 cd子、哪些是空的。"""
import json
import subprocess

from PIL import Image

ROOT = r"C:/Users/harve/Desktop/Gobang auto"
SHOT = ROOT + "/tools/_forensics/recog32/shot.png"
EXE = ROOT + "/desktop-vision/build/GomokuVision.exe"

res = json.loads(subprocess.run([EXE, "--scan-image", SHOT],
                               capture_output=True, text=True).stdout)
geo = res["geometry"]
xs, ys, n = geo["x_lines"], geo["y_lines"], geo["size"]
spacing = geo["spacing"]
im = Image.open(SHOT).convert("L")
W, H = im.size
px = im.load()
rad = max(3, int(round(spacing * 0.30)))


def stat(cx, cy):
    vals = []
    for dy in range(-rad, rad + 1):
        y = int(round(cy)) + dy
        if not 0 <= y < H:
            continue
        for dx in range(-rad, rad + 1):
            x = int(round(cx)) + dx
            if not 0 <= x < W:
                continue
            if dx * dx + dy * dy > rad * rad:
                continue
            vals.append(px[x, y])
    m = sum(vals) / len(vals)
    s = (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5
    return m, s


engine = {}
for s in res["black"]:
    engine[(s["y"], s["x"])] = "B"
for s in res["white"]:
    engine[(s["y"], s["x"])] = "W"

print("image %dx%d  spacing=%.2f rad=%d" % (W, H, spacing, rad))
for tag, pick in (("mean", 0), ("std ", 1)):
    print("\n--- %s ---" % tag)
    for r in range(n):
        row = []
        for c in range(n):
            row.append("%5.1f" % stat(xs[c], ys[r])[pick])
        print("r%2d %s | %s" % (r, " ".join(row),
                                "".join(engine.get((r, c), ".") for c in range(n))))
print("\nengine readout row-major (B black W white . empty) 已在每行末尾显示")
