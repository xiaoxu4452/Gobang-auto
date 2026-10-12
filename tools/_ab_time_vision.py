# -*- coding: utf-8 -*-
# A/B time the vision DLL: build current HEAD vs previous commit c2a77ee.
import subprocess, time, json, os, shutil

root = r"C:\Users\harve\Desktop\Gobang auto"
src = os.path.join(root, "desktop-vision", "src", "gbadaptive.cpp")
tools = os.path.join(root, "tools")
imgs = ["_zhizi_test_board.png", "_redword_test.png", "_redcross_board.png"]

def time_dll(dll):
    res = {}
    for name in imgs:
        p = os.path.join(tools, name)
        t0 = time.time()
        subprocess.run([dll, "--recognize-image", p], capture_output=True, text=True, encoding="utf-8", errors="replace")
        res[name] = (time.time() - t0) * 1000.0
    return res

# backup current source
shutil.copy2(src, src + ".bak")
try:
    # build prev commit version
    subprocess.run(["git", "-C", root, "show", "c2a77ee:desktop-vision/src/gbadaptive.cpp"],
                   stdout=open(src, "wb"), check=True)
    r = subprocess.run([r"C:\Program Files\Git\bin\bash.exe", "-lc", "bash tools/build-vision-msvc.sh"],
                       cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
    prev_dll = os.path.join(root, "desktop-vision", "build", "GomokuVision.exe")
    print("== prev (c2a77ee) ==")
    for k, v in time_dll(prev_dll).items():
        print("  %-24s %.1f ms" % (k, v))
finally:
    shutil.copy2(src + ".bak", src)

# rebuild current
r = subprocess.run([r"C:\Program Files\Git\bin\bash.exe", "-lc", "bash tools/build-vision-msvc.sh"],
                   cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
cur_dll = os.path.join(root, "desktop-vision", "build", "GomokuVision.exe")
print("== current (HEAD) ==")
for k, v in time_dll(cur_dll).items():
    print("  %-24s %.1f ms" % (k, v))
