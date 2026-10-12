# -*- coding: utf-8 -*-
"""Extract legacy toEngineMoveList (f) definition from 4.381 bridge.dec.js."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()

# find definition of the move-list builder; look for "function f(" or "f=function"
cands = []
for m in re.finditer(r'(?:function\s+f\s*\(|\bf\s*=\s*function\s*\()', s):
    cands.append(m.start())
print("function f candidates:", cands[:10])

# also search for the mapping pattern: a move list -> [x,y,color]
# legacy likely builds "x,y,color" where color from side view
for m in re.finditer(r'(?:board|arr)\s*\.\s*(?:map|forEach)\s*\([^)]*', s):
    pass

# Try locating where arrays are mapped to coords: search ",1;" style joins
for m in re.finditer(r'\.map\(function\s*\([^)]*\)\s*\{[^}]{0,80}join', s):
    a = max(0, m.start()-120); b = min(len(s), m.end()+80)
    print("\n=== map-join @", m.start(), "===\n", s[a:b])

# print a window around the first function f candidate if any
if cands:
    c0 = cands[0]
    print("\n=== f def @", c0, "===\n", s[c0:c0+700])
