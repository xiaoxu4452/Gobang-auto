# -*- coding: utf-8 -*-
# 取证 step5: 放大星位十字 + H8 上的十字 + F6 的白方块，判断绘制来源
from PIL import Image
import os
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
out = r"C:\Users\harve\Desktop\Gobang auto\tools\_forensic"
im = Image.open(p).convert("RGB")
# D12 = (549,335) 附近 160x160
for name, cx, cy in [("star_D12", 549, 335), ("H8_cross", 834, 620), ("F6_square", 549, 835), ("K7_area", 977, 835), ("J8_area", 906, 764)]:
    c = im.crop((cx-70, cy-70, cx+70, cy+70))
    c = c.resize((c.width*5, c.height*5), Image.NEAREST)
    c.save(os.path.join(out, name + ".png"))
print("saved 5 crops")
