# -*- coding: utf-8 -*-
"""Legacy UI eval view flip (blackView / side handling)."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()

for kw in ['blackView', 'myEval', 'rawEval', 'evalToNumber', 'winrate']:
    for m in re.finditer(re.escape(kw), s):
        a = max(0, m.start()-160); b = min(len(s), m.end()+200)
        print("\n=== %s @ %d ===\n%s" % (kw, m.start(), s[a:b]))
        break
