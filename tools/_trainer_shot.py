#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓练习器主窗（GbCalcHost）的整窗截图 —— 改 UI 前先「看一眼现状」用。

为什么不用 Edge --headless --screenshot：那套在这张页面上**永不退出**（页面里的 AI Worker
把虚拟时间卡住，90~120s 后被 SIGTERM、无产物）。起真 exe 再截窗口是唯一稳的路子。

为什么用 PrintWindow 而不是 ImageGrab.grab(bbox)：bbox 抓的是**屏幕那一块**，
窗口要是被别的程序盖住（用户开着对弈平台），截出来的就是别人的脸（2026-09-20 实测踩过）。
PrintWindow + PW_RENDERFULLCONTENT 直接让目标窗口自己渲染 —— WebView2 也能出全内容。

用法：
  python _trainer_shot.py <out.png> [等待秒数] [窗口类名]
可选环境变量透传：GB_TEST_OPEN_REVIEW / GB_TEST_SAVE_POS 等（本脚本默认都不设，
即「正常启动 → 恢复上次那局」）。
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

# ★ 必须先标 per-monitor DPI 感知，再 import/调用 PIL 的截图入口。
#   本机主屏 3072×1920、DPI 168（=175%）：不标的话 GetWindowRect 给的是**逻辑像素**
#   (-7,-7)-(1762,1056)，而 ImageGrab 交出来的是**物理像素**整屏图 →
#   按逻辑矩形去裁物理图 = 只截到屏幕左上角那 57%，看着像「页面被放大了」。
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from PIL import Image            # noqa: E402  (必须在 DPI 设置之后)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'desktop-calculator', 'build', 'Desktop GomokuTrainer.exe')

u = ctypes.windll.user32
g = ctypes.windll.gdi32
u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [wintypes.HWND]


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


class BMI(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def find(cls_want):
    hit = []

    def cb(hwnd, _):
        if not u.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, buf, 256)
        if buf.value == cls_want:
            r = RECT()
            u.GetWindowRect(hwnd, ctypes.byref(r))
            hit.append((hwnd, r))
        return True

    u.EnumWindows(EnumProc(cb), 0)
    return hit


def grab_window(hwnd, w, h):
    """PrintWindow(PW_RENDERFULLCONTENT) —— 窗口自渲染，被遮挡也照抓。"""
    hdc = u.GetWindowDC(hwnd)
    mem = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, w, h)
    g.SelectObject(mem, bmp)
    ok = u.PrintWindow(hwnd, mem, 2)          # 2 = PW_RENDERFULLCONTENT
    bmi = BMI()
    bmi.biSize = ctypes.sizeof(BMI)
    bmi.biWidth = w
    bmi.biHeight = -h                          # 负 = 自上而下
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    g.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bmi), 0)
    g.DeleteObject(bmp)
    g.DeleteDC(mem)
    u.ReleaseDC(hwnd, hdc)
    if not ok:
        return None
    img = Image.frombuffer('RGB', (w, h), buf.raw, 'raw', 'BGRX', 0, 1)
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TEMP', '.'), 'trainer.png')
    wait = float(sys.argv[2]) if len(sys.argv) > 2 else 9.0
    cls = sys.argv[3] if len(sys.argv) > 3 else 'GbCalcHost'

    subprocess.run(['taskkill', '/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)

    p = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=dict(os.environ),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=0x00000008 | 0x00000200)  # DETACHED|NEW_PROCESS_GROUP
    try:
        t0 = time.time()
        wins = []
        while time.time() - t0 < wait + 25:
            wins = find(cls)
            if wins and time.time() - t0 >= wait:
                break
            time.sleep(0.5)
        if not wins:
            print('!! 枚举不到 %s 可见窗口' % cls)
            return 1
        hwnd, r = wins[0]
        w, h = r.right - r.left, r.bottom - r.top
        print('窗口 hwnd=%s rect=(%d,%d)-(%d,%d) %dx%d' % (hex(hwnd), r.left, r.top, r.right, r.bottom, w, h))
        time.sleep(1.0)
        u.SetForegroundWindow(hwnd)
        time.sleep(0.6)
        img = grab_window(hwnd, w, h)
        if img is None:
            print('!! PrintWindow 失败，回退 ImageGrab')
            from PIL import ImageGrab
            img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
        img.save(out)
        print('截图 %s  %dx%d' % (out, img.size[0], img.size[1]))
        return 0
    finally:
        p.terminate()
        subprocess.run(['taskkill', '/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


sys.exit(main())
