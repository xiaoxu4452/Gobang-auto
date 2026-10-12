# -*- coding: utf-8 -*-
"""Extract historical balance logic from 4.381 calc.dec.js (single-line obfuscated)."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\calc.dec.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()
print("total len:", len(s))

# find swap2board related code
for kw in ["swap2board", "SWAP2BOARD", "swapBoard", "balFail", "balance", "YXBALANCETWO", "九", "定式"]:
    idx = s.find(kw)
    print("KW %-14s first_idx=%d" % (kw, idx))

# locate the balance function: search nearby known markers
idx = s.find("swap2board")
if idx > 0:
    print("\n--- context around 'swap2board' (first) ---")
    print(s[max(0, idx-600):idx+1200])
