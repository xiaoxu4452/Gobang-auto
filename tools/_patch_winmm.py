# -*- coding: utf-8 -*-
p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
raw = open(p, "rb").read()
bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
if bom: raw = raw[3:]
t = raw.decode("utf-8")
anchor = '#pragma comment(lib, "gdiplus.lib")\r\n'
add = '#pragma comment(lib, "winmm.lib")  // timeBeginPeriod/timeEndPeriod（滑行期 1ms 定时器精度）\r\n'
n = t.count(anchor)
print("anchor:", n)
assert n == 1
assert "winmm.lib" not in t
t = t.replace(anchor, anchor + add)
open(p, "wb").write(bom + t.encode("utf-8"))
print("PATCHED")
