# -*- coding: utf-8 -*-
# 裁出 playok 棋盘 canvas 区域（木色外接框）
from PIL import Image
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
im = Image.open(p).convert("RGB")
c = im.crop((129, 60, 1984, 1183))
c.save(r"C:\Users\harve\Desktop\Gobang auto\tools\_forensic\board_canvas.png")
print("saved", c.size)
