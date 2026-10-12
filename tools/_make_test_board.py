# Generate a synthetic light-wood board with black/white stones for
# side-by-side CLI recognition test of the two vision models.
from PIL import Image, ImageDraw
import math

N = 15
cell = 40
M = 8  # outer margin
W = N * cell + 2 * M
H = N * cell + 2 * M
img = Image.new("RGB", (W, H), (238, 206, 160))  # light wood (|r-b|=78 filtered)
d = ImageDraw.Draw(img)
LINE = (168, 138, 96)
for k in range(N):
    y = M + round((k + 0.5) * cell)
    d.line([(M, y), (W - M, y)], fill=LINE, width=2)
    x = M + round((k + 0.5) * cell)
    d.line([(x, M), (x, H - M)], fill=LINE, width=2)

def stone(cx, cy, white):
    r = cell * 0.44
    rings = [(0.62, (255, 255, 255)), (0.80, (232, 230, 226)),
             (0.92, (208, 205, 200)), (1.00, (168, 163, 155))] if white else \
            [(0.75, (26, 26, 28)), (1.00, (48, 46, 44))]
    for y in range(cy - cell, cy + cell + 1):
        for x in range(cx - cell, cx + cell + 1):
            dd = math.hypot(x - cx, y - cy) / r
            for edge, col in rings:
                if dd <= edge:
                    img.putpixel((x, y), col)
                    break

def pt(k, l):
    return (M + round((l + 0.5) * cell), M + round((k + 0.5) * cell))

# black diagonal + scattered white
for i in range(5):
    cx, cy = pt(i, i); stone(cx, cy, False)
for (k, l) in ((0, 6), (2, 8), (4, 10), (6, 6), (7, 3), (8, 12),
               (9, 7), (10, 4), (11, 9), (12, 11), (13, 2), (14, 13)):
    cx, cy = pt(k, l); stone(cx, cy, True)

img.save(r"C:\Users\harve\Desktop\Gobang auto\tools\_zhizi_test_board.png")
print("saved test board", img.size)
