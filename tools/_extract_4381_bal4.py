# -*- coding: utf-8 -*-
"""Extract 4.381 balance function complete body (engine call + 3-stone branch)."""
import io

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

# The balance function starts before 'm=[' at 46015. Find function start:
start = s.rfind("function", 0, 45500)
print("func start guess:", start)
# print from 45500 to 48000 (covers local book + engine fallback + 3-stone branch)
print(s[45500:48200])
