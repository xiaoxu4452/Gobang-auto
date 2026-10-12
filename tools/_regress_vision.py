# -*- coding: utf-8 -*-
import subprocess, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
v = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
t = r"C:\Users\harve\Desktop\Gobang auto\tools"
cases = [
    ("_zhizi_test_board.png", (5, 12), "synthetic wood board"),
    ("_hard_board.png", (5, 5), "hard texture board"),
    ("_redcross_board.png", (5, 12), "red X over empty point"),
    ("_star_lion_board.png", (0, 0), "star + lion corner logo"),
    ("_star_board.png", (0, 0), "empty + 5 star points"),
    ("_redword_test.png", (10, 10), "user red-word white stone"),
]
ok_all = True
for f, exp, note in cases:
    p = subprocess.run([v, "--recognize-image", t + "\\" + f],
                       capture_output=True, timeout=60, encoding='utf-8', errors='replace')
    line = (p.stdout.strip().splitlines() or [""])[-1]
    if not line.startswith("{"):
        ok_all = False
        print(f"ERR  {f}: rc={p.returncode} out={line[:80]} err={p.stderr[:80]}")
        continue
    try:
        j = json.loads(line)
        b, w = j.get("black", []), j.get("white", [])
        bb = len(b) if isinstance(b, list) else int(b)
        ww = len(w) if isinstance(w, list) else int(w)
        status = "OK " if (bb, ww) == exp else "FAIL"
        if status == "FAIL": ok_all = False
        print(f"{status} {f}: black={bb} white={ww} total={bb+ww}  expect {exp}  ({note})")
    except Exception as e:
        ok_all = False
        print(f"ERR  {f}: {line[:120]}  ({e})")
print("ALL OK" if ok_all else "SOME FAILED")
