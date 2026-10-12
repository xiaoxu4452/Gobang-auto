# -*- coding: utf-8 -*-
# 取证：从 playok 截图重建真盘 —— 探测网格 + 逐交叉点判色
from PIL import Image
import os
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
out = r"C:\Users\harve\Desktop\Gobang auto\tools\_forensic"
im = Image.open(p).convert("RGB")
W, H = im.size
px = im.load()

# playok 棋盘是橙木色。先统计主色
from collections import Counter
cnt = Counter()
for y in range(0, H, 7):
    for x in range(0, W, 7):
        cnt[px[x, y]] += 1
print("top colors:", cnt.most_common(8))
