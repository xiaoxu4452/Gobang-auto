# -*- coding: utf-8 -*-
# Measure current released DLL: 5 in-process calls + report per-call time.
import ctypes, time, os, json

dll_path = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.dll"
tools = r"C:\Users\harve\Desktop\Gobang auto\tools"
img_path = os.path.join(tools, "_redword_test.png")
lib = ctypes.CDLL(dll_path)
lib.GbvScanImage.restype = ctypes.c_int
lib.GbvScanImage.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
raw = open(img_path, 'rb').read()
cap = 4 * 1024 * 1024
for i in range(5):
    out = ctypes.create_string_buffer(cap)
    t0 = time.time()
    n = lib.GbvScanImage(raw, len(raw), 0, out, cap)
    dt = (time.time() - t0) * 1000.0
    txt = out.raw[:n].decode('utf-8', 'replace') if n > 0 else ''
    try:
        d = json.loads(txt)
        print("call %d: %.1f ms B%d W%d" % (i + 1, dt, len(d.get('black') or []), len(d.get('white') or [])))
    except Exception as e:
        print("call %d: %.1f ms fail" % (i + 1, dt))
