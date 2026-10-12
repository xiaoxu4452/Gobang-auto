# -*- coding: utf-8 -*-
# Compare old (v4.37-era) vs current vision DLL: timing + geometry + stone counts.
import ctypes, json, time, glob, os

OLD = r"C:\Users\harve\Desktop\Gobang auto\old\Meter Gomoku\Vision\GomokuVision.dll"
NEW = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Vision\GomokuVision.dll"

def load(p):
    d = ctypes.CDLL(p)
    d.GbvScanImage.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    d.GbvScanImage.restype = ctypes.c_int
    return d

def run(dll, img):
    out = ctypes.create_string_buffer(1 << 20)
    t0 = time.time()
    rc = dll.GbvScanImage(img.encode('utf-8'), out)
    ms = (time.time() - t0) * 1000
    if rc != 0:
        return None, ms
    try:
        j = json.loads(out.value.decode('utf-8'))
        return j, ms
    except Exception:
        return None, ms

old = load(OLD)
new = load(NEW)

imgs = glob.glob(r"C:\Users\harve\Desktop\Gobang auto\tools\_*.png")
imgs = sorted(imgs)
print("== per-image (first call, cold-ish) ==")
for img in imgs:
    if os.path.basename(img).startswith('_f'):
        continue
    ro, mo = run(old, img)
    rn, mn = run(new, img)
    def brief(r):
        if not r: return "ERR"
        g = r.get('geometry') or {}
        xs = g.get('x_lines') or []
        ys = g.get('y_lines') or []
        sp = round(g.get('spacing', 0), 2)
        return "n=%d B=%d W=%d sp=%.2f x0=%d x14=%d y0=%d y14=%d" % (
            r.get('size', 0), len(r.get('black', [])), len(r.get('white', [])), sp,
            (xs[0] if xs else -1), (xs[-1] if xs else -1),
            (ys[0] if ys else -1), (ys[-1] if ys else -1))
    print(os.path.basename(img))
    print("  OLD: %6.0fms  %s" % (mo, brief(ro)))
    print("  NEW: %6.0fms  %s" % (mn, brief(rn)))
