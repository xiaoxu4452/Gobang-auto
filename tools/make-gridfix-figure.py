# -*- coding: utf-8 -*-
"""生成「外框线陷阱」修复的对比证据图。

左：整盘 —— 黄线是**被误当成第 0 行**的木底装饰外框，绿线是修复后锁定的 15 条真格线，
    红圈是识别出的 6 颗子（标 (列,行)）。
右：左上角放大 —— 直接看清「外框在木板外沿、首条格线才是竖线起点」。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'engine-server', 'python'))

import numpy as np
from PIL import Image, ImageDraw

from gomoku_assistant import screen_board as sb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG = os.path.join(ROOT, 'tools', 'fixtures', 'wulin_gloss_board.jpg')
OUT = os.path.join(ROOT, 'board-grid-fix.png')

img = np.ascontiguousarray(np.asarray(Image.open(IMG).convert("RGB")))
res = sb.scan_once(rgb=img)
geo = res["geometry"]
xl = [float(v) for v in geo["x_lines"]]
yl = [float(v) for v in geo["y_lines"]]
sx = (xl[-1] - xl[0]) / 14.0
sy = (yl[-1] - yl[0]) / 14.0
FRAME_Y = yl[0] - 0.868 * sy      # 实测：外框在真首行外侧 ~0.868 格

base = Image.fromarray(img).convert("RGB")
d = ImageDraw.Draw(base)
# 外框线（曾被当成第 0 行）
d.line([(xl[0] - 40, FRAME_Y), (xl[-1] + 40, FRAME_Y)], fill=(255, 196, 0), width=3)
d.text((xl[0] - 36, FRAME_Y - 22), "outer frame  (was mistaken for row 0)",
       fill=(255, 196, 0))
# 真格线
for v in xl:
    d.line([(v, yl[0]), (v, yl[-1])], fill=(0, 220, 90), width=1)
for v in yl:
    d.line([(xl[0], v), (xl[-1], v)], fill=(0, 220, 90), width=1)
# 识别出的子
for s in res["black"]:
    cx, cy = xl[s["x"]], yl[s["y"]]
    d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], outline=(255, 40, 40), width=4)
    d.text((cx - 24, cy - 44), "B %d,%d" % (s["x"], s["y"]), fill=(255, 40, 40))
for s in res["white"]:
    cx, cy = xl[s["x"]], yl[s["y"]]
    d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], outline=(0, 120, 255), width=4)
    d.text((cx - 24, cy - 44), "W %d,%d" % (s["x"], s["y"]), fill=(0, 120, 255))

# 顶部放大条：左上角「外框 vs 首条格线」
z = base.crop((60, 40, 460, 240))
zw = base.width
zh = int(z.height * zw / z.width)
z = z.resize((zw, zh), Image.LANCZOS)

BAND = z.height + 46
canvas = Image.new("RGB", (base.width, BAND + base.height + 30), (250, 250, 248))
canvas.paste(z, (0, 34))
canvas.paste(base, (0, BAND + 20))
cd = ImageDraw.Draw(canvas)
cd.text((6, 10), "ZOOM (top-left):  yellow = board's decorative OUTER FRAME "
                 "(previously mistaken for row 0)   |   green = first real grid line",
        fill=(20, 20, 20))
cd.text((6, BAND + 4), "FULL BOARD:  15 real grid lines (green) + 6 recognised stones "
                       "-- rows/cols are no longer off by one",
        fill=(20, 20, 20))
canvas.save(OUT)
print("saved", OUT, canvas.size)
print("frame_y=%.1f  row0=%.1f  step=%.2f   stones: B=%s W=%s"
      % (FRAME_Y, yl[0], sy,
         [(s["x"], s["y"]) for s in res["black"]],
         [(s["x"], s["y"]) for s in res["white"]]))
