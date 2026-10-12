# -*- coding: utf-8 -*-
import json, subprocess
dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
src = r"C:\Users\harve\Desktop\Gobang auto\tools\_redword_test.png"
r = subprocess.run([dll, "--recognize-image", src], capture_output=True, text=True, encoding="utf-8", errors="replace")
data = json.loads(r.stdout.strip())
g = data.get("geometry") or {}
print("geometry keys:", list(g.keys()))
for k in list(g.keys()):
    v = g[k]
    if isinstance(v, list): print(k, "len", len(v), "head", v[:4])
    else: print(k, "=", v)
d = data.get("diag") or {}
print("diag keys:", list(d.keys()))
for k in list(d.keys()):
    v = d[k]
    if isinstance(v, list): print("diag."+k, "len", len(v), "head", v[:4])
    else: print("diag."+k, "=", v)
