# -*- coding: utf-8 -*-
"""找白子质心（不能用纯白判据）+ 打印指定格子的原始统计。"""
import sys
from PIL import Image
import numpy as np

p = sys.argv[1]
im = Image.open(p).convert("RGB")
a = np.asarray(im)
r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)

VX = [481, 529, 578, 627, 675, 724, 773, 821, 869, 918, 967, 1015, 1064, 1113, 1161]
VY = [213, 261, 310, 359, 407, 456, 505, 553, 601, 650, 699, 747, 796, 845, 893]
COL = "ABCDEFGHIJKLMNO"

# 亮色掩膜：亮度高 + 接近中性（白子比木色亮得多，且 r≈g≈b）
lum = 0.299 * r + 0.587 * g + 0.114 * b
mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
sat = mx - mn
m = (lum > 205) & (sat < 45)
# 只在棋盘范围内
m[:161, :] = False; m[946:, :] = False; m[:, :429] = False; m[:, 1214:] = False
ys, xs = np.nonzero(m)
print("亮中性像素数 =", m.sum())
if m.sum():
    # 简单连通聚类（按网格粗分）
    pts = list(zip(xs.tolist(), ys.tolist()))
    used = [False] * len(pts); clusters = []
    import collections
    grid = collections.defaultdict(list)
    for i, (x, y) in enumerate(pts): grid[(x // 8, y // 8)].append(i)
    for i in range(len(pts)):
        if used[i]: continue
        stack = [i]; used[i] = True; comp = []
        while stack:
            j = stack.pop(); comp.append(pts[j])
            x, y = pts[j]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for k in grid.get((x // 8 + dx, y // 8 + dy), []):
                        if not used[k]:
                            used[k] = True; stack.append(k)
        if len(comp) >= 60: clusters.append(comp)
    clusters.sort(key=len, reverse=True)
    for c in clusters[:6]:
        cx = sum(q[0] for q in c) / len(c); cy = sum(q[1] for q in c) / len(c)
        ix = min(range(15), key=lambda i: abs(VX[i] - cx))
        iy = min(range(15), key=lambda i: abs(VY[i] - cy))
        print("  簇 n=%d 质心(%.1f,%.1f) → 吸附 %s%d   x偏差=%.1f y偏差=%.1f  rgb均值=%s" % (
            len(c), cx, cy, COL[ix], 15 - iy, cx - VX[ix], cy - VY[iy],
            tuple(int(v) for v in a[int(cy) - 5:int(cy) + 5, int(cx) - 5:int(cx) + 5].reshape(-1, 3).mean(axis=0))))

print("\n== 指定格子原始统计（找那颗没被认出的子）==")
for name, ix, iy in [("E11", 4, 4), ("F11", 5, 4), ("F12", 5, 3), ("E12", 4, 3), ("G11", 6, 4), ("G10", 6, 5), ("F10", 5, 5), ("D11", 3, 4)]:
    cx, cy = VX[ix], VY[iy]
    q = a[cy - 15:cy + 15, cx - 15:cx + 15].reshape(-1, 3).astype(float)
    print("  %s%d  rgb=(%.0f,%.0f,%.0f) lum=%.0f" % (name[0], 15 - iy, q[:, 0].mean(), q[:, 1].mean(), q[:, 2].mean(), q.mean()))
