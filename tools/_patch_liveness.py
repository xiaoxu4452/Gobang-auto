# -*- coding: utf-8 -*-
# Stabilize frame-differencing reuse: lower the liveness gate (0.25 -> 0.18)
# so cached-geometry reuse survives minor texture/noise fluctuation and only a
# genuinely moved/closed board falls back to full rescan.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbscreen.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()
old = "        if (live < 0.25) {"
new = "        if (live < 0.18) {"
if old not in s:
    print("MISSING: liveness gate"); raise SystemExit(1)
s = s.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("gbscreen.cpp: liveness gate 0.25 -> 0.18")
