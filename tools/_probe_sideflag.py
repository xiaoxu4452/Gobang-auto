# -*- coding: utf-8 -*-
"""Verify YXBOARD side-flag: same 2-stone position, engine must answer for
the side whose stones are marked SELF(1)."""
import subprocess, os, time

RAPFI_DIR = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\rapfi-native"
exe = os.path.join(RAPFI_DIR, "RapfiEngine-avx2.exe")
assert os.path.exists(exe)

def run_cmds(cmds, wait=16):
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

# Position: black1=(7,7) white2=(7,10) on 15x15 -> engine coords y flipped:
# black1 engine (7, 14-7=7), white2 engine (7, 14-10=4)
def test(label, flags):
    cmds = ["START 15", "INFO RULE 0",
            "YXBOARD 7,7," + flags[0] + " 7,4," + flags[1] + " DONE",
            "INFO TIMEOUT_TURN 4000", "YXNBEST 3"]
    r = run_cmds(cmds)
    lines = r.splitlines()
    print("=" * 50)
    print(label, "-> flags", flags)
    for ln in lines:
        t = ln.strip()
        if t and not t.startswith(("MESSAGE", "OK", "ERROR")):
            print("  ", t)
    # final line is the best move (engine coords)
    final = lines[-1].strip() if lines else ""
    print("  BEST:", final)

# AI plays black: black=SELF(1), white=OPPO(2). 2 stones -> black to move.
test("AI black (black SELF)", ["1", "2"])
# AI plays white: white=SELF(1), black=OPPO(2). 2 stones -> white to move.
test("AI white (white SELF)", ["2", "1"])
