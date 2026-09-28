# -*- coding: utf-8 -*-
# step2: 重建网格 + 逐格分类 + 输出真盘 + 裁剪面板细节
from PIL import Image
import numpy as np, os

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
OUT = r'C:\Users\harve\Desktop\Gobang auto\tools\_forensics'
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)

# ---- 网格重建：VX[0]=208, gap=71.29（15 条竖线实测）；横线按同 gap 重建 ----
GX0, GY0, GAP = 208.0, 135.0, 71.286
VX = [GX0 + i*GAP for i in range(15)]
HY = [GY0 + i*GAP for i in range(15)]

def patch(cx, cy, r):
    x0, x1 = max(0, int(cx-r)), min(W, int(cx+r+1))
    y0, y1 = max(0, int(cy-r)), min(H, int(cy+r+1))
    return a[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)

R = int(GAP*0.30)
wood = np.array([240, 176, 96])

board = [['.' for _ in range(15)] for _ in range(15)]
extras = []   # 红标 / 绿标
for iy in range(15):
    for ix in range(15):
        cx, cy = VX[ix], HY[iy]
        m = patch(cx, cy, R)
        lum = m.mean()
        r, g, b = m
        # 距木色的色差
        dwood = abs(r-wood[0]) + abs(g-wood[1]) + abs(b-wood[2])
        if r - g > 55 and r - b > 60 and r > 180 and g < 185:
            board[iy][ix] = 'R'   # 红标（最后一手标记/禁手）
            extras.append(('RED', ix, iy, m.round(0).tolist()))
        elif g - r > 40 and g - b > 30:
            board[iy][ix] = 'G'   # 绿标（推荐点）
            extras.append(('GREEN', ix, iy, m.round(0).tolist()))
        elif lum < 95:
            board[iy][ix] = 'B'   # 黑子
        elif r > 225 and g > 215 and b > 195:
            board[iy][ix] = 'W'   # 白子
        elif dwood < 90:
            board[iy][ix] = '.'   # 空
        else:
            board[iy][ix] = '?'   # 半透明覆盖层等
print('    ' + ' '.join('ABCDEFGHI'.rstrip().ljust(1) for _ in range(0)) + '  A B C D E F G H I J K L M N O')
for iy in range(15):
    rowno = 15 - iy
    print('%2d  ' % rowno + ' '.join(board[iy]))
bn = sum(r.count('B') for r in board); wn = sum(r.count('W') for r in board)
print('black=%d white=%d total=%d' % (bn, wn, bn+wn))
print('parity: bn-wn=%d -> %s to move (1=black 2=white)' % (bn-wn, 1 if bn==wn else 2))
print('extras:', extras)

# ---- 裁剪面板（右侧）并放大 2x：整块 + 状态行/chips 特写 ----
panel = im.crop((int(W*0.80), 0, W, H))
panel = panel.resize((panel.width*2, panel.height*2), Image.LANCZOS)
panel.save(os.path.join(OUT, 'panel_2x.png'))
print('panel crop saved:', panel.size)
