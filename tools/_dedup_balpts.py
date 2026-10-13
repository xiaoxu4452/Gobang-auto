# -*- coding: utf-8 -*-
# Remove the duplicated GB_BAL_POINTS block in bridge.js (ran twice)
import io
p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(p, "r", encoding="utf-8-sig").read()
marker = "  window.GB_BAL_POINTS = async function (req) {"
linkm = "  window.GB_LINK_SWAPBAL = runSwapBal;"
n = s.count(marker)
if n == 2:
    i2 = s.rfind(marker)
    il = s.rfind(linkm)
    assert i2 < il, (i2, il)
    s = s[:i2] + s[il:]
    io.open(p, "w", encoding="utf-8-sig", newline="").write(s)
    print("dedup OK (2 -> 1)")
elif n == 1:
    print("already single")
else:
    print("unexpected count=%d" % n)
