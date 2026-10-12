# -*- coding: utf-8 -*-
"""Probe whether published RapfiEngine supports SWAP2BOARD under each rule."""
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
assert exe, "no rapfi exe"

def run_cmds(cmds, wait=14):
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

for rule, label in [("0", "freestyle"), ("1", "standard"), ("2", "renju")]:
    cmds = ["START 15", "INFO RULE " + rule, "SWAP2BOARD", "DONE"]
    print("=" * 60)
    print("RULE", rule, label)
    r = run_cmds(cmds)
    # show first 40 lines
    print("\n".join(r.splitlines()[:40]))
