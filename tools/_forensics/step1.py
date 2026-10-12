# -*- coding: utf-8 -*-
# 截图取证：还原真盘局面 + 面板细节裁剪
from PIL import Image
import numpy as np, os

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
OUT = r'C:\Users\harve\Desktop\Gobang auto\tools\_forensics'
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.int32)
print('size:', W, H)

# ---- 1) 定位棋盘：木色掩膜（自适应取样：图左侧 30%,55% 处应为棋盘木底） ----
wood = a[int(H*0.55), int(W*0.25)].copy()
print('wood sample @(.25W,.55H):', wood)
dr = np.abs(a[:,:,0]-wood[0]); dg = np.abs(a[:,:,1]-wood[1]); db = np.abs(a[:,:,2]-wood[2])
mask = (dr<45)&(dg<45)&(db<45)
ys, xs = np.where(mask)
x0b, x1b, y0b, y1b = xs.min(), xs.max(), ys.min(), ys.max()
print('wood bbox:', x0b, x1b, y0b, y1b, ' w=', x1b-x0b, ' h=', y1b-y0b)

# ---- 2) 探测网格线：比木色暗一档的细线 ----
sub = a[y0b:y1b+1, x0b:x1b+1]
lum = sub.mean(axis=2)
wood_lum = float(wood.mean())
dark = lum < (wood_lum - 28)
colcnt = dark.sum(axis=0) / dark.shape[0]
rowcnt = dark.sum(axis=1) / dark.shape[1]

def peaks(cnt, thr=0.45):
    idx = [i for i, v in enumerate(cnt) if v > thr]
    groups = []
    for i in idx:
        if groups and i - groups[-1][-1] <= 3: groups[-1].append(i)
        else: groups.append([i])
    return [sum(g)/len(g) for g in groups]

VX = peaks(colcnt); HY = peaks(rowcnt)
print('vertical lines:', len(VX), VX[:3], '...', VX[-3:] if len(VX)>3 else '')
print('horizontal lines:', len(HY), HY[:3], '...', HY[-3:] if len(HY)>3 else '')
if len(VX) >= 2:
    dv = np.diff(VX); print('gapX: mean=%.2f min=%.2f max=%.2f' % (dv.mean(), dv.min(), dv.max()))
if len(HY) >= 2:
    dh = np.diff(HY); print('gapY: mean=%.2f min=%.2f max=%.2f' % (dh.mean(), dh.min(), dh.max()))
