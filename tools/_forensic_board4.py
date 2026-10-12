# -*- coding: utf-8 -*-
# 取证 step4: 绿色十字标记定位 + 吸附到网格
from PIL import Image
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
im = Image.open(p).convert("RGB")
W, H = im.size
px = im.load()
VX = [337.0 + 71.286*i for i in range(15)]
HY = [123.5 + 71.25*i for i in range(15)]
# 绿掩膜（只找棋盘范围内）
pts = []
for y in range(60, 1190, 2):
    for x in range(129, 1990, 2):
        r, g, b = px[x, y]
        if g > 140 and g - r > 45 and g - b > 45:
            pts.append((x, y))
print("green px:", len(pts))
# 聚类
clusters = []
for (x, y) in pts:
    placed = False
    for c in clusters:
        if abs(x - c[0]/c[2]) < 40 and abs(y - c[1]/c[2]) < 40:
            c[0] += x; c[1] += y; c[2] += 1; placed = True; break
    if not placed:
        clusters.append([x, y, 1])
print("clusters:")
for (sx, sy, n) in clusters:
    cx, cy = sx/n, sy/n
    # 吸附
    import math
    gi = min(range(15), key=lambda i: abs(VX[i]-cx))
    gj = min(range(15), key=lambda j: abs(HY[j]-cy))
    dx, dy = cx - VX[gi], cy - HY[gj]
    print("  (%.0f,%.0f) n=%d -> %s%d off=(%.1f,%.1f)" % (cx, cy, n, "ABCDEFGHJKLMNOP"[gi], 15-gj, dx, dy))
