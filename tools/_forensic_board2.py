# -*- coding: utf-8 -*-
# 取证 step2: 木色掩膜定位棋盘 + 网格线探测
from PIL import Image
import os
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
im = Image.open(p).convert("RGB")
W, H = im.size
px = im.load()

# 木色掩膜（紧容差）
def is_wood(c):
    r, g, b = c
    return abs(r-240) <= 28 and abs(g-176) <= 28 and abs(b-96) <= 30

xs = []
ys = []
for y in range(0, H, 3):
    for x in range(0, W, 3):
        if is_wood(px[x, y]):
            xs.append(x); ys.append(y)
x0, x1 = min(xs), max(xs)
y0, y1 = min(ys), max(ys)
print("wood bbox:", x0, y0, x1, y1, " w=", x1-x0, " h=", y1-y0)

# 网格线 = 比木色暗的细线。在 bbox 内逐列/逐行统计"暗线"像素
def is_line(c):
    r, g, b = c
    # 比木色暗且不太彩
    return 120 < r < 215 and 80 < g < 150 and b < 120 and r > g > b

colcnt = []
for x in range(x0, x1+1):
    n = 0
    for y in range(y0, y1+1):
        if is_line(px[x, y]): n += 1
    colcnt.append((x, n))
rowcnt = []
for y in range(y0, y1+1):
    n = 0
    for x in range(x0, x1+1):
        if is_line(px[x, y]): n += 1
    rowcnt.append((y, n))

def peaks(cnt, span):
    thr = span * 0.45
    pk = [pos for (pos, n) in cnt if n > thr]
    # 合并相邻
    merged = []
    for v in pk:
        if merged and v - merged[-1][-1] <= 3: merged[-1].append(v)
        else: merged.append([v])
    return [sum(g)/len(g) for g in merged]

vx = peaks(colcnt, y1-y0)
hy = peaks(rowcnt, x1-x0)
print("v lines:", len(vx), vx)
print("h lines:", len(hy), hy)
if len(vx) >= 2:
    print("gap x:", [round(vx[i+1]-vx[i],1) for i in range(len(vx)-1)])
