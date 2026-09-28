# -*- coding: utf-8 -*-
# step4: 正确网格(248,169,71.286)逐格分类 + 面板特写
from PIL import Image
import numpy as np, os

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
OUT = r'C:\Users\harve\Desktop\Gobang auto\tools\_forensics'
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)

GX0, GY0, GAP = 248.0, 169.0, 71.286
VX = [GX0 + i*GAP for i in range(15)]
HY = [GY0 + j*GAP for j in range(15)]

def patch(cx, cy, r):
    x0, x1 = max(0, int(cx-r)), min(W, int(cx+r+1))
    y0, y1 = max(0, int(cy-r)), min(H, int(cy+r+1))
    return a[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)

R = int(GAP*0.30)
board = [['.' for _ in range(15)] for _ in range(15)]
unknown = []
for iy in range(15):
    for ix in range(15):
        m = patch(VX[ix], HY[iy], R)
        r, g, b = m; lum = m.mean()
        if r - g > 80 and g < 160 and r > 180:
            board[iy][ix] = 'R'                    # 红标（最后一手标记）
        elif g - r > 40 and g - b > 30 and g > 120:
            board[iy][ix] = 'G'                    # 绿十字（面板推荐点）
        elif lum < 95:
            board[iy][ix] = 'B'
        elif r > 225 and g > 215 and b > 195:
            board[iy][ix] = 'W'
        else:
            d = abs(r-240)+abs(g-176)+abs(b-96)
            board[iy][ix] = '.' if d < 100 else '?'
            if board[iy][ix] == '?': unknown.append((ix, iy, [round(v) for v in m]))

COLS = 'ABCDEFGHIJKLMNO'
print('   ' + ' '.join(COLS))
for iy in range(15):
    print('%2d ' % (15-iy) + ' '.join(board[iy]))
bn = sum(r.count('B') for r in board); wn = sum(r.count('W') for r in board)
print('black=%d white=%d total=%d  bn-wn=%d -> %s to move' %
      (bn, wn, bn+wn, bn-wn, 'BLACK' if bn==wn else 'WHITE'))
print('unknown cells:', unknown)

# 红标所在格（最后一手标记位置）
reds = [(ix, iy) for iy in range(15) for ix in range(15) if board[iy][ix]=='R']
print('red marks:', [(COLS[x]+str(15-y)) for x, y in reds])
greens = [(ix, iy) for iy in range(15) for ix in range(15) if board[iy][ix]=='G']
print('green marks:', [(COLS[x]+str(15-y)) for x, y in greens])

# ---- 面板特写：状态行 / chips 行 / 我执行 ----
def crop_zoom(box, name, z=3):
    c = im.crop(box)
    c = c.resize((c.width*z, c.height*z), Image.LANCZOS)
    c.save(os.path.join(OUT, name))
    print(name, c.size)

# 面板大致 x 2060..2516（2516*0.82=2063）
crop_zoom((2050, 880, 2516, 990), 'panel_status_3x.png')    # 状态行区域（缩略图 y~360-390）
crop_zoom((2050, 960, 2516, 1120), 'panel_chips_3x.png')     # chips 行 + 评估行
crop_zoom((2050, 590, 2516, 780), 'panel_side_3x.png')       # 我执 行
crop_zoom((2050, 100, 2516, 590), 'panel_top_2x.png')        # 面板上半（思烤时间等）
