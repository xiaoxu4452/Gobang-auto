# -*- coding: utf-8 -*-
"""DLL 硬连接契约验证：ctypes LoadLibrary 后直调导出（模拟宿主进程内调用）"""
import ctypes, sys, json, base64

DLL = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\build\GomokuVision.dll"
IMG = r"C:\Users\harve\.workbuddy\clipboard-images\clipboard-2026-10-03T14-53-30-256Z-d3fe7b69.png"

dll = ctypes.CDLL(DLL)
dll.GbvVersion.restype = ctypes.c_int

def _call(fn, args_tuple, cap=1 << 22):
    """返回 (n, bytes)；cap 不足按宿主同口径扩容重试"""
    def invoke(buf, c):
        a = args_tuple + (buf, c)
        return fn(*a)
    buf = ctypes.create_string_buffer(cap)
    n = invoke(buf, cap)
    if n < 0:
        buf = ctypes.create_string_buffer(-n)
        n = invoke(buf, -n)
    return n, buf.raw[:n] if n >= 0 else b""

dll.GbvRecognizeJson.restype = ctypes.c_int
dll.GbvScanImage.restype = ctypes.c_int

print("GbvVersion =", dll.GbvVersion())
raw = open(IMG, "rb").read()
b64 = base64.b64encode(raw)

# 1) GbvRecognizeJson(req, len, out, cap) —— 训练器识图窗走的导出（mode=image）
req = b'{"mode":"image","image":"' + b64 + b'","size":15}'
n, resp = _call(dll.GbvRecognizeJson, (req, len(req)))
d = json.loads(resp.decode("utf-8", "replace"))
print("GbvRecognizeJson: bytes=%d ok=%s black=%d white=%d" %
      (n, d.get("ok"), len(d.get("black", [])), len(d.get("white", []))))
assert n > 100 and d.get("ok") is True, "recognize hard-connect BROKEN"

# 2) GbvScanImage(img, len, probe, out, cap)
n2, resp2 = _call(dll.GbvScanImage, (raw, len(raw), 0))
d2 = json.loads(resp2.decode("utf-8", "replace"))
print("GbvScanImage: bytes=%d ok=%s found=%s black=%d white=%d" %
      (n2, d2.get("ok"), d2.get("found"), len(d2.get("black", [])), len(d2.get("white", []))))
assert n2 > 100 and d2.get("ok") and d2.get("found"), "scan-image hard-connect BROKEN"

print("HARD-CONNECT CONTRACT OK")
