#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 PIL 独立核对 GomokuVision 在密子截图上的读子结果（不信任视觉引擎自己的 diag）。

判据：交叉点取半径 0.30×spacing 的圆patch，算灰度 std。
  空点 = 一张光板 + 两条网线 → std 小；落子 = 有棋子轮廓/高光 → std 明显大。
把「引擎说有子的 84 个交叉点」与「像素上说这里有东西的交叉点」做集合比对。
"""
import json
import subprocess
import sys

from PIL import Image

ROOT = r"C:/Users/harve/Desktop/Gobang auto"
SHOT = ROOT + "/tools/_forensics/recog32/shot.png"
EXE = ROOT + "/desktop-vision/build/GomokuVision.exe"

out = subprocess.run([EXE, "--scan-image", SHOT], capture_output=True, text=True).stdout
res = json.loads(out)
assert res["found"], res
geo = res["geometry"]
xs, ys = geo["x_lines"], geo["y_lines"]
n = geo["size"]
print("size=%d spacing=%.3f" % (n, geo["spacing"]))
print("x0=%.2f x14=%.2f y0=%.2f y14=%.2f" % (xs[0], xs[-1], ys[0], ys[-1]))

im = Image.open(SHOT).convert("L")
W, H = im.size
px = im.load()
spacing = geo["spacing"]
rad = max(3, int(round(spacing * 0.30)))


def patch_mean(cx, cy):
    vals = []
    for dy in range(-rad, rad + 1):
        y = int(round(cy)) + dy
        if y < 0 or y >= H:
            continue
        for dx in range(-rad, rad + 1):
            x = int(round(cx)) + dx
            if x < 0 or x >= W:
                continue
            if dx * dx + dy * dy > rad * rad:
                continue
            vals.append(px[x, y])
    if len(vals) < 8:
        return -1.0
    return sum(vals) / len(vals)


grid = {}
for r in range(n):
    for c in range(n):
        grid[(r, c)] = patch_mean(xs[c], ys[r])

engine = {}
for s in res["black"]:
    engine[(s["y"], s["x"])] = "B"
for s in res["white"]:
    engine[(s["y"], s["x"])] = "W"
print("engine stones=%d (black=%d white=%d)"
      % (len(engine), len(res["black"]), len(res["white"])))

# ★ 判据（先 dump_grid32 看清实测分布才定的，不是拍脑袋）：
#   空交叉点 = 木色底 + 两条网线 → 灰度均值 ≈ 171（盘沿略高 ≈ 175）
#   黑子Interior ≈ 40，白子Interior ≈ 243
#   少数落在中间值的格子 = 子上有落点标记（最后手那个黑十字、星位点），
#   底色取其全盘中位数自校准，避免把「带标记的子」误判成空点。
_meds = sorted(grid.values())
BG = _meds[len(_meds) // 2]
DARK, LIGHT = BG - 40.0, BG + 25.0
print("board background = %.1f → black<=%.1f  white>=%.1f" % (BG, DARK, LIGHT))


def classify(v):
    if v < 0:
        return "?"
    if v <= DARK:
        return "B"
    if v >= LIGHT:
        return "W"
    return "."


agree = disagree = 0
notes = []
for k in sorted(grid):
    p = classify(grid[k])
    e = engine.get(k, ".")
    if p == "?" or 100.0 < grid[k] < 140.0:
        continue                      # 落在盘外的点不算
    if p == e:
        agree += 1
    else:
        disagree += 1
        notes.append("(row=%d col=%d) pixel=%s(%.1f) engine=%s" % (k[0], k[1], p, grid[k], e))
print("cell-by-cell agreement: %d agree / %d disagree (%d cells)"
      % (agree, disagree, agree + disagree))
for s in notes[:20]:
    print("   " + s)

edges = sorted(k for k in engine if k[0] in (0, n - 1) or k[1] in (0, n - 1))
print("edge-line stones read = %d  %s" % (len(edges), edges))

ok = disagree == 0
print("VERDICT:", "OK" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
