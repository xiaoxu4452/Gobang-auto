# -*- coding: utf-8 -*-
"""Extract 4.381 balance logic slices from bridge.dec.js."""
import io

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

def slice_around(kw, before=500, after=1600, label=""):
    idx = s.find(kw)
    print("\n===== %s @ %d =====" % (label or kw, idx))
    if idx >= 0:
        print(s[max(0, idx-before):idx+after])

slice_around("swap2board", 900, 1400, "swap2board")
