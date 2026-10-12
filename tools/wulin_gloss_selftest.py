# -*- coding: utf-8 -*-
"""「拟真光泽棋子」识别基准（五林五子棋现场截图）
================================================

基准图：``tools/fixtures/wulin_gloss_board.jpg``（用户现场截图裁到只剩棋盘）。

棋子的「光泽」到底给识别制造了什么麻烦 —— 这份自测把数字钉住：

  1. **白子没有边**。实测径向剖面（相对局部底色的灰度差）：

         r=0.00 → +35     r=0.26 → +30     r=0.34 → +16
         r=0.40 →  +3     r=0.44 →  -1     r=0.50 →  -1

     棋子中心比木底亮 ~35 灰阶，但**一路渐隐到底色**：到半径 0.44 格（棋子外沿）
     对比度已经归零。也就是说「棋子 vs 底色」这条常规线索在最需要它的地方消失了。

  2. **全局阈值够不着白子**。这张木纹照片盘的噪声 σ≈17.8 → ``thr = 4σ ≈ 71``，
     而白子内部最大的偏离只有 ~52 → 白子**整体落在全局阈值之下**。
     若只有全局阈值，两颗白子会直接消失。

  3. **救回来的是「逐格中位数」这条路**：``lc = 内盘中位数 − 格子四角中位数``，
     实测白子 lc = +25~+34，而**所有空点 |lc| ≤ 9**  → 余量 ≈ 2.8 倍。
     它只放宽**本格**阈值（``thr_cell = |lc| × 0.45``），不碰别的格。

  4. **黑子毫无压力**：lc ≈ −188，内部 99% 像素都低于 −thr。光泽的高光对黑子
     反而是「更亮的一块」，仍远低于底色，不构成威胁。

  5. **最后一手的红点**在 (10,6) 那颗白子上：红点灰度 ~81（远暗于白子 236），
     它若盖住内盘中心会把判色翻成黑子。实测它只占内盘 ~6%，内盘中位数仍是 +34，
     所以判色不受影响 —— 这条也钉住，防止以后有人把 ``CORE_R`` 调大。

  6. **真值为什么是「现在这套行列」**（2026-09-19 修正，勿再改回去）：
     棋盘木底最外圈还有一条**装饰外框线**，它落在真格线外侧 **~0.87 格**处
     （实测：原图行轴外框在 y=73.5，第一条**可落子**格线在 y=143.5；列轴 72.5 vs 142.5）。
     外框线与真格线的间距（≈70px）和格距（≈80.7px）不一样，所以它**不属于**那 15 条
     等距线族（15 连段间距 CV≈0.004，掺进外框立刻变 0.03+）。
     老实现会把外框当成第 0 行 → 整盘**每颗子的行号都差 1**。
     放大到像素级看：外框线正落在木板的**外沿**上，第一条格线才是竖线开始的地方。
     本基准的真值行列按**可落子格线**算。

所以本自测断言两件事：**结果对**（6 子、位置与颜色全中、不 suspect），
以及**机理没退**（白子靠逐格路径而非全局阈值；``CELL_CONTRAST_MIN`` 仍卡在空点之上）。
把 ``CELL_CONTRAST_MIN`` 往下调、或把 ``CORE_R`` 往上调，这里都会立刻变红。
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'engine-server', 'python'))

import numpy as np
import cv2
from PIL import Image

from gomoku_assistant import adaptive as ad
from gomoku_assistant import screen_board as sb

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, 'fixtures', 'wulin_gloss_board.jpg')

# 真值（列 x, 行 y → 黑白），y=0 在上；行列按**可落子格线**算（外框线不算第 0 行）
TRUTH = {(7, 4): 2, (8, 6): 2, (10, 6): 2, (7, 7): 1, (9, 7): 1, (8, 8): 1}

pass_n = 0
fail_n = 0


def ok(name: str, cond: bool, extra: str = "") -> None:
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  \u2713 " + name)
    else:
        fail_n += 1
        print("  \u2717 " + name + (("  | " + extra) if extra else ""))


def main() -> int:
    print("--- 拟真光泽棋子（五林五子棋现场截图）---")
    if not os.path.exists(FIXTURE):
        ok("基准图存在", False, FIXTURE)
        print("\n--- %d passed, %d failed ---" % (pass_n, fail_n))
        return 1
    ok("基准图存在（tools/fixtures/wulin_gloss_board.jpg）", True)

    rgb = np.asarray(Image.open(FIXTURE).convert("RGB"))
    res = sb.scan_once(rgb=rgb.copy())
    diag = res.get("diag") or {}

    # ---------- ① 结果 ----------
    ok("找得到棋盘", bool(res.get("found")), str(diag.get("reason")))
    got = {}
    for s in (res.get("black") or []):
        got[(s["x"], s["y"])] = 1
    for s in (res.get("white") or []):
        got[(s["x"], s["y"])] = 2
    wrong = {k: (got.get(k), v) for k, v in TRUTH.items() if got.get(k) != v}
    extra = {k: v for k, v in got.items() if k not in TRUTH}
    ok("6 颗子位置与颜色全中（3 黑 3 白）", not wrong and not extra,
       "错:%s 多:%s" % (wrong, extra))
    ok("|黑-白| 平衡且不 suspect（宿主才会采纳这一帧）",
       diag.get("black") == 3 and diag.get("white") == 3 and not diag.get("suspect"),
       str(diag))
    ok("外边界伪棋子清理没误伤（border_artifacts = 0）",
       int(diag.get("border_artifacts", -1)) == 0)

    # ---------- ② 机理：白子为什么必须靠逐格路径 ----------
    geo = res["geometry"]
    xl = np.asarray(geo["x_lines"], dtype=float)
    yl = np.asarray(geo["y_lines"], dtype=float)
    spacing = float(geo["spacing"])
    crop, (ox, oy) = sb.crop_board(rgb, xl, yl, spacing)
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    bg, _bg0, sigma = ad.estimate_background(gray, spacing)
    diff = gray.astype(np.int16) - bg.astype(np.int16)
    thr = float(max(ad.BASE_CONTRAST, ad.MAD_K * sigma))

    half = int(round(spacing * 0.62))
    pad = half
    diffp = cv2.copyMakeBorder(diff, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    core_m, _, _ = ad._radial_maps(half, spacing)
    cell_bg = ad._cell_bg_masks(half, spacing)
    gx = xl - ox
    gy = yl - oy

    lc = {}
    peak_white = 0.0
    for row in range(15):
        for col in range(15):
            x = int(round(float(gx[col]))); y = int(round(float(gy[row])))
            xp, yp = x + pad, y + pad
            patch = diffp[yp - half:yp + half + 1, xp - half:xp + half + 1]
            core_v = patch[core_m]
            # ⚠ 底色掩膜必须用**生产函数** cell_bg_union：边界格要把朝盘外的角并进来
            # （否则棋盘木底的「边缘暗角」会把这四角读成暗块）。自己抄一份逻辑迟早会漂，
            # 这里直接调同一个函数。
            bgm = ad.cell_bg_union(cell_bg, row, col, 15)
            val = float(np.median(core_v) - np.median(patch[bgm]))
            lc[(col, row)] = val
            if TRUTH.get((col, row)) == 2:
                # 只看**正值**那一侧：内盘里最亮的高光。取 |max| 会把穿过的网格线
                # （暗，−100 上下）当成「偏离」，量出来是 112 → 结论正好反了。
                peak_white = max(peak_white, float(np.max(core_v)))

    white_lc = [lc[k] for k, v in TRUTH.items() if v == 2]
    black_lc = [lc[k] for k, v in TRUTH.items() if v == 1]
    empty_lc = [abs(v) for k, v in lc.items() if k not in TRUTH]

    print("    [实测] thr=%.1f sigma=%.1f | 白子 lc=%s | 黑子 lc=%s | 空点 max|lc|=%.1f"
          % (thr, sigma, [round(v) for v in white_lc], [round(v) for v in black_lc],
             max(empty_lc)))
    print("    [实测] 白子内部最大偏离=%.0f（< thr=%.0f → 全局阈值够不着）"
          % (peak_white, thr))

    ok("★ 全局阈值确实够不着白子（thr > 白子内部最大偏离）—— 这就是「光泽白子」的根因",
       thr > peak_white, "thr=%.1f peak=%.1f" % (thr, peak_white))
    ok("★ 白子靠「逐格中位数」被救回：lc ≥ 20（实测 %s）" % [round(v) for v in white_lc],
       min(white_lc) >= 20.0)
    ok("★ 黑子 lc 极强（≤ −100，光泽高光也压不过）", max(black_lc) <= -100.0)
    ok("★ 空点 |lc| 全部低于 CELL_CONTRAST_MIN=%.0f（否则空点会被误判成子）" % ad.CELL_CONTRAST_MIN,
       max(empty_lc) < ad.CELL_CONTRAST_MIN,
       "max|lc|=%.1f 阈值=%.1f" % (max(empty_lc), ad.CELL_CONTRAST_MIN))
    ok("★ 白子 lc 与空点 |lc| 的余量 ≥ 2 倍（余量 = %.1f）"
       % (min(white_lc) / max(max(empty_lc), 1e-6)),
       min(white_lc) >= 2.0 * max(empty_lc))

    # ---------- ④ 缩放不变性：外框线不能把点阵拽偏一格 ----------
    # 修好之前：原图（1.0×）把木底**外框线**当第 0 行 → 整盘行号差 1；
    # 而缩放后的图（0.85× 等）反而锁定在真格线上 —— 同一个盘面在不同的截屏倍率下
    # 解出不同的坐标。这条把它钉死：任何倍率都必须解出**同一个盘面**。
    base = {}
    for s in (res.get("black") or []):
        base[(s["x"], s["y"])] = 1
    for s in (res.get("white") or []):
        base[(s["x"], s["y"])] = 2
    for sc in (0.85, 0.70, 0.55, 0.40):
        small = cv2.resize(rgb, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        r2 = sb.scan_once(rgb=np.ascontiguousarray(small))
        got2 = {}
        for s in (r2.get("black") or []):
            got2[(s["x"], s["y"])] = 1
        for s in (r2.get("white") or []):
            got2[(s["x"], s["y"])] = 2
        ok("★ 缩放 %.2f× 后盘面完全一致（外框线没把点阵拽偏一格）" % sc,
           got2 == base, "1.0×=%s  %.2f×=%s" % (base, sc, got2))

    # ---------- ③ 最后一手的红点不能把白子判成黑 ----------
    ok("带红点的白子 (10,6) 仍判为白（红点只占内盘少数像素）",
       got.get((10, 6)) == 2, "got=%s" % got.get((10, 6)))
    ok("CORE_R 仍小于红点之外的可用内盘（0.26 ≤ 0.30）", ad.CORE_R <= 0.30,
       "CORE_R=%.2f" % ad.CORE_R)

    print("\n--- %d passed, %d failed ---" % (pass_n, fail_n))
    return 1 if fail_n else 0


if __name__ == "__main__":
    sys.exit(main())
