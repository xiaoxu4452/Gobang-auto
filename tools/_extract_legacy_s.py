# -*- coding: utf-8 -*-
"""Extract legacy s() used by toEngineMoveList (side -> color remap)."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()

# find the short helper right after legacy f definition (starts around index 13505, f ends before c(e,n))
# search for function s definition anywhere
for m in re.finditer(r'function\s+s\s*\(', s):
    a = max(0, m.start()-60); b = min(len(s), m.start()+420)
    print("\n=== function s @", m.start(), "===\n", s[a:b])

# also look for how analyze passes side and flips evals / best move
for kw in ['e.side===2', 'side===2', 'blackView', 'oppo', 'flip']:
    for m in re.finditer(re.escape(kw), s):
        a = max(0, m.start()-100); b = min(len(s), m.end()+120)
        print("\n=== %s @ %d ===\n%s" % (kw, m.start(), s[a:b]))
        break
