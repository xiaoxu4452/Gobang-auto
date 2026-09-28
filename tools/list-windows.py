#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""列出当前所有**可见**顶层窗口：hwnd / class / title / pid / rect。

排查「复盘新窗口到底有没有真的弹出来」这类问题用；比截图可靠（窗口可能在别的窗口后面）。
用法：python tools/_enumwin.py [过滤子串]
"""
import ctypes
import sys
from ctypes import wintypes

u = ctypes.windll.user32

u.GetWindowLongW.restype = ctypes.c_long
u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [wintypes.HWND]
u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


def info(hwnd):
    n = u.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 2)
    u.GetWindowTextW(hwnd, buf, n + 2)
    cls = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, cls, 256)
    pid = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    r = RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    return cls.value, buf.value, pid.value, r


rows = []


def cb(hwnd, _):
    if not u.IsWindowVisible(hwnd):
        return True
    cls, title, pid, r = info(hwnd)
    rows.append((hwnd, cls, title, pid, r))
    return True


u.EnumWindows(EnumProc(cb), 0)

flt = sys.argv[1] if len(sys.argv) > 1 else ''
for hwnd, cls, title, pid, r in rows:
    line = "%s | %-28s | pid=%-6d | %4d,%4d %4dx%-4d | %s" % (
        hex(hwnd), cls, pid, r.left, r.top,
        r.right - r.left, r.bottom - r.top, title)
    if not flt or flt.lower() in line.lower():
        print(line)
