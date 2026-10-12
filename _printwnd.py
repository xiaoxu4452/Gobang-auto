# -*- coding: utf-8 -*-
# PrintWindow 抓取指定进程主窗内容（绕过屏幕合成不可见问题）
import ctypes, struct
from ctypes import wintypes

user32 = ctypes.WinDLL('user32.dll', use_last_error=True)
gdi32 = ctypes.WinDLL('gdi32.dll', use_last_error=True)

class RECT(ctypes.Structure):
    _fields_ = [('left', wintypes.LONG), ('top', wintypes.LONG),
                ('right', wintypes.LONG), ('bottom', wintypes.LONG)]

# 找进程
import subprocess
r = subprocess.run(['powershell', '-Command',
    "Get-Process -Id 38452 | Select-Object -ExpandProperty MainWindowHandle"],
    capture_output=True, text=True, timeout=15)
hwnd = int(r.stdout.strip())
print('hwnd', hex(hwnd))

rect = RECT()
user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top
print('rect', rect.left, rect.top, w, h)
if w <= 0 or h <= 0:
    raise SystemExit('empty rect')

hdc_window = user32.GetWindowDC(wintypes.HWND(hwnd))
hdc_mem = gdi32.CreateCompatibleDC(hdc_window)
bmp = gdi32.CreateCompatibleBitmap(hdc_window, w, h)
old = gdi32.SelectObject(hdc_mem, bmp)
ok = user32.PrintWindow(wintypes.HWND(hwnd), hdc_mem, 2)
print('PrintWindow ok', ok)

# BITMAPINFOHEADER
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]
bih = BITMAPINFOHEADER()
bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bih.biWidth = w; bih.biHeight = -h; bih.biPlanes = 1; bih.biBitCount = 32; bih.biCompression = 0

buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(hdc_mem, bmp, 0, h, buf, ctypes.byref(bih), 0)

# 保存 BMP（14 字节文件头 + 40 字节信息头）
import struct as st
header = b'BM' + st.pack('<IHHI', 54 + len(buf), 0, 0, 54)
info = st.pack('<IiiHHIIiiII', 40, w, h, 1, 32, 0, len(buf), 0, 0, 0, 0)
with open(r'C:\Users\harve\Desktop\Gobang auto\_wndshot.bmp', 'wb') as f:
    f.write(header)
    f.write(info)
    f.write(buf.raw)
print('saved _wndshot.bmp', w, h)

gdi32.SelectObject(hdc_mem, old)
gdi32.DeleteObject(bmp)
gdi32.DeleteDC(hdc_mem)
user32.ReleaseDC(wintypes.HWND(hwnd), hdc_window)
