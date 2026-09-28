# -*- coding: utf-8 -*-
# step5: 全部棋子质心 -> 权威棋盘 + 可疑点特写
from PIL import Image
import numpy as np, os
from collections import deque

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
OUT = r'C:\Users\harve\Desktop\Gobang auto\tools\_forensics'
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)

GX0, GY0, GAP = 248.0, 169.0, 71.286
# 限制在棋盘木底区域内（bbox 40..1980 x 35..1160，再往内收一圈避免页底黑带）
X0, X1, Y0, Y1 = 200, 1300, 120, 1145
lum = a.mean(axis=2)
blk = (lum < 80)
wht = (a[:,:,0] > 228) & (a[:,:,1] > 218) & (a[:,:,2] > 195)
m0 = np.zeros_like(blk); m0[Y0:Y1, X0:X1] = True
blk &= m0; wht &= m0

def blobs(mask, min_px=400, max_px=20000):
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if seen[y0, x0]: continue
        q = deque([(y0, x0)]); seen[y0, x0] = True; pts = []
        while q:
            y, x = q.popleft(); pts.append((y, x))
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    ny, nx = y+dy, x+dx
                    if Y0 <= ny < Y1 and X0 <= nx < X1 and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; q.append((ny, nx))
        if min_px <= len(pts) <= max_px:
            arr = np.array(pts)
            out.append((float(arr[:,1].mean()), float(arr[:,0].mean()), len(pts)))
    return out

COLS = 'ABCDEFGHIJKLMNO'
def put(board, x, y, v):
    if 0 <= x < 15 and 0 <= y < 15: board[y][x] = v

boardB = [['.' for _ in range(15)] for _ in range(15)]
boardW = [['.' for _ in range(15)] for _ in range(15)]
off_report = []
for color, bl, board in (('B', blobs(blk), boardB), ('W', blobs(wht), boardW)):
    print('%s blobs: %d' % (color, len(bl)))
    for cx, cy, n in sorted(bl, key=lambda t: (t[1], t[0])):
        fx = (cx - GX0) / GAP; fy = (cy - GY0) / GAP
        ix, iy = round(fx), round(fy)
        dx, dy = abs(fx-ix)*GAP, abs(fy-iy)*GAP
        tag = '' if (dx < 8 and dy < 8) else '  <-- OFF-GRID dx=%.1f dy=%.1f' % (dx, dy)
        print('  %s(%d,%d) cx=%.1f cy=%.1f n=%d fx=%.2f fy=%.2f%s' % (color, ix, iy, cx, cy, n, fx, fy, tag))
        if dx < 12 and dy < 12:
            put(board, ix, iy, color)
        else:
            off_report.append((color, cx, cy, n))

print('\nboard B:'); 
for iy in range(15): print('%2d ' % (15-iy) + ' '.join(boardB[iy]))
print('board W:')
for iy in range(15): print('%2d ' % (15-iy) + ' '.join(boardW[iy]))
bn = sum(r.count('B') for r in boardB); wn = sum(r.count('W') for r in boardW)
print('B=%d W=%d -> %s to move' % (bn, wn, 'BLACK' if bn == wn else 'WHITE'))
print('off-grid blobs:', off_report)

# ---- 特写：E6 / H9 / F2 / M12 / L11 ----
def cell_crop(col, row, name, z=6):
    ix = COLS.index(col); iy = 15 - row
    cx, cy = GX0 + ix*GAP, GY0 + iy*GAP
    r = int(GAP*0.75)
    c = im.crop((int(cx-r), int(cy-r), int(cx+r), int(cy+r)))
    c = c.resize((c.width*z, c.height*z), Image.NEAREST)
    c.save(os.path.join(OUT, name)); print('saved', name)
cell_crop('E', 6, 'cell_E6_6x.png')
cell_crop('H', 9, 'cell_H9_6x.png')
cell_crop('F', 2, 'cell_F2_6x.png')
cell_crop('M', 12, 'cell_M12_6x.png')
