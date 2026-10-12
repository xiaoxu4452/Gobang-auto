# -*- coding: utf-8 -*-
# Load GomokuVision.dll in-process and call GbvScanImage twice on the same
# board image: first call locates, second call should reuse cached geometry
# (frame differencing) and be much faster.
import ctypes, time, os

dll_path = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.dll"
tools = r"C:\Users\harve\Desktop\Gobang auto\tools"
img_path = os.path.join(tools, "_redword_test.png")

try:
    lib = ctypes.CDLL(dll_path)
except Exception as e:
    print("CDLL fail:", e)
    raise SystemExit(0)

lib.GbvScanImage.restype = ctypes.c_int
lib.GbvScanImage.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]

with open(img_path, "rb") as f:
    raw = f.read()

cap = 4 * 1024 * 1024
for i in range(3):
    out = ctypes.create_string_buffer(cap)
    t0 = time.time()
    n = lib.GbvScanImage(raw, len(raw), 0, out, cap)
    dt = (time.time() - t0) * 1000.0
    txt = out.raw[:n].decode("utf-8", "replace") if n > 0 else ""
    black = txt.count('"black"') and 'black' in txt
    import json
    try:
        d = json.loads(txt)
        nb, nw = len(d.get("black") or []), len(d.get("white") or [])
        print("call %d: %.1f ms  B%d W%d" % (i + 1, dt, nb, nw))
    except Exception as e:
        print("call %d: %.1f ms json-fail %s" % (i + 1, dt, txt[:100]))
