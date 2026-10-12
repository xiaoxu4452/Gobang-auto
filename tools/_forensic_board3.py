# -*- coding: utf-8 -*-
# 取证 step3: 逐交叉点采样判色 → 重建 playok 真盘
from PIL import Image
p = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-09-26T15-17-22-180Z-4780cd94.png"
im = Image.open(p).convert("RGB")
px = im.load()

VX = [337.0 + 71.286*i for i in range(15)]          # 337..1335
HY = [123.5 + 71.25*i for i in range(15)]           # 123.5..1121
R = 22

def classify(cx, cy):
    # 环形采样（避开中心高光/标记）+ 中心点，统计黑/白/木

    black = white = wood = green = 0
    tot = 0
    samples = [(0, 0)]
    for a in range(0, 360, 30):
        import math
        samples.append((R*math.cos(a*math.pi/180), R*math.sin(a*math.pi/180)))
    for (dx, dy) in samples:
        x = int(cx+dx); y = int(cy+dy)
        r, g, b = px[x, y]
        tot += 1
        lum = 0.299*r + 0.587*g + 0.114*b
        if g > 150 and g - r > 40 and g - b > 40:
            green += 1
        elif lum < 95:
            black += 1
        elif r > 200 and g > 195 and b > 170:
            white += 1
        elif abs(r-240) < 40 and abs(g-176) < 40 and abs(b-96) < 45:
            wood += 1
        else:
            wood += 1   # 半透明/阴影归入木
    if green >= 3: return 'G'          # 绿 + 标记（星位/最后一手）
    if black >= 12: return 'B'
    if white >= 12: return 'W'
    if black + white >= 12:
        return 'b' if black > white else 'w'   # 混合（带标记的子）
    if black >= 6: return 'b'
    if white >= 6: return 'w'
    return '.'

rows = []
stones = []
for j in range(15):
    row = ''
    for i in range(15):
        c = classify(VX[i], HY[j])
        row += c
        if c in 'BWbw':
            stones.append((i, j, c))
    rows.append(row)
print("    " + "".join("ABCDEFGHJKLMNOP"[i] if i < 15 else '' for i in range(15)))
for j in range(15):
    print("%2d  %s" % (15-j, rows[j]))
print()
bw = sum(1 for s in stones if s[2] in 'Bb')
ww = sum(1 for s in stones if s[2] in 'Ww')
print("black:", bw, " white:", ww, " total:", len(stones))
for s in stones:
    print("  %s%d %s" % ("ABCDEFGHJKLMNOP"[s[0]], 15-s[1], s[2]), end='')
print()
