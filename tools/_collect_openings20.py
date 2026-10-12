# -*- coding: utf-8 -*-
"""Collect 20 SWAP2BOARD samples per rule to find renju-specific openings."""
import subprocess, os, time

RAPFI_DIR = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\rapfi-native"
exe = os.path.join(RAPFI_DIR, "RapfiEngine-avx2.exe")

def run_cmds(cmds, wait=8):
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

from collections import Counter
for rule, label in [("0", "freestyle"), ("2", "renju")]:
    cnt = Counter()
    for k in range(20):
        r = run_cmds(["START 15", "INFO RULE " + rule, "SWAP2BOARD", "DONE"])
        coords = None
        for ln in r.splitlines():
            t = ln.strip()
            if t and not t.startswith(("MESSAGE", "OK", "ERROR")):
                coords = t
        if coords:
            cnt[coords] += 1
    print("=" * 50)
    print(label, "20 samples:")
    for c, n in cnt.most_common():
        print("  %2d x  %s" % (n, c))
