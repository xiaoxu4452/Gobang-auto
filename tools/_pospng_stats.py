#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""「保存局面」导出的棋盘 PNG 的分带统计（B2 的像素口径）。

用法：python _pospng_stats.py <png 路径>
输出：一行 JSON（所有数字都是**像素个数**，调用方自己定阈值）。

为什么单独一个脚本、而不复用 _screen_shot.py 的 posbands_stats：
  那个函数的口径是「**屏幕上的**局面小窗」—— 它要按覆盖层纯绿底反推透明度、按
  POS_* 设计比例分带、还要认「卡片底色 vs 窗口底色」。导出的图片完全是另一回事：
    · 底色是程序自己填的**不透明白**（不是圆角外的透明，也不是覆盖层的绿），
    · 卡片与底色同为白色（只有 1px 的 cLine 描边能区分），
    · 比例由导出侧固定成 kPosPngSize=800（等比缩放 sc=800/268≈2.985 + 居中），与屏幕 dpr 无关。
  混用只会得到一堆没法解释的数字，所以这里给一条**独立、窄口径**的判据。

导出侧的颜色常量（见 host.cpp 的 DrawPosBoardCard，浅色档）：
  卡片 cCard (255,255,255)   描边 cLine (223,226,232)
  网格 cGrid (176,184,198)   星位也用 cGrid
  黑子 (17,17,17)            白子 (252,252,252) + 描边 (150,154,163)
  坐标标注 cSub (132,138,150)
"""
import json
import sys

import numpy as np
from PIL import Image


def main():
    path = sys.argv[1]
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    H, W = a.shape[:2]
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx = np.maximum(np.maximum(R, G), B)
    mn = np.minimum(np.minimum(R, G), B)

    # 黑子 (17,17,17)：留一点余量，抗锯齿边缘也算进来
    black = int((mx < 60).sum())
    # 白子 (252,252,252)：底色是纯白 255，所以要**两侧都夹**，不能只写 > 240
    white = int(((mn >= 248) & (mx <= 254)).sum())
    # 网格线 (176,184,198)：偏冷（B > R），±22 的窄窗，免得把描边/标注算进来
    grid = int(((np.abs(R - 176) <= 22) & (np.abs(G - 184) <= 22) &
                (np.abs(B - 198) <= 22) & (B > R + 6)).sum())
    # 标注字 (132,138,150) ±12
    coord = int(((np.abs(R - 132) <= 12) & (np.abs(G - 138) <= 12) &
                 (np.abs(B - 150) <= 12)).sum())
    # 纯绿（覆盖层铺底用的 00FF00）：导出的图里**一像素都不该有** ——
    # 有就说明导出走的是「把屏幕截一块」而不是「把卡片重画一遍」。
    green = int(((R < 40) & (G > 200) & (B < 40)).sum())
    uniq = int(len(np.unique(a.reshape(-1, 3), axis=0)))

    # ★ 棋盘线的**外接矩形**（像素）：用来证明「800×800 是等比缩放 + 居中，不是拉伸」。
    #   棋盘本身是 210×210 设计单位的**正方形**，所以等比缩放下它在图上也必须是正方形
    #   （|宽 − 高| 只允许抗锯齿级别的误差）。要是有人把 268×264 硬拉成 800×800，
    #   这里立刻变成 800:788 左右的矩形。
    gm = ((np.abs(R - 176) <= 22) & (np.abs(G - 184) <= 22) &
          (np.abs(B - 198) <= 22) & (B > R + 6))
    #   ⚠ 阈值必须**很高**（0.45 倍边长），不能图省事写 5%：
    #     坐标标注字色 (132,138,150) 与白底混合出的过渡像素 (≈193,196,202) 恰好落进上面那个
    #     ±22 的网格色窗口 —— 阈值一低，左右两条标注栏就被算成棋盘的一部分，
    #     外接矩形会从 627×627 虚胖成 698×630，看着像「拉伸变形」（第一次跑就是这么误判的）。
    #     真实的格线是 1 设计单位宽 ≈ 3 px、纵向贯通整个棋盘，每一列有 ~627 px；
    #     标注文字在任一列最多几十 px。45% 这条线正好把两者分开，余量 6 倍以上。
    gx = np.nonzero(gm.sum(axis=0) >= max(3, int(0.45 * H)))[0]
    gy = np.nonzero(gm.sum(axis=1) >= max(3, int(0.45 * W)))[0]
    bbox = None
    if len(gx) >= 2 and len(gy) >= 2:
        bbox = {'x0': int(gx[0]), 'x1': int(gx[-1]), 'y0': int(gy[0]), 'y1': int(gy[-1]),
                'w': int(gx[-1] - gx[0] + 1), 'h': int(gy[-1] - gy[0] + 1)}
        # 棋盘在图里的中心（用来验「居中」）
        bbox['cx'] = round((bbox['x0'] + bbox['x1']) / 2.0, 1)
        bbox['cy'] = round((bbox['y0'] + bbox['y1']) / 2.0, 1)

    print(json.dumps({
        'W': W, 'H': H,
        'black': black, 'white': white, 'grid': grid, 'coord': coord,
        'green': green, 'uniq': uniq,
        'gridBox': bbox,
        'corner': [int(v) for v in a[2, 2]],
    }))


if __name__ == '__main__':
    main()
