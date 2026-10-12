# -*- coding: utf-8 -*-
# step7: 量化网格线位置（避开棋子的中轴带 + 全宽剖面）
from PIL import Image
import numpy as np

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)
lum = a.mean(axis=2)

# 木色参考（棋盘内部空点 (300,300) 附近）
wood = a[280:320, 280:320].reshape(-1,3).mean(axis=0)
print('wood ref:', wood.round(1), 'lum', wood.mean().round(1))

# 横线：对每个 y，统计 x in [255,1240] 中暗像素占比（线=比木暗>=28）
xs = slice(255, 1240)
dark = (lum[:, xs] < wood.mean() - 28)
rowfrac = dark.mean(axis=1)
# 竖线：对每个 x，统计 y in [105,1160]
ys2 = slice(105, 1160)
darkc = (lum[ys2, :] < wood.mean() - 28)
colfrac = darkc.mean(axis=0)

def peaks(frac, thr, lo, hi):
    idx = [i for i in range(lo, hi) if frac[i] > thr]
    g = []
    for i in idx:
        if g and i - g[-1][-1] <= 4: g[-1].append(i)
        else: g.append([i])
    return [(sum(x)/len(x), max(frac[xx] for xx in x)) for x in g]

rp = peaks(rowfrac, 0.35, 40, 1260)
cp = peaks(colfrac, 0.35, 40, 1450)
print('horizontal line candidates (y, strength):')
for p in rp: print('   y=%.1f  %.2f' % p)
print('vertical line candidates (x, strength):')
for p in cp: print('   x=%.1f  %.2f' % p)
