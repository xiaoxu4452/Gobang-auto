import numpy as np
from PIL import Image
img = Image.open(r"C:\Users\harve\AppData\Local\Doubao\User Data\ClipboardTemp\446f0e5e-e8d4-481f-9a57-06405aa4911c.png").convert("RGB")
crop = img.crop((165, 185, 415, 390))
crop.save(r"C:\Users\harve\Desktop\Gobang auto\tmp-phone-crop2.png")
a = np.asarray(crop)
g = a.mean(axis=2)
print("crop2:", crop.size, "gray mean %.1f std %.1f" % (g.mean(), g.std()))
dark = (g < g.mean() - 20).sum()
print("dark%%: %.2f" % (100.0*dark/g.size))