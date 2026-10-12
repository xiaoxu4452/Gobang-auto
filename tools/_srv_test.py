# -*- coding: utf-8 -*-
# Verify server-mode scan latency: (A) plain fullscreen (current main-UI path),
# (B) with locked geometry (link path after first lock). Uses the HTTP service.
import subprocess, time, json, os, signal

EXE = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.exe"
TOOLS = r"C:\Users\harve\Desktop\Gobang auto\tools"

# 1) launch service
proc = subprocess.Popen([EXE, "--scan"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

import urllib.request

def post(path, body):
    req = urllib.request.Request("http://127.0.0.1:8971" + path,
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode()
    dt = (time.time() - t0) * 1000.0
    return dt, raw

# 2) first scan: plain fullscreen, get geometry
dt1, raw1 = post("/scan", {"size": 15})
d1 = json.loads(raw1)
geo = d1.get("geometry") or {}
print("A plain fullscreen: %.0f ms found=%s" % (dt1, d1.get("found")))

if geo and geo.get("x_lines") and geo.get("y_lines"):
    lock = {"size": 15,
            "geometry": {"x_lines": geo["x_lines"], "y_lines": geo["y_lines"],
                          "spacing": geo.get("spacing", 30)}}
    times = []
    for i in range(4):
        dt, raw = post("/scan", lock)
        dd = json.loads(raw)
        times.append(dt)
        print("B locked #%d: %.0f ms B%d W%d" % (i + 1, dt,
              len(dd.get("black") or []), len(dd.get("white") or [])))
    print("B locked avg: %.0f ms" % (sum(times) / len(times)))
else:
    print("no geometry returned")

# 3) quit
try:
    post("/quit", {})
except Exception:
    pass
proc.wait(timeout=5)
