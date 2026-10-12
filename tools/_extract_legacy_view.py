# -*- coding: utf-8 -*-
"""Extract YXBOARD / view-color handling from 4.381 legacy bridge.dec.js."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()
print("len", len(s))

# locate YXBOARD usage
for m in re.finditer(r'YXBOARD', s):
    a = max(0, m.start()-200)
    b = min(len(s), m.end()+200)
    print("\n=== YXBOARD @", m.start(), "===")
    print(s[a:b])

# locate selfColor / side color concepts
for kw in ['selfColor', 'YXNBEST', 'toSide', 'flagOf']:
    i = s.find(kw)
    if i >= 0:
        a = max(0, i-150); b = min(len(s), i+200)
        print("\n=== %s @ %d ===\n%s" % (kw, i, s[a:b]))
