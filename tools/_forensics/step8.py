# -*- coding: utf-8 -*-
# step8: 复刻 rawRefine/rawClassify 公式，定位 E5 被拒的确切条件
from PIL import Image
import numpy as np

SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(np.float64)
H, W = a.shape[:2]
# OpenCV RGB2GRAY
gray = 0.299*a[:,:,0] + 0.587*a[:,:,1] + 0.114*a[:,:,2]
sat = a.max(axis=2) - a.min(axis=2)

# 真实网格（线检测裁决）：x0=248, y0=99, gap≈71.2
GX0, GY0, GAP = 248.0, 99.0, 71.2
ax, ay = int(round(GX0 + 4*GAP)), int(round(GY0 + 10*GAP))   # E5
print('E5 center:', ax, ay)

# boardMed / boardSat（网格包围盒内）
bx0, bx1, by0, by1 = 248, 1246, 99, 1096
gm = gray[by0:by1+1, bx0:bx1+1].ravel()
sm = sat[by0:by1+1, bx0:bx1+1].ravel()
boardMed = float(np.median(gm)); boardSat = float(np.median(sm))
satGate = max(28.0, boardSat*0.5)
print('boardMed=%.1f boardSat=%.1f satGate=%.1f' % (boardMed, boardSat, satGate))

def med_disc(rfrac):
    rr = int(GAP*rfrac)
    yy, xx = np.mgrid[-rr:rr+1, -rr:rr+1]
    m = xx*xx+yy*yy <= rr*rr
    v = gray[ay-rr:ay+rr+1, ax-rr:ax+rr+1][m]
    return float(np.median(v)), v

def med_ring(r0f, r1f, arr='gray'):
    r0, r1 = int(GAP*r0f), int(GAP*r1f)
    src = gray if arr=='gray' else sat
    yy, xx = np.mgrid[-r1:r1+1, -r1:r1+1]
    rad = np.sqrt(xx*xx+yy*yy)
    m = (rad>=r0)&(rad<=r1)
    v = src[ay-r1:ay+r1+1, ax-r1:ax+r1+1][m]
    return float(np.median(v)), v

coreRaw, _ = med_disc(0.18)
shellRaw, _ = med_ring(0.30, 0.42)
satDisc, _ = med_disc(0.24) if False else (None,None)
# rawSatDisc 用 sat 图
def med_disc_sat(rfrac):
    rr = int(GAP*rfrac)
    yy, xx = np.mgrid[-rr:rr+1, -rr:rr+1]
    m = xx*xx+yy*yy <= rr*rr
    v = sat[ay-rr:ay+rr+1, ax-rr:ax+rr+1][m]
    return float(np.median(v)), v
satD, _ = med_disc_sat(0.24)
satR, _ = med_ring(0.30, 0.42, 'sat')
print('coreRaw(0.18)=%.1f  shellRaw(0.30-0.42)=%.1f' % (coreRaw, shellRaw))
print('satDisc(0.24)=%.1f  satRing=%.1f' % (satD, satR))

# rawRefine WHITE 分支第一步：环带 0.34~0.44 最暗四分位
r0i, r1i = int(GAP*0.34), int(GAP*0.44)
yy, xx = np.mgrid[-r1i:r1i+1, -r1i:r1i+1]
rad = np.sqrt(xx*xx+yy*yy)
m = (rad>=r0i)&(rad<=r1i)
band = gray[ay-r1i:ay+r1i+1, ax-r1i:ax+r1i+1][m]
p25 = float(np.percentile(band, 25))
print('rim band p25=%.1f  vs boardMed*0.80=%.1f  -> %s' % (p25, boardMed*0.80, 'NO-DARK-RIM branch' if p25 > boardMed*0.80 else 'has dark rim'))
print('coreRaw > boardMed*1.12 = %.1f ? %s' % (boardMed*1.12, coreRaw > boardMed*1.12))
print('rawClassify: shell>med*1.06=%.1f(%s) core>med*0.60=%.1f(%s) satD<gate(%s) satR<gate(%s)' % (
    boardMed*1.06, shellRaw > boardMed*1.06, boardMed*0.60, coreRaw > boardMed*0.60,
    satD < satGate, satR < satGate))

# 各环带/核心的灰度直方概览（判断红色方块的实际覆盖）
rr = int(GAP*0.18)
print('core disc r=%d: red-ish px(frac with sat>72) = %.2f' % (rr, float((sat[ay-rr:ay+rr+1, ax-rr:ax+rr+1]>72).mean())))
