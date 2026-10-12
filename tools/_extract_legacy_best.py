# -*- coding: utf-8 -*-
"""Extract legacy analyze YXNBEST result handling (eval / best move view)."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()

# window after YXNBEST @ 28109
a = 28109
b = min(len(s), a + 2600)
print("=== YXNBEST handling ===")
print(s[a:b])
