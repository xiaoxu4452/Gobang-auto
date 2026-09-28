# -*- coding: utf-8 -*-
"""鲁棒性压力测试：把用户截图做缩放/亮度/对比度扰动后，检查 6 颗子是否都还读得出来。

已知真值（board[y][x]，1=黑 2=白）：
  (5,7)=白 (7,8)=白 (7,10)=白(带红点) (8,7)=黑 (8,9)=黑 (9,8)=黑
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'engine-server', 'python'))

import numpy as np
import cv2
from PIL import Image

from gomoku_assistant import screen_board as sb

IMG = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-19T01-15-43-774Z-e57eef61.jpg"
base = np.asarray(Image.open(IMG).convert("RGB"))
# 面板矩形随缩放走
PANEL0 = (1422, 139, 356, 982)

TRUTH = {(5, 7): 2, (7, 8): 2, (7, 10): 2, (8, 7): 1, (8, 9): 1, (9, 8): 1}


def judge(res):
    got = {}
    for s in (res.get("black") or []):
        got[(s["y"], s["x"])] = 1
    for s in (res.get("white") or []):
        got[(s["y"], s["x"])] = 2
    wrong = [(k, got.get(k), v) for k, v in TRUTH.items() if got.get(k) != v]
    extra = [(k, v) for k, v in got.items() if k not in TRUTH]
    return got, wrong, extra


def run(tag, rgb, panel):
    try:
        res = sb.scan_once(rgb=np.ascontiguousarray(rgb), exclude=[panel] if panel else None)
    except Exception as e:
        print("%-34s EXC %s" % (tag, e))
        return
    d = res.get("diag") or {}
    got, wrong, extra = judge(res)
    ok = res.get("found") and not wrong and not extra
    print("%-34s %s found=%s B=%s W=%s thr=%-6s sigma=%-6s | 漏/错=%s 多=%s"
          % (tag, "OK  " if ok else "FAIL", res.get("found"), d.get("black"), d.get("white"),
             d.get("threshold"), d.get("noise_sigma"),
             [(k, "空" if g is None else {1: "黑", 2: "白"}[g], {1: "黑", 2: "白"}[v])
              for k, g, v in wrong],
             [(k, {1: "黑", 2: "白"}[v]) for k, v in extra]))


print("== 原图/缩放 ==")
for sc in (1.0, 0.85, 0.70, 0.55, 0.40, 1.15):
    if sc == 1.0:
        img = base
    else:
        img = cv2.resize(base, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
    p = tuple(int(round(v * sc)) for v in PANEL0)
    run("scale=%.2f %dx%d" % (sc, img.shape[1], img.shape[0]), img, p)

print("\n== 亮度/对比扰动（原尺度）==")
for k in (0.75, 0.85, 0.95, 1.05, 1.15, 1.3):
    img = np.clip(base.astype(np.float32) * k, 0, 255).astype(np.uint8)
    run("brightness x%.2f" % k, img, PANEL0)
for k in (0.6, 0.8, 1.2):
    img = np.clip((base.astype(np.float32) - 128) * k + 128, 0, 255).astype(np.uint8)
    run("contrast x%.2f" % k, img, PANEL0)

print("\n== 无 JPEG 噪声（PNG 重编码）/ 轻微模糊 ==")
run("png (no jpeg noise)", base, PANEL0)
run("gauss blur 3x3", cv2.GaussianBlur(base, (3, 3), 0), PANEL0)
run("gauss blur 5x5", cv2.GaussianBlur(base, (5, 5), 0), PANEL0)

print("\n== 模拟更亮的木棋盘底色（拟真白子更难认）==")
for lift in (10, 20, 30):
    img = base.astype(np.float32)
    g = 0.299 * img[:, :, 0] + 0.587 * img[:, :, 1] + 0.114 * img[:, :, 2]
    m = (g > 150)[:, :, None]                      # 只抬亮「木底 + 白子」那一档
    img = np.where(m, img + lift, img)
    run("light-board +%d" % lift, np.clip(img, 0, 255).astype(np.uint8), PANEL0)
