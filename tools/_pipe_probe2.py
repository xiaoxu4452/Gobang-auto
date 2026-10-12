# -*- coding: utf-8 -*-
"""临时探针（第二段）：验证共享内存那条腿 —— 识图窗用的 OP_SCAN_IMAGE / OP_RECOGNIZE。
与宿主 VisPipeCall 组帧逐字对偶：
  payload = [4B nameLen][name][4B off][4B len]               (+ OP_RECOGNIZE 时 [4B extraLen][extra])
  图像字节写进宿主创建的共享内存 GBV_SHM_<pid>，管道上只飞控制帧。
跑完杀掉服务，不留进程、不留文件。
"""
import ctypes
import ctypes.wintypes as wt
import os
import struct
import subprocess
import sys
import time
import zlib

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.CreateFileW.restype = wt.HANDLE
k32.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                            wt.DWORD, wt.DWORD, wt.HANDLE]
k32.CreateFileMappingW.restype = wt.HANDLE
k32.CreateFileMappingW.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                                   wt.DWORD, wt.DWORD, wt.LPCWSTR]
k32.MapViewOfFile.restype = ctypes.c_void_p
k32.MapViewOfFile.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_size_t]

GEN_R, GEN_W, OPEN_EXISTING, PAGE_READWRITE, FILE_MAP_WRITE = \
    0x80000000, 0x40000000, 3, 0x04, 0x0002
INVALID_HANDLE = ctypes.c_void_p(-1).value
CREATE_NO_WINDOW = 0x08000000

ROOT = r"C:\Users\harve\Desktop\Gobang auto"
EXE = os.path.join(ROOT, "Meter Gomoku", "Vision", "GomokuVision.exe")
SHM_NAME = "GBV_SHM_%d" % os.getpid()
SHM_SIZE = 64 * 1024 * 1024


def png_1x1(rgb=(255, 255, 255)):
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    raw = b'\x00' + bytes(rgb)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def open_pipe(name):
    h = k32.CreateFileW(name, GEN_R | GEN_W, 0, None, OPEN_EXISTING, 0, None)
    return None if (not h or h == INVALID_HANDLE) else h


def wr(h, data):
    n = wt.DWORD(0)
    return bool(k32.WriteFile(h, data, len(data), ctypes.byref(n), None)) and n.value == len(data)


def rd(h, n):
    buf = ctypes.create_string_buffer(n)
    got = wt.DWORD(0)
    if not k32.ReadFile(h, buf, n, ctypes.byref(got), None) or got.value != n:
        return None
    return buf.raw[:n]


def hello(h):
    if not wr(h, b"GBV1" + struct.pack("<II", 1, 0)):
        return None
    hdr = rd(h, 12)
    if not hdr or hdr[:4] != b"GBV1":
        return None
    return struct.unpack("<II", rd(h, struct.unpack("<I", hdr[8:12])[0])[:8])


def shm_call(name_bytes, off, size, opcode, extra=b""):
    h = open_pipe(name_bytes.decode())
    if not h:
        return ("pipe-fail", None)
    if not hello(h):
        return ("hello-fail", None)
    pl = struct.pack("<I", 0)  # placeholder
    return ("open", h)


def main():
    png = png_1x1()
    print("shared-memory leg probe (shm=%s, %d bytes png)" % (SHM_NAME, len(png)))
    sm = k32.CreateFileMappingW(wt.HANDLE(INVALID_HANDLE), None, PAGE_READWRITE,
                                0, SHM_SIZE, SHM_NAME)
    if not sm or sm == INVALID_HANDLE:
        print("FAIL: CreateFileMappingW err=%d" % ctypes.get_last_error())
        return 2
    view = k32.MapViewOfFile(sm, FILE_MAP_WRITE, 0, 0, SHM_SIZE)
    if not view:
        print("FAIL: MapViewOfFile err=%d" % ctypes.get_last_error())
        return 2
    ctypes.memmove(view, png, len(png))
    nb = SHM_NAME.encode()

    env = dict(os.environ)
    env.update(GB_RECOG_PORT="8974", GB_SCAN_PORT="8975", GB_PARENT_PID=str(os.getpid()))
    proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            creationflags=CREATE_NO_WINDOW)
    try:
        time.sleep(2.5)   # 等两个角色的管道实例都挂上
        plan = [
            (r"\\.\pipe\GomokuVision.scan.8975",      3, b"",             "OP_SCAN_IMAGE(scan:8975)"),
            (r"\\.\pipe\GomokuVision.recognize.8974", 4, b'{"size":15}',  "OP_RECOGNIZE(recognize:8974)"),
        ]
        fails = 0
        for pipe_name, opcode, extra, label in plan:
            h = open_pipe(pipe_name)
            if not h:
                print("FAIL %s: pipe not connectable" % label)
                fails += 1
                continue
            hv = hello(h)
            if not hv:
                print("FAIL %s: hello" % label)
                fails += 1
                continue
            pl = struct.pack("<I", len(nb)) + nb + struct.pack("<II", 0, len(png))
            if opcode == 4:
                pl += struct.pack("<I", len(extra)) + extra
            t = time.time()
            if not wr(h, b"GBV1" + struct.pack("<II", opcode, len(pl)) + pl):
                print("FAIL %s: write" % label)
                fails += 1
                continue
            hdr = rd(h, 12)
            if not hdr or hdr[:4] != b"GBV1":
                print("FAIL %s: bad header %r" % (label, hdr))
                fails += 1
                continue
            rp = rd(h, struct.unpack("<I", hdr[8:12])[0])
            status, rlen = struct.unpack("<II", rp[:8])
            resp = rp[8:8 + rlen].decode("utf-8", "replace")
            if status != 0:
                fails += 1
            print("%-28s status=%d  %.0f ms  resp=%s" %
                  (label, status, (time.time() - t) * 1000, resp[:150].replace("\n", " ")))
            # 注意：管道被服务端按“一请求一连接”处理后需重连，故每项都重新 open+hello
        print("VERDICT: 共享内存腿可用 ✓" if fails == 0 else "VERDICT: %d 项失败 ✗" % fails)
        return 0 if fails == 0 else 1
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        time.sleep(0.6)
        subprocess.run(["taskkill", "/F", "/IM", "GomokuVision.exe"], capture_output=True)


if __name__ == "__main__":
    sys.exit(main())
