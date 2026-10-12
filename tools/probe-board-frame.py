# -*- coding: utf-8 -*-
"""直接量：外框线到真棋盘第一条线的距离 == 多少格？

做法：投影里按「与相邻峰间距一致」把峰聚类成一条等距线族（真棋盘 15 条），
剩下的孤立峰就是外框/UI 线；量它们到线族两端的距离（以格为单位）。
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'engine-server', 'python'))
import numpy as np
import cv2
from PIL import Image
from gomoku_assistant import screen_board as sb
from gomoku_assistant import detector

IMG = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-19T01-15-43-774Z-e57eef61.jpg"
PANEL0 = (1422, 139, 356, 982)
base = np.asarray(Image.open(IMG).convert("RGB"))


def peaks_of(proj, origin, pct=97.0):
    thr = float(np.percentile(proj, pct))
    idx = np.where(proj >= thr)[0]
    groups = []
    for i in idx:
        if groups and i - groups[-1][-1] <= 3:
            groups[-1].append(i)
        else:
            groups.append([i])
    return np.array([float(np.mean(g)) + origin for g in groups])


def best_run(peaks, n=15):
    """在 peaks 里找连续 n 个、等距最规整的一段。"""
    best, best_cv = None, 1e9
    for i in range(0, len(peaks) - n + 1):
        seg = peaks[i:i + n]
        sp = np.diff(seg)
        cv = float(np.std(sp) / max(np.mean(sp), 1e-6))
        if cv < best_cv:
            best_cv, best = cv, seg
    return best, best_cv


for sc in (1.0, 0.85):
    img = base if sc == 1.0 else cv2.resize(base, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
    p = tuple(int(round(v * sc)) for v in PANEL0)
    img = np.ascontiguousarray(img)
    res = sb.scan_once(rgb=img, exclude=[p])
    geo = res["geometry"]
    xl = np.asarray(geo["x_lines"], float); yl = np.asarray(geo["y_lines"], float)
    det_sx = (xl[-1] - xl[0]) / 14; det_sy = (yl[-1] - yl[0]) / 14

    cand = sb.find_board_rect(cv2.cvtColor(np.ascontiguousarray(sb._mask_excluded(img, [p], (0, 0))),
                                           cv2.COLOR_RGB2GRAY), line_count=15)
    step = cand["step"]; x0, y0, x1, y1 = cand["rect"]
    pad = step * 1.5
    ax0 = max(0, int(x0 - pad)); ay0 = max(0, int(y0 - pad))
    ax1 = min(img.shape[1], int(x1 + pad)); ay1 = min(img.shape[0], int(y1 + pad))
    gray = cv2.cvtColor(img[ay0:ay1, ax0:ax1], cv2.COLOR_RGB2GRAY)
    cproj = detector._axis_projection(gray, 0); rproj = detector._axis_projection(gray, 1)
    pc = peaks_of(cproj, ax0); pr = peaks_of(rproj, ay0)

    print("=== scale=%.2f   cand.rect=%s  cand.step=%.1f" % (sc, [round(float(v), 1) for v in cand["rect"]], step))
    print("   detected  x0=%.1f sx=%.2f | y0=%.1f sy=%.2f" % (xl[0], det_sx, yl[0], det_sy))
    for tag, pk, det, s in (("列", pc, xl, det_sx), ("行", pr, yl, det_sy)):
        run, cvv = best_run(pk, 15)
        print("   %s 峰 %d 个: %s" % (tag, len(pk), np.round(pk, 1)))
        if run is None:
            continue
        print("      最规整的 15 连段: %s (间距CV=%.4f, 步=%.2f)"
              % (np.round(run, 1), cvv, (run[-1] - run[0]) / 14))
        inside = [q for q in pk if run[0] - 3 <= q <= run[-1] + 3]
        outside = [q for q in pk if q < run[0] - 3 or q > run[-1] + 3]
        srun = (run[-1] - run[0]) / 14
        print("      段外孤立峰: %s" % np.round(outside, 1))
        for q in outside:
            off = (q - run[0]) / srun
            print("         %.1f  -> 相对段首 %.3f 格" % (q, off))
        # 检测出的点阵 == 段 还是 段±1
        print("      detected 锚点=%.1f  段首=%.1f  差=%.2f 格"
              % (det[0], run[0], (det[0] - run[0]) / srun))
    print()
