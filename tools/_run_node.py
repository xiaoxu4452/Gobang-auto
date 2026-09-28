import subprocess, sys, io, os

NODE = r"C:\Users\harve\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
ROOT = r"C:\Users\harve\Desktop\Gobang auto"

args = sys.argv[1:]
p = subprocess.run([NODE] + args, cwd=ROOT, capture_output=True)
out = p.stdout.decode("utf-8", errors="replace") + p.stderr.decode("utf-8", errors="replace")
io.open(os.path.join(ROOT, "desktop-overlay", "build", "_q.txt"), "w",
        encoding="utf-8", errors="replace").write(out)
print("exit", p.returncode)
