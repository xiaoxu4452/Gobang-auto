# -*- coding: utf-8 -*-
"""精确取各子中心色，与已知参照值比对；并导出三颗子的特写。"""
from PIL import Image
import numpy as np

p = r"C:\Users\harve\Pictures\Screenshots\屏幕截图 2026-10-01 210708.png"
im = Image.open(p).convert("RGB")
a = np.asarray(im)
VX = [481, 529, 578, 627, 675, 724, 773, 821, 869, 918, 967, 1015, 1064, 1113, 1161]
VY = [213, 261, 310, 359, 407, 456, 505, 553, 601, 650, 699, 747, 796, 845, 893]

REF = {
    "实心黑(真子)": (27, 25, 22),
    "实心白(真子)": (238, 234, 223),
    "木色(空)": (217, 184, 120),
    "推演白(半透明)": (212, 205, 179),
    "推演黑(半透明)": (120, 106, 83),
    "更不透明(选中)": (86, 81, 84),
}

def center(cx, cy, r=8):
    q = a[cy - r:cy + r, cx - r:cx + r].reshape(-1, 3).astype(float)
    return q.mean(axis=0)

print("== 三颗子的中心色（半径 8px，避开数字）==")
for nm, ix, iy in [("黑1 H8", 7, 7), ("白2 E11", 4, 4), ("黑3 I9", 8, 6)]:
    c = center(VX[ix], VY[iy])
    best = min(REF.items(), key=lambda kv: sum((c[i] - kv[1][i]) ** 2 for i in range(3)))
    print("  %-10s rgb=(%3.0f,%3.0f,%3.0f)  → 最接近: %s" % (nm, c[0], c[1], c[2], best[0]))

print("\n== 环带色（半径 18~22px，棋子的描边/光环）==")
def ring(cx, cy, r0=18, r1=22):
    ys, xs = np.mgrid[cy - r1:cy + r1 + 1, cx - r1:cx + r1 + 1]
    d = np.sqrt((ys - cy) ** 2 + (xs - cx) ** 2)
    m = (d >= r0) & (d <= r1)
    q = a[cy - r1:cy + r1 + 1, cx - r1:cx + r1 + 1][m]
    return q.reshape(-1, 3).astype(float).mean(axis=0)
for nm, ix, iy in [("黑1 H8", 7, 7), ("白2 E11", 4, 4), ("黑3 I9", 8, 6)]:
    c = ring(VX[ix], VY[iy])
    print("  %-10s 环带 rgb=(%3.0f,%3.0f,%3.0f)" % (nm, c[0], c[1], c[2]))

# 特写
for nm, ix, iy in [("H8", 7, 7), ("E11", 4, 4), ("I9", 8, 6)]:
    cx, cy = VX[ix], VY[iy]
    im.crop((cx - 45, cy - 45, cx + 45, cy + 45)).resize((90 * 6, 90 * 6), Image.NEAREST).save(
        r"C:\Users\harve\Desktop\Gobang auto\tools\_shot_stone_%s.png" % nm)
print("\n已导出三张特写：_shot_stone_H8/E11/I9.png")
