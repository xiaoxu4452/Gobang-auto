# -*- coding: utf-8 -*-
"""探针：白子+光标十字 截图的原始灰度证据（对齐 gbadaptive.cpp 的采样口径）"""
import sys, math
import numpy as np
import cv2

IMG = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-10-03T14-53-30-256Z-d3fe7b69.png"

gray = cv2.imread(IMG, cv2.IMREAD_GRAYSCALE)
bgr = cv2.imread(IMG)
hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
sat = hsv[:, :, 1]

# scan 输出的几何
x_lines = [49.57392487751769, 97.9286878196714, 145.48865833899544, 193.61209883296863, 241.5070454340168, 289.8125205524498, 337.9336263974818, 385.3663711413061, 433.73694874851014, 481.871883570182, 528.3419509489282, 575.9385704230859, 624.0130112847531, 671.978511565538, 719.647733206741]
y_lines = [43.91347742098043, 91.47573676901713, 139.47666494988312, 187.10610850064074, 235.81014579503184, 283.2254460761093, 331.34321553551183, 379.54101190895636, 427.0705675364944, 475.15717046772323, 523.8577592675972, 572.4114035570728, 620.7151497968056, 667.6516307457563, 715.9200563204005]
spacing = 48.06107838327087

h, w = gray.shape
bx0, bx1 = int(x_lines[0]), min(w-1, int(x_lines[-1]))
by0, by1 = int(y_lines[0]), min(h-1, int(y_lines[-1]))
boardMed = float(np.median(gray[by0:by1+1, bx0:bx1+1]))
boardSat = float(np.median(sat[by0:by1+1, bx0:bx1+1]))
satGate = max(28.0, boardSat * 0.5)
print("boardMed=%.1f boardSat=%.1f satGate=%.1f" % (boardMed, boardSat, satGate))

def med_disc(ax, ay, rfrac):
    rr = max(2, int(round(spacing * rfrac)))
    vals = []
    for dy in range(-rr, rr+1):
        gy = ay + dy
        if gy < 0 or gy >= h: continue
        dxlim = int(math.sqrt(rr*rr - dy*dy))
        for dx in range(-dxlim, dxlim+1):
            gx = ax + dx
            if gx < 0 or gx >= w: continue
            vals.append(gray[gy, gx])
    return float(np.median(vals)), vals

def med_ring(ax, ay, r0f, r1f):
    r0 = int(round(spacing*r0f)); r1 = max(3, int(round(spacing*r1f)))
    if r0 >= r1: r0 = r1 - 1
    vals = []
    for dy in range(-r1, r1+1):
        gy = ay + dy
        if gy < 0 or gy >= h: continue
        for dx in range(-r1, r1+1):
            gx = ax + dx
            if gx < 0 or gx >= w: continue
            rad = math.hypot(dx, dy)
            if rad < r0 or rad > r1: continue
            vals.append(gray[gy, gx])
    return float(np.median(vals)), vals

def sat_disc(ax, ay, rfrac):
    rr = max(2, int(round(spacing * rfrac)))
    vals = []
    for dy in range(-rr, rr+1):
        gy = ay + dy
        if gy < 0 or gy >= h: continue
        dxlim = int(math.sqrt(rr*rr - dy*dy))
        for dx in range(-dxlim, dxlim+1):
            gx = ax + dx
            if gx < 0 or gx >= w: continue
            vals.append(sat[gy, gx])
    return float(np.median(vals))

def sat_ring(ax, ay, r0f, r1f):
    r0 = int(round(spacing*r0f)); r1 = max(3, int(round(spacing*r1f)))
    vals = []
    for dy in range(-r1, r1+1):
        gy = ay + dy
        if gy < 0 or gy >= h: continue
        for dx in range(-r1, r1+1):
            gx = ax + dx
            if gx < 0 or gx >= w: continue
            rad = math.hypot(dx, dy)
            if rad < r0 or rad > r1: continue
            vals.append(sat[gy, gx])
    return float(np.median(vals))

cells = {"white+cross(6,8)": (338, 427), "black(7,7)": (385, 380)}
for name, (ax, ay) in cells.items():
    coreRaw, coreVals = med_disc(ax, ay, 0.18)
    shellRaw, shellVals = med_ring(ax, ay, 0.30, 0.42)
    # rawRefine WHITE 路径的暗描边证据：0.34~0.44 环 p25
    r0i = int(round(spacing*0.34)); r1i = int(round(spacing*0.44))
    rimvals = []
    for dy in range(-r1i, r1i+1):
        gy = ay + dy
        if gy < 0 or gy >= h: continue
        for dx in range(-r1i, r1i+1):
            gx = ax + dx
            if gx < 0 or gx >= w: continue
            rad = math.hypot(dx, dy)
            if rad < r0i or rad > r1i: continue
            rimvals.append(gray[gy, gx])
    p25 = float(np.percentile(rimvals, 25))
    coreSat = sat_disc(ax, ay, 0.24)
    shellSat = sat_ring(ax, ay, 0.30, 0.42)
    coreArr = np.array(coreVals, dtype=float)
    print("\n== %s ==" % name)
    print("  coreRaw(0.18disc med)=%.1f  (%.3f x boardMed)" % (coreRaw, coreRaw/boardMed))
    print("  shellRaw(0.30-0.42 med)=%.1f  (%.3f x boardMed)" % (shellRaw, shellRaw/boardMed))
    print("  rim 0.34-0.44: p25=%.1f (%.3f x boardMed)  p10=%.1f  min=%.0f" % (p25, p25/boardMed, np.percentile(rimvals,10), min(rimvals)))
    print("  coreSat=%.1f shellSat=%.1f" % (coreSat, shellSat))
    print("  core disc: p10=%.1f p25=%.1f p75=%.1f p90=%.1f max=%.0f" % tuple(np.percentile(coreArr, [10,25,75,90,100])))
    fracBright = float((coreArr > boardMed*1.05).mean())
    fracDark = float((coreArr < boardMed*0.75).mean())
    print("  core: frac>1.05x board=%.2f frac<0.75x board=%.2f" % (fracBright, fracDark))
