# 直接按 gbpipe.cpp 服务端协议测管道 + 共享内存链路（训练器管道客户端的对偶验证）
import ctypes, json, struct, sys
from ctypes import wintypes

k32 = ctypes.windll.kernel32
GENERIC_READ_WRITE = 0xC0000000
OPEN_EXISTING = 3
PIPE_NAME = r"\\.\pipe\GomokuVision.recognize.8972"

h = k32.CreateFileW(PIPE_NAME, GENERIC_READ_WRITE, 0, None, OPEN_EXISTING, 0, None)
if h == -1 or h == 0xFFFFFFFFFFFFFFFF:
    print("pipe connect failed", ctypes.GetLastError()); sys.exit(1)
print("pipe connected")

def rd(n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_uint32(0)
    p = 0
    while p < n:
        if not k32.ReadFile(h, ctypes.byref(buf, p), n - p, ctypes.byref(got), None) or got.value == 0:
            raise IOError("read fail")
        p += got.value
    return buf.raw[:n]

def wr(data):
    got = ctypes.c_uint32(0)
    if not k32.WriteFile(h, data, len(data), ctypes.byref(got), None):
        raise IOError("write fail")

def frame(op, payload=b""):
    return b"GBV1" + struct.pack("<II", op, len(payload)) + payload

# HELLO（客户端正确姿势：读完 12B 头 + 8B payload）
wr(frame(1))
hdr = rd(12)
magic, op, plen = hdr[:4], struct.unpack("<I", hdr[4:8])[0], struct.unpack("<I", hdr[8:12])[0]
assert magic == b"GBV1", magic
pl = rd(plen)
ver, ready = struct.unpack("<II", pl)
print(f"HELLO ver={ver} ready={ready}")
assert ver == 1 and ready == 1, "model not ready"

# 共享内存：GBV_SHM_<pid>，64MB
img = open(r"C:\Users\harve\Desktop\media\img\微信图片_20260922113732_5_1.jpg", "rb").read()
shm_name = "GBV_SHM_TEST1"
shmsize = 64 * 1024 * 1024
sa = wintypes.SECURITY_ATTRIBUTES()
sa.nLength = ctypes.sizeof(sa)
sa.bInheritHandle = False
shm = k32.CreateFileMappingW(ctypes.c_void_p(-1).value, None, 0x04, shmsize >> 32, shmsize & 0xFFFFFFFF, shm_name)
if not shm:
    print("CreateFileMapping fail", ctypes.GetLastError()); sys.exit(1)
view = k32.MapViewOfFile(shm, 0x000F001F, 0, 0, 0)
ctypes.memmove(view, img, len(img))

extra = b'{"size":15}'
name_b = shm_name.encode()
payload = struct.pack("<I", len(name_b)) + name_b + struct.pack("<II", 0, len(img)) + struct.pack("<I", len(extra)) + extra
wr(frame(4, payload))  # OP_RECOGNIZE
hdr = rd(12)
assert hdr[:4] == b"GBV1", hdr[:4]
plen = struct.unpack("<I", hdr[8:12])[0]
resp = rd(plen)
status, rlen = struct.unpack("<II", resp[:8])
body = resp[8:8 + rlen]
print("status=", status, "resp bytes=", rlen)
j = json.loads(body)
print("ok=", j.get("ok"), "b=", len(j.get("black", [])), "w=", len(j.get("white", [])), "suspect=", j.get("suspect"))
