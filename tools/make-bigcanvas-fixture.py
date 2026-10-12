# -*- coding: utf-8 -*-
"""构造「大图内嵌小棋盘」合成夹具：把 partial-board-photo.png 贴到大幅浅色画布上，
加几条灰色文本条模拟 App 页面，输出 big-canvas-paste.png。"""
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
fix = os.path.join(HERE, "fixtures")

board = cv2.imread(os.path.join(fix, "partial-board-photo.png"))
h, w = board.shape[:2]
print("board:", w, h)

canvas = np.full((h * 3 + 160, w * 3 + 160, 3), 245, dtype=np.uint8)
# 顶部/左侧模拟页面文本条
for i in range(6):
    y0 = 30 + i * 46
    cv2.rectangle(canvas, (30 + (i % 3) * 30, y0), (30 + (i % 3) * 30 + 300, y0 + 26), (185, 185, 185), -1)
ox, oy = (canvas.shape[1] - w) // 2, (canvas.shape[0] - h) // 2
canvas[oy:oy + h, ox:ox + w] = board
print("paste at", ox, oy)
out = os.path.join(fix, "big-canvas-paste.png")
cv2.imwrite(out, canvas)
print("saved", out)
