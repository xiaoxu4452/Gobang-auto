# -*- coding: utf-8 -*-
"""临时取证：找到连线版「框选棋盘」中空框窗，并用**真鼠标**点它的「自动」键。

为什么要真鼠标：框窗的 WM_LBUTTONUP 里有一道 `if (!GetCapture()) return 0;` ——
SetCapture 只有在鼠标键真的按下（或窗口是前台）时才会成功；用 PostMessage 灌消息
拿不到 capture，点击会被吞掉。所以这里走 SetCursorPos + mouse_event（和宿主自己的
"real" 落子管线同一套路），框窗是 TOPMOST，命中可靠。

用法：python tools/_lsel_click.py [auto|rec]
  auto = 点「自动」键（左数第二个右对齐键）→ 全屏自动找盘 → 触发 OP_SCAN 扫描帧
  rec  = 点「识别」键（左数第一个）→ LselApplyRegion → 同样触发扫描帧
几何来源：host.cpp LselPaint —— LSEL_TITLE_H=44 LSEL_BTN2_W=78 LSEL_BTN_GAP=8 LSEL_EDGE=8
  bx3 = W-86(关闭)  bx2 = W-172(自动)  bx1 = W-258(识别)   按钮高 bh=36, by=4
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

u32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)

TITLE_H, BTN_W, BTN_GAP, EDGE = 44, 78, 8, 8
GWL_EXSTYLE = -20
WS_EX_TOPMOST, WS_EX_LAYERED, WS_EX_TOOLWINDOW = 0x8, 0x80000, 0x80
WM_GETTEXT = 0x000D
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004

u32.GetWindowLongW.restype = ctypes.c_long
u32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
u32.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.EnumWindows.argtypes = [ctypes.c_void_p, wt.LPARAM]

ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def trainer_pid():
    import subprocess
    out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Desktop GomokuTrainer.exe', '/FO', 'CSV', '/NH'],
                         capture_output=True, text=True).stdout.strip()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower().startswith('desktop'):
            return int(parts[1])
    return None


def find_frame(pid):
    hits = []

    def cb(hwnd, _):
        wpid = wt.DWORD(0)
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value != pid or not u32.IsWindowVisible(hwnd):
            return True
        cls = ctypes.create_unicode_buffer(64)
        u32.GetClassNameW(hwnd, cls, 64)
        ex = u32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        if cls.value == 'Static' and (ex & WS_EX_LAYERED) and (ex & WS_EX_TOOLWINDOW):
            rc, cr = wt.RECT(), wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(rc))
            u32.GetClientRect(hwnd, ctypes.byref(cr))
            hits.append((hwnd, rc, cr.right, cr.bottom, ex))
        return True

    u32.EnumWindows(ENUMPROC(cb), 0)
    return hits


def click(hwnd, cx, cy):
    org = wt.POINT(0, 0)
    u32.ClientToScreen(hwnd, ctypes.byref(org))
    sx, sy = org.x + cx, org.y + cy
    u32.SetCursorPos(sx, sy)
    time.sleep(0.12)
    u32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.09)
    u32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    return sx, sy


def main():
    which = (sys.argv[1] if len(sys.argv) > 1 else 'auto').lower()
    pid = trainer_pid()
    if not pid:
        print("FAIL: trainer not running")
        return 2
    hits = find_frame(pid)
    print("pid=%d  frame windows=%d" % (pid, len(hits)))
    for h, rc, w, hh, ex in hits:
        print("  hwnd=0x%X rect=(%d,%d)-(%d,%d) client=%dx%d ex=0x%X"
              % (h, rc.left, rc.top, rc.right, rc.bottom, w, hh, ex))
    if not hits:
        print("FAIL: no frame window (先点「框选棋盘」)")
        return 3
    hwnd, rc, W, H, ex = hits[0]
    bx = {'auto': W - EDGE - BTN_W - BTN_GAP - BTN_W, 'rec': W - EDGE - 3 * BTN_W - 2 * BTN_GAP}[which]
    cx, cy = bx + BTN_W // 2, 4 + 36 // 2
    print("click %s: client=(%d,%d) of %dx%d" % (which, cx, cy, W, H))
    sx, sy = click(hwnd, cx, cy)
    print("clicked at screen (%d,%d)" % (sx, sy))
    return 0


if __name__ == '__main__':
    sys.exit(main())
