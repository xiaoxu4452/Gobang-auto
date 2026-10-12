# 用 media/img 训练图库批量验收当前视觉构建
import subprocess, json, glob, os, sys
EXE = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\build\GomokuVision.exe"
IMGS = sorted(glob.glob(r"C:\Users\harve\Desktop\media\img\*"))
for p in IMGS:
    for mode in ("--scan-image", "--recognize-image"):
        try:
            r = subprocess.run([EXE, mode, p], capture_output=True, timeout=90)
            out = r.stdout.decode("utf-8", "ignore").strip()
            line = out.split("\n").pop() if out else ""
            j = json.loads(line)
            b, w = len(j.get("black") or []), len(j.get("white") or [])
            rect = j.get("board_rect") or {}
            found = j.get("found")
            print(f"{os.path.basename(p)[:28]:30s} {mode[2:5]} found={found} b={b} w={w} rect={rect.get('w')}x{rect.get('h')}")
        except Exception as e:
            print(f"{os.path.basename(p)[:28]:30s} {mode[2:5]} ERROR {type(e).__name__} {(r.stdout[:80] if 'r' in dir() else e)}")
