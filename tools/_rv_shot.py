#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一次性验证（用完即删）：复盘窗在「先预热、过一会儿才开」这条真实路径下，
露脸时**到底画出来了没有**。

判据：截屏裁出 GbCalcReview 窗口区域 → 颜色种类 / 主色占比。
真画出来 = 棋盘格线 + 按键，颜色种类多、主色占比低；
没画出来（WebView2 一直挂着没出帧）= 一整块纯色，主色占比 ≈ 100%。
"""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes

from PIL import ImageGrab

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'desktop-calculator', 'build', 'Desktop GomokuTrainer.exe')
LOG = os.path.join(os.environ.get('TEMP', '.'), 'GomokuTrainer.log')
OUT = os.path.join(os.environ.get('TEMP', '.'), 'gb-rv-shot.png')

u = ctypes.windll.user32
u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.IsWindowVisible.argtypes = [wintypes.HWND]


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


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


def log_size():
    try:
        return os.path.getsize(LOG)
    except Exception:
        return 0


def log_since(off, n=200000):
    """只看**本次启动之后**新写的内容（老日志里也有同样那几行，不切开就会假绿）。"""
    try:
        with open(LOG, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(min(off, size))
            return f.read(n).decode('utf-8', 'replace')
    except Exception:
        return ''


def main():
    subprocess.run(['taskkill', '/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)

    env = dict(os.environ)
    env['GB_TEST_OPEN_REVIEW'] = '1'
    env['GB_TEST_OPEN_REVIEW_DELAY_MS'] = '7000'   # 预热(2.5s)早就完成了，7s 才"点复盘"
    from0 = log_size()
    p = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=0x00000008 | 0x00000200)  # DETACHED|NEW_PROCESS_GROUP
    try:
        t0 = time.time()
        shown = ack = warm = False
        while time.time() - t0 < 90:
            t = log_since(from0)
            warm = warm or ('[rv] prewarmed and hidden' in t)
            shown = shown or ('[rv] review window shown' in t)
            ack = ack or ('[rv] ack moves=9' in t)
            if shown and ack:
                break
            time.sleep(0.5)
        print('预热=%s 显示=%s 回执=%s 用时=%.1fs' % (warm, shown, ack, time.time() - t0))
        if not shown:
            print('--- 本次日志 ---')
            print(log_since(from0)[-2500:])
            return 1

        wins = find('GbCalcReview')
        if not wins:
            print('!! 枚举不到 GbCalcReview 可见窗口')
            return 1
        hwnd, r = wins[0]
        print('窗口 hwnd=%s rect=(%d,%d)-(%d,%d) %dx%d' %
              (hex(hwnd), r.left, r.top, r.right, r.bottom,
               r.right - r.left, r.bottom - r.top))
        time.sleep(0.8)                      # 让它把首帧交出来
        img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
        img.save(OUT)
        small = img.convert('RGB')
        colors = small.getcolors(maxcolors=1 << 22) or []
        colors.sort(reverse=True)
        total = small.size[0] * small.size[1]
        top = colors[0] if colors else (0, (0, 0, 0))
        print('截图 %s  尺寸=%dx%d  颜色种类=%d  主色=%s 占比=%.1f%%' %
              (OUT, small.size[0], small.size[1], len(colors), top[1],
               100.0 * top[0] / total))
        print('前 5 色: ' + ' | '.join('%s %.1f%%' % (c[1], 100.0 * c[0] / total)
                                       for c in colors[:5]))
        return 0
    finally:
        p.terminate()
        subprocess.run(['taskkill', '/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


sys.exit(main())
