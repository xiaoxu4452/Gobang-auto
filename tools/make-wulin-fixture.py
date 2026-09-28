# -*- coding: utf-8 -*-
"""把用户给的「五林五子棋」截图裁成**只有棋盘**的测试基准图。

为什么要裁：
  · 原图带着我们自己的面板（还有玩家的昵称），没必要作为基准图进仓库；
  · 裁掉面板后，识别链路不需要 exclude 也能跑，基准更「纯」；
  · 体积从 ~260KB 降到更小。

真值（棋盘 15×15，坐标 = (列 x, 行 y)，y=0 在**上**）：
  白 (7,5) (8,7) (10,7)   ← (10,7) 带红点（最后一手标记）
  黑 (7,8) (9,8) (8,9)
"""
import os
import sys

import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-19T01-15-43-774Z-e57eef61.jpg"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures',
                   'wulin_gloss_board.jpg')

img = Image.open(SRC).convert("RGB")
print("src:", img.size)
# 棋盘几何（实测）：x 172..1303, y 73..1192；面板从 x≈1422 起。留足外圈木边。
box = (30, 0, 1410, 1330)
crop = img.crop(box)
print("crop:", crop.size)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
crop.save(OUT, quality=92, subsampling=0, optimize=True)
print("→", OUT, os.path.getsize(OUT), "bytes")
