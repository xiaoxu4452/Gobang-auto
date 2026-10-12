# -*- coding: utf-8 -*-
# Per user: no deliberate cross-marker checking. Remove redMarked hard-reject
# (a red X on an empty point is left to the natural classifier -> EMPTY; a real
# stone under a red X is read correctly). Keep coloredMarked only against
# decorations (corner logo) and exempt cells with a clear white stone body so a
# white stone printed with a big red move number is still read as WHITE.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

subs = [
    # 1) main cell loop
    ('if (redMarked(xo, yo) || coloredMarked(xo, yo)) { GB_TRACE(col, row, "REJECT marker/decoration"); return; }',
     'if (coloredMarked(xo, yo) && whiteByBody(xo, yo) != WHITE) { GB_TRACE(col, row, "REJECT decoration"); return; }'),
    # 2) low-confidence refine path
    ('if (redMarked(iRound(geo.x_lines[col]), iRound(geo.y_lines[row])) || coloredMarked(iRound(geo.x_lines[col]), iRound(geo.y_lines[row]))) continue;',
     'if (coloredMarked(iRound(geo.x_lines[col]), iRound(geo.y_lines[row])) && whiteByBody(iRound(geo.x_lines[col]), iRound(geo.y_lines[row])) != WHITE) continue;'),
    # 3) blob-hit path
    ('if (redMarked(x - pad, y - pad) || coloredMarked(x - pad, y - pad)) continue;',
     'if (coloredMarked(x - pad, y - pad) && whiteByBody(x - pad, y - pad) != WHITE) continue;'),
]
for old, new in subs:
    if old not in s:
        print("MISSING:", old[:60]); raise SystemExit(1)
    s = s.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("gbadaptive.cpp: redMarked removed, coloredMarked gets white-body exemption")
