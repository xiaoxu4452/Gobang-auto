# -*- coding: utf-8 -*-
# Frame-difference speedup:
# 1) scanSub: reuse the cached board geometry unconditionally (drop the
#    boardWindowChanged gate) - once the board is located, every later frame
#    reads stones directly with the cached geometry (liveness gate still
#    catches a moved/closed board and falls back to a full rescan). Stone
#    changes no longer force a full re-locate.
# 2) gbdll.cpp: shrink the rescue candidate count (30 -> 8) so the
#    not-found/empty fallback never walks 30 full recognitions.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbscreen.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()
old = """    static StabGeo stab;
    if (!probe && stab.has && (int)stab.xl.size() == size && (int)stab.yl.size() == size &&
        stab.sp > 0 && !boardWindowChanged(masked, stab.xl, stab.yl, stab.sp)) {"""
new = """    static StabGeo stab;
    if (!probe && stab.has && (int)stab.xl.size() == size && (int)stab.yl.size() == size &&
        stab.sp > 0) {"""
if old not in s:
    print("MISSING: stab reuse block"); raise SystemExit(1)
s = s.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("gbscreen.cpp: stab reuse no longer gated by boardWindowChanged")

p2 = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbdll.cpp"
with io.open(p2, 'r', encoding='utf-8') as f:
    d = f.read()
for old2, new2 in [
    ('if (tryAlt(bgray, 2.0, 2.0, "snap_alt_big", 30)) {}',
     'if (tryAlt(bgray, 2.0, 2.0, "snap_alt_big", 8)) {}'),
    ('else if (!tryAlt(gray, 1.0, 1.0, "snap_alt", 30)) {}',
     'else if (!tryAlt(gray, 1.0, 1.0, "snap_alt", 8)) {}'),
]:
    if old2 not in d:
        print("MISSING:", old2); raise SystemExit(1)
    d = d.replace(old2, new2, 1)
with io.open(p2, 'w', encoding='utf-8', newline='\n') as f:
    f.write(d)
print("gbdll.cpp: rescue topn 30 -> 8")
