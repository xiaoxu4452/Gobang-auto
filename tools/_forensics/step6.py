# -*- coding: utf-8 -*-
# step6: 角落特写裁决网格原点（98 vs 169 / x 208 vs 248）
from PIL import Image
import os
SRC = r'C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T16-41-41-380Z-a40775c8.png'
OUT = r'C:\Users\harve\Desktop\Gobang auto\tools\_forensics'
im = Image.open(SRC).convert('RGB')
# 左上角：覆盖两条候选首行线 y=98 与 y=169，及候选首列线 x=208 与 x=248
c = im.crop((180, 60, 700, 420)); c = c.resize((c.width*3, c.height*3), Image.LANCZOS)
c.save(os.path.join(OUT, 'corner_tl_3x.png')); print('tl', c.size)
# 左下角：候选末行 y=1096 与 y=1167
c = im.crop((180, 1000, 700, 1260)); c = c.resize((c.width*3, c.height*3), Image.LANCZOS)
c.save(os.path.join(OUT, 'corner_bl_3x.png')); print('bl', c.size)
