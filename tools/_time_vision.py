# -*- coding: utf-8 -*-
# Time the recognition path of the current DLL on a few images.
import subprocess, time, json, os

dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
tools = r"C:\Users\harve\Desktop\Gobang auto\tools"
imgs = ["_zhizi_test_board.png", "_redword_test.png", "_hard_board.png", "_redcross_board.png"]

for name in imgs:
    p = os.path.join(tools, name)
    t0 = time.time()
    r = subprocess.run([dll, "--recognize-image", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = (time.time() - t0) * 1000.0
    d = json.loads(r.stdout.strip())
    nb, nw = len(d.get("black") or []), len(d.get("white") or [])
    print("%-24s %.1f ms  B%d W%d  method=%s" % (name, dt, nb, nw, (d.get("diag") or {}).get("method")))
