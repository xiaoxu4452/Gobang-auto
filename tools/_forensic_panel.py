# -*- coding: utf-8 -*-
# 取证：放大书签面板区域，读状态行/按键态
from PIL import Image
import os
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
out = r"C:\Users\harve\Desktop\Gobang auto\tools\_forensic"
os.makedirs(out, exist_ok=True)
im = Image.open(p)
print("size:", im.size, im.mode)
w, h = im.size
# 面板在右侧（x 约 0.80-1.0）。整块裁出放大 3 倍
panel = im.crop((int(w*0.79), 0, w, h))
panel = panel.resize((panel.width*3, panel.height*3), Image.LANCZOS)
panel.save(os.path.join(out, "panel_full.png"))
print("panel saved:", panel.size)
# 上半（思考时间~按钮区）
top = im.crop((int(w*0.79), int(h*0.05), w, int(h*0.50)))
top = top.resize((top.width*4, top.height*4), Image.LANCZOS)
top.save(os.path.join(out, "panel_top.png"))
# 下半（仪表盘+曲线+按钮）
bot = im.crop((int(w*0.79), int(h*0.50), w, h))
bot = bot.resize((bot.width*4, bot.height*4), Image.LANCZOS)
bot.save(os.path.join(out, "panel_bot.png"))
print("done")
