# -*- coding: utf-8 -*-
"""Collect SWAP2BOARD openings per rule (multiple runs to sample the book)."""
import subprocess, os, time

RAPFI_DIR = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\rapfi-native"
CAND = ["RapfiEngine-avx2.exe", "RapfiEngine-avx512.exe", "RapfiEngine-avx512vnni.exe",
        "RapfiEngine-avxvnni.exe", "RapfiEngine-sse.exe"]
exe = None
for c in CAND:
    p = os.path.join(RAPFI_DIR, c)
    if os.path.exists(p):
        exe = p
        break
assert exe

def run_cmds(cmds, wait=12):
    inp = os.path.join(RAPFI_DIR, "_probe_in.txt")
    outp = os.path.join(RAPFI_DIR, "_probe_out.txt")
    with open(inp, "w") as f:
        for c in cmds:
            f.write(c + "\n")
        f.write("END\n")
    try:
        os.remove(outp)
    except Exception:
        pass
    proc = subprocess.Popen([exe], cwd=RAPFI_DIR, stdin=open(inp, "rb"),
                            stdout=open(outp, "wb"), stderr=subprocess.STDOUT)
    time.sleep(wait)
    proc.kill()
    proc.wait()
    try:
        with open(outp, "r", errors="replace") as f:
            return f.read()
    except Exception as e:
        return "READERR:" + str(e)

# 5 runs per rule, collect the SWAP2BOARD reply (last numeric line)
for rule, label in [("0", "freestyle"), ("2", "renju")]:
    found = []
    for k in range(5):
        cmds = ["START 15", "INFO RULE " + rule, "SWAP2BOARD", "DONE"]
        r = run_cmds(cmds)
        # reply line: line with only coords
        coords = None
        for ln in r.splitlines():
            t = ln.strip()
            if t and not t.startswith(("MESSAGE", "OK", "ERROR")):
                coords = t
        found.append(coords)
    print(label, "->", found)
