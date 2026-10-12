import numpy as np
from PIL import Image
img = Image.open(r"C:\Users\harve\AppData\Local\Doubao\User Data\ClipboardTemp\446f0e5e-e8d4-481f-9a57-06405aa4911c.png").convert("RGB")
a = np.asarray(img)
print("img shape:", a.shape)
g = a.mean(axis=2)
bx0, by0, bw = 611, 217, 761
sub = g[by0:by0+bw, bx0:bx0+bw]
print("board gray: min %.1f max %.1f mean %.1f std %.1f" % (sub.min(), sub.max(), sub.mean(), sub.std()))
qs = np.percentile(sub, [10,25,50,75,90])
print("board p10/25/50/75/90:", np.round(qs,1))
dark = (sub < sub.mean() - 25).sum()
print("darker than mean-25: %.3f%%" % (100.0*dark/sub.size))
light = (sub > sub.mean() + 25).sum()
print("lighter than mean+25: %.3f%%" % (100.0*light/sub.size))
print("full gray min/max:", g.min(), g.max())
# 看左侧手机截图预览区（OCR显示棋盘大概在预览图里 x~130-270,y~205-290 千分比 => 原图 188~391,234~331）
p = g[234:331, 188:391]
print("phone-preview region: mean %.1f std %.1f min %.1f max %.1f" % (p.mean(), p.std(), p.min(), p.max()))