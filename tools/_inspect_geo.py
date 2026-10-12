# -*- coding: utf-8 -*-
# Inspect full recognize JSON for geometry fields usable to place a red "100".
import json, subprocess

dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
src = r"C:\Users\harve\Desktop\Gobang auto\tools\_redword_test.png"
r = subprocess.run([dll, "--recognize-image", src], capture_output=True, text=True, encoding="utf-8", errors="replace")
txt = r.stdout.strip()
data = json.loads(txt)
def keys(o, prefix=""):
    if isinstance(o, dict):
        for k, v in o.items():
            print(prefix + k, "->", type(v).__name__)
            if isinstance(v, dict) and len(v) < 8: keys(v, prefix + k + ".")
            elif isinstance(v, list) and len(v) <= 16: print(prefix + k, "len", len(v), "sample", v[:3])
keys(data)
print("TOP:", list(data.keys()))
