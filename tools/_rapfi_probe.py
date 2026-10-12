# -*- coding: utf-8 -*-
"""Probe RapfiEngine YX protocol via file-based stdin (one shot per scenario)."""
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
assert exe, "no rapfi exe found"

def run_cmds(cmds, wait=18):
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

def probe(rule, title, board_cmds):
    cmds = ["START 15", "RECTSTART 15 15", "INFO RULE " + rule] + board_cmds + ["YXNBEST 3"]
    print("=" * 70)
    print("PROBE:", title, "RULE=" + rule)
    try:
        r = run_cmds(cmds)
        print(r[-5000:])
    except Exception as e:
        print("ERR", e)

# renju 2B1W: black(8,8) white(8,7) black(9,8) -> white to move
probe("2", "renju 2B1W (white to move)", ["YXBOARD 8,8,1 8,7,2 9,8,1 DONE"])
# freestyle same board
probe("0", "freestyle 2B1W", ["YXBOARD 8,8,1 8,7,2 9,8,1 DONE"])
# rule 5 probe
probe("5", "RULE 5 probe", ["YXBOARD 8,8,1 8,7,2 DONE"])
# renju 3B2W black to move
probe("2", "renju 3B2W (black to move)", ["YXBOARD 8,8,1 8,7,2 9,8,1 9,7,2 10,8,1 DONE"])
# renju with SELF/OPPO color semantics reversed: first stone color=2 -> selfColor=WHITE
probe("2", "renju 2W1B first-stone=2 (black to move?)", ["YXBOARD 8,8,2 8,7,1 9,8,2 DONE"])
