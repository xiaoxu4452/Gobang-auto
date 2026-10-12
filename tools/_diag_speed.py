# -*- coding: utf-8 -*-
import json, subprocess, os, time

dll = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
tools = r"C:\Users\harve\Desktop\Gobang auto\tools"
imgs = ["_zhizi_test_board.png", "_redword_test.png", "_hard_board.png", "_redcross_board.png", "_star_board.png"]

for name in imgs:
    p = os.path.join(tools, name)
    t0 = time.time()
    r = subprocess.run([dll, "--recognize-image", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = (time.time() - t0) * 1000.0
    d = json.loads(r.stdout.strip())
    g = d.get("geometry") or {}
    diag = d.get("diag") or {}
    print("%-22s %6.1f ms src=%-6s conf=%.2f diag=%s picked=%s" % (
        name, dt, g.get("source"), g.get("confidence", 0), diag.get("method"), diag.get("picked")))
