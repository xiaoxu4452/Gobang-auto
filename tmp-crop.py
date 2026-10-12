import numpy as np
from PIL import Image
img = Image.open(r"C:\Users\harve\AppData\Local\Doubao\User Data\ClipboardTemp\446f0e5e-e8d4-481f-9a57-06405aa4911c.png").convert("RGB")
# 左侧手机截图预览区（OCR: x 130-270, y 205-290 千分比；外扩一点）
# OCR 千分比 130..270 -> 188..391 px；205..290 -> 234..331 px
crop = img.crop((170, 220, 410, 350))
crop.save(r"C:\Users\harve\Desktop\Gobang auto\tmp-phone-crop.png")
a = np.asarray(crop)
g = a.mean(axis=2)
print("phone crop:", crop.size, "gray mean %.1f std %.1f min %.1f max %.1f" % (g.mean(), g.std(), g.min(), g.max()))
dark = (g < g.mean() - 20).sum()
print("dark%%: %.2f" % (100.0*dark/g.size))