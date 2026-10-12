# -*- coding: utf-8 -*-
import json, subprocess, os
from PIL import Image, ImageDraw, ImageFont

tools = r"C:\Users\harve\Desktop\Gobang auto\tools"
src = os.path.join(tools, "_redword_test.png")
out = os.path.join(tools, "_redword100_test.png")
dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"

def rec(p):
    r = subprocess.run([dll, "--recognize-image", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
    d = json.loads(r.stdout.strip())
    return d

def counts(d):
    return len(d.get("black") or []), len(d.get("white") or [])

d0 = rec(src)
g = d0.get("geometry") or {}
x0, y0, step = g["x0"], g["y0"], (g["stepX"] + g["stepY"]) / 2.0
whites = d0.get("white") or []
b0 = counts(d0)
print("base: B%d W%d step %.1f" % (b0[0], b0[1], step))

img = Image.open(src).convert("RGB")
draw = ImageDraw.Draw(img)
fnt = None
for size in (int(step*0.46), int(step*0.38), int(step*0.30)):
    try:
        fnt = ImageFont.truetype("arialbd.ttf", size); break
    except Exception:
        continue
if fnt is None: fnt = ImageFont.load_default()
for wpt in whites[:2]:
    i, j = wpt["x"], wpt["y"]
    cx, cy = x0 + i*step, y0 + j*step
    bb = draw.textbbox((0, 0), "100", font=fnt)
    tw, th = bb[2]-bb[0], bb[3]-bb[1]
    draw.text((cx - tw/2 - bb[0], cy - th/2 - bb[1]), "100", fill=(215, 40, 40), font=fnt)
    print("painted white", (i, j), "px", (int(cx), int(cy)))
img.save(out)

d1 = rec(out)
b1 = counts(d1)
print("with red100: B%d W%d" % b1)
for wpt in whites[:2]:
    i, j = wpt["x"], wpt["y"]
    in_b = any(s["x"] == i and s["y"] == j for s in d1.get("black") or [])
    in_w = any(s["x"] == i and s["y"] == j for s in d1.get("white") or [])
    print("cell (%d,%d) -> %s" % (i, j, "WHITE" if in_w else ("BLACK" if in_b else "EMPTY")))
print("saved", out)
