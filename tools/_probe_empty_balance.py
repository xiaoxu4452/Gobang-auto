# -*- coding: utf-8 -*-
"""Probe what BALANCETWO returns on an empty board under renju (dedicated
renju balance) vs freestyle."""
import subprocess, os, time

RAPFI_DIR = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\rapfi-native"
exe = os.path.join(RAPFI_DIR, "RapfiEngine-avx2.exe")

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

for rule, label in [("0", "freestyle"), ("2", "renju")]:
    cmds = ["START 15", "INFO RULE " + rule, "INFO TIMEOUT_TURN 4000",
            "YXBOARD DONE", "YXBALANCETWO 0"]
    r = run_cmds(cmds)
    print("=" * 55)
    print(label, "empty-board YXBALANCETWO 0:")
    for ln in r.splitlines()[:30]:
        t = ln.strip()
        print("   ", t)
