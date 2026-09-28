# -*- coding: utf-8 -*-
# step3: 直接聚类黑/白棋子质心 -> 反推网格
from PIL import Image
import numpy as np

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)
BOARD_X1 = 1450   # 棋盘右界（面板之前）
lum = a.mean(axis=2)

# 黑子：很暗
blk = (lum < 80)
blk[:, BOARD_X1:] = False
# 白子：很亮且非蓝底面板（右侧面板底是浅蓝/白 -> 限棋盘区 + 饱和度低不充分，直接限 x）
wht = (a[:,:,0] > 228) & (a[:,:,1] > 222) & (a[:,:,2] > 200)
wht[:, BOARD_X1:] = False

# 连通域（简易 BFS）
def blobs(mask, min_px=120):
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    ys, xs = np.where(mask)
    coords = set(zip(ys.tolist(), xs.tolist()))
    from collections import deque
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if seen[y0, x0]: continue
        q = deque([(y0, x0)]); seen[y0, x0] = True
        pts = []
        while q:
            y, x = q.popleft(); pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y+dy, x+dx
                    if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; q.append((ny, nx))
        if len(pts) >= min_px:
            arr = np.array(pts)
            out.append((arr[:,1].mean(), arr[:,0].mean(), len(pts)))  # cx, cy, n
    return out

bb = blobs(blk); wb = blobs(wht)
print('black blobs:', len(bb))
for c in sorted(bb, key=lambda t:-t[2])[:5]: print('  cx=%.1f cy=%.1f n=%d' % c)
print('white blobs:', len(wb))
for c in sorted(wb, key=lambda t:-t[2])[:5]: print('  cx=%.1f cy=%.1f n=%d' % c)

# 与假设网格(208 + i*71.286 / 135 + j*71.286)对齐：输出每 blob 最近交点与偏差
GAP = 71.286
def fit(blobs):
    res = []
    for cx, cy, n in blobs:
        fx = (cx - 208.0) / GAP; fy = (cy - 135.0) / GAP
        res.append((round(fx,2), round(fy,2), cx, cy, n))
    return res
print('black fractional grid coords (fx, fy):')
for t in sorted(fit(bb), key=lambda t:(t[1],t[0])): print('  ', t)
