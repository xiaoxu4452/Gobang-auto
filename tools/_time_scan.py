# -*- coding: utf-8 -*-
import subprocess, time, json, os

dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
tools = r"C:\Users\harve\Desktop\Gobang auto\tools"

def run(dll, mode, p):
    t0 = time.time()
    r = subprocess.run([dll, mode, p], capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = (time.time() - t0) * 1000.0
    out = r.stdout.strip()
    try:
        d = json.loads(out)
        ok = d.get("ok")
        method = (d.get("diag") or {}).get("method") if isinstance(d.get("diag"), dict) else None
        return dt, ok, method
    except Exception:
        return dt, None, out[:80]

for name in ["_redword_test.png", "_zhizi_test_board.png"]:
    p = os.path.join(tools, name)
    for mode in ["--scan-image", "--recognize-image"]:
        dt, ok, m = run(dll, mode, p)
        print("%-22s %-18s %6.1f ms ok=%s %s" % (name, mode, dt, ok, m))
