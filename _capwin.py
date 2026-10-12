# -*- coding: utf-8 -*-
"""Capture a window by title using PrintWindow (PW_RENDERFULLCONTENT)."""
import ctypes
from ctypes import wintypes
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PW_RENDERFULLCONTENT = 2

def find_windows_by_title(needle):
    out = []
    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if needle in buf.value:
            out.append((hwnd, buf.value))
        return True
    user32.EnumWindows(cb, 0)
    return out

needle = sys.argv[1] if len(sys.argv) > 1 else u'五子棋练习器'
wins = find_windows_by_title(needle)
if not wins:
    print('NO_WINDOW')
    sys.exit(1)

hwnd, title = wins[0]
rect = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
w = rect.right - rect.left
h = rect.bottom - rect.top
if w <= 0 or h <= 0:
    print('BAD_RECT', w, h, title.encode('utf-8'))
    sys.exit(1)

hdc = user32.GetWindowDC(hwnd)
if not hdc:
    print('NO_DC')
    sys.exit(1)

memdc = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(memdc, bmp)

ok = user32.PrintWindow(hwnd, memdc, PW_RENDERFULLCONTENT)
if not ok:
    # fallback: plain PrintWindow
    ok = user32.PrintWindow(hwnd, memdc, 0)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG),
        ('biHeight', wintypes.LONG), ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG),
        ('biYPelsPerMeter', wintypes.LONG), ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD),
    ]

bih = BITMAPINFOHEADER()
bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bih.biWidth = w
bih.biHeight = -h
bih.biPlanes = 1
bih.biBitCount = 32
bih.biCompression = 0
buf = ctypes.create_string_buffer(w * h * 4)
got = gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bih), 0)

gdi32.DeleteObject(bmp)
gdi32.DeleteDC(memdc)
user32.ReleaseDC(hwnd, hdc)

if not got:
    print('NO_BITS')
    sys.exit(1)

try:
    from PIL import Image
    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
    out = sys.argv[2] if len(sys.argv) > 2 else 'cap.png'
    img.save(out)
    print('SAVED', out, w, h, title.encode('utf-8'))
except Exception as e:
    print('PIL_FAIL', e)
    sys.exit(1)
