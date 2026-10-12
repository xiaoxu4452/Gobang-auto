# -*- coding: utf-8 -*-
"""临时探针：验证「纯 C++ 硬链接」管线端到端可用。
流程 = 连线版实际做的：启动常驻视觉服务 → 连命名管道 GomokuVision.scan.8975 →
       HELLO 握手（拿 ver/ready）→ 发一帧 OP_SCAN（payload=[4B bodyLen][body]，服务端自抓屏）
       → 读 [4B status][4B len][resp]。跑完杀掉服务，不留进程。
不落盘、不写任何业务状态；只打印耗时与响应头部，用于证实通道通畅且快。
"""
import ctypes
import ctypes.wintypes as wt
import os
import struct
import subprocess
import sys
import time

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.CreateFileW.restype = wt.HANDLE
k32.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                            wt.DWORD, wt.DWORD, wt.HANDLE]
k32.ReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                         ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
k32.WriteFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                          ctypes.POINTER(wt.DWORD), ctypes.c_void_p]

GEN_R, GEN_W, OPEN_EXISTING = 0x80000000, 0x40000000, 3
INVALID_HANDLE = ctypes.c_void_p(-1).value
DETACHED_PROCESS, CREATE_NO_WINDOW = 0x00000008, 0x08000000

ROOT = r"C:\Users\harve\Desktop\Gobang auto"
EXE = os.path.join(ROOT, "Meter Gomoku", "Vision", "GomokuVision.exe")
SCAN_PIPE = r"\\.\pipe\GomokuVision.scan.8975"


def open_pipe(name):
    h = k32.CreateFileW(name, GEN_R | GEN_W, 0, None, OPEN_EXISTING, 0, None)
    if not h or h == INVALID_HANDLE:
        return None
    return h


def wr(h, data):
    n = wt.DWORD(0)
    ok = k32.WriteFile(h, data, len(data), ctypes.byref(n), None)
    return bool(ok) and n.value == len(data)


def rd(h, n):
    buf = ctypes.create_string_buffer(n)
    got = wt.DWORD(0)
    ok = k32.ReadFile(h, buf, n, ctypes.byref(got), None)
    if not ok or got.value != n:
        return None
    return buf.raw[:n]


def frame(opcode, payload=b""):
    return b"GBV1" + struct.pack("<II", opcode, len(payload)) + payload


def main():
    if not os.path.isfile(EXE):
        print("FAIL: vision exe not found: " + EXE)
        return 2
    print("starting vision service (pinned :8974/:8975, like the host does) ...")
    env = dict(os.environ)
    env["GB_RECOG_PORT"] = "8974"          # ★ 与宿主 EnsureVisionServer 的端口钉死同款：
    env["GB_SCAN_PORT"] = "8975"           #   管道名 GomokuVision.<role>.<port> 跟这两个走，
    env["GB_PARENT_PID"] = str(os.getpid())  # 不然服务会用默认 :8970/:8971（与书签/助手撞）
    proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            creationflags=CREATE_NO_WINDOW)
    try:
        h, t0 = None, time.time()
        while time.time() - t0 < 20.0:
            h = open_pipe(SCAN_PIPE)
            if h:
                break
            if proc.poll() is not None:
                out = proc.stdout.read().decode("utf-8", "replace") if proc.stdout else ""
                print("FAIL: service exited rc=%s; output:\n%s" % (proc.returncode, out))
                return 3
            time.sleep(0.3)
        if not h:
            print("FAIL: scan pipe never appeared within 20s (service still alive=%s)"
                  % (proc.poll() is None))
            try:
                print("pipes containing 'Gomoku': " + repr([p for p in os.listdir(r'\\.\pipe\\')
                                                           if "Gomoku" in p]))
            except Exception as e:
                print("pipe listing failed: %r" % (e,))
            return 3
        print("pipe connected in %.2fs" % (time.time() - t0))

        # ---- HELLO：帧头 12B + 0B payload → 应答 12B 头 + 8B [ver][ready] ----
        t1 = time.time()
        if not wr(h, frame(1)):
            print("FAIL: hello write")
            return 4
        hdr = rd(h, 12)
        if not hdr or hdr[:4] != b"GBV1":
            print("FAIL: bad hello header: %r" % (hdr,))
            return 5
        plen = struct.unpack("<I", hdr[8:12])[0]
        pl = rd(h, plen)
        ver, ready = struct.unpack("<II", pl[:8])
        print("HELLO ok  ver=%d ready=%d  (%.0f ms)" % (ver, ready, (time.time() - t1) * 1000))
        if not ready:
            print("WARN: model not ready -> 服务在但模型未加载（连线上会判死并拉起）")

        # ---- OP_SCAN：payload=[4B bodyLen][body]（GB_NO 管道版与 gbpipe.cpp parseRef 对偶）----
        body = b'{"size":15}'
        pl = struct.pack("<I", len(body)) + body
        t2 = time.time()
        if not wr(h, frame(2, pl)):
            print("FAIL: scan write")
            return 6
        hdr = rd(h, 12)
        if not hdr or hdr[:4] != b"GBV1":
            print("FAIL: bad scan header: %r" % (hdr,))
            return 7
        plen = struct.unpack("<I", hdr[8:12])[0]
        rp = rd(h, plen)
        status, rlen = struct.unpack("<II", rp[:8])
        resp = rp[8:8 + rlen].decode("utf-8", "replace")
        ms = (time.time() - t2) * 1000
        print("OP_SCAN ok  status=%d  bytes=%d  round-trip=%.0f ms" % (status, rlen, ms))
        print("resp head: " + resp[:200].replace("\n", " "))
        print("VERDICT: 管道新管线可用 ✓" if status == 0 else "VERDICT: status!=0，服务端拒了这帧 ✗")
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        time.sleep(0.6)
        subprocess.run(["taskkill", "/F", "/IM", "GomokuVision.exe"],
                       capture_output=True)


if __name__ == "__main__":
    sys.exit(main())
