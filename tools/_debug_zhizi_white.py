# Debug: replicate classify_point on the synthetic board, print per-point ratios.
from PIL import Image
import math

img = Image.open(r"C:\Users\harve\Desktop\Gobang auto\tools\_zhizi_test_board.png").convert("RGB")
tw, th = img.size
px = img.load()

W = 25  # win (0.62*40)
black_offset, white_offset, gray_offset = 96, 112, 50

def percent(sx, sy, w, h, isBlack, offset):
    if sx + w > tw: sx = tw - w
    if sy + h > th: sy = th - h
    count = 0
    for y in range(sy, sy + h):
        for x in range(sx, sx + w):
            r, g, b = px[x, y]
            if abs(r-g) >= gray_offset or abs(g-b) >= gray_offset or abs(b-r) >= gray_offset:
                continue
            if isBlack:
                if r <= offset and g <= offset and b <= offset: count += 1
            else:
                thr = 255 - offset
                if r >= thr and g >= thr and b >= thr: count += 1
    return 100 * count // (w * h)

def true_white(sx, sy, w, h):
    if sx + w > tw: sx = tw - w
    if sy + h > th: sy = th - h
    by = sy + h // 4
    for i in range(int(round(w * 2 / 6))):
        r, g, b = px[sx + i, by]
        if r < 225 or g < 225 or b < 225: return True
    return False

xs = [28 + 40 * i for i in range(15)]
for (k, l) in ((0, 6), (2, 8), (4, 10), (6, 6), (7, 3), (8, 12), (9, 7), (10, 4), (11, 9), (12, 11), (13, 2), (14, 13)):
    cx, cy = xs[l], xs[k]
    sx, sy = cx - W // 2, cy - W // 2
    pb = percent(sx, sy, W, W, True, black_offset)
    pw = percent(sx, sy, W, W, False, white_offset)
    p30 = percent(sx, sy, W, W, False, 30)
    p65 = percent(sx, sy, W, W, False, 65)
    tw_ = true_white(sx, sy, W, W)
    print(f"({k},{l}) pctBlack={pb} pctWhite={pw} pct30={p30} pct65={p65} trueWhite={tw_} -> {'BLACK' if pb>=37 else 'WHITE' if pw>=30 and (tw_ or p65-p30>=10) else 'EMPTY'}")
