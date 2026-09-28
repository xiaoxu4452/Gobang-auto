#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真实环境取证：面板底部条「局面」键的**观感**与**点击链路**。

要回答三个问题（用户 2026-09-18 现场反馈）：
  ① 浅色模式下这个键是不是「白底 + 浅绿」（配色不协调）；
  ② 它**周围**的区域是不是不透明的一整条（面板别处是半透明的）；
  ③ 真实鼠标点在它身上，到底有没有走到宿主（日志里有没有
     `[ui] panel received footbar click` / `openPos` / `[pos] position window opened`）。

顺带量一件与本轮改动直接相关的事：
  ④ 现状下「局面」小窗**会不会被 ImageGrab 拍进截图**（识别服务能不能免疫它）。
     判据：小窗标题栏的品牌蓝 (59,125,216) 在整屏截图里有没有出现。

做法与判据都不依赖任何「测试专用」入参以外的假设：
  · 启动发布版 exe（自带日志），等面板/注入稳定；
  · 按**窗口类名**找到面板窗口，取它的窗口矩形；
  · 截面板 → 按浅绿 (#eaf6ec) 找到按钮的实际矩形 —— 这也正是用户在抱怨的那个色；
  · 用真实鼠标事件（SetCursorPos + mouse_event）点在按钮中心；
  · 读日志 + 查小窗是否真的建出来（FindWindowW("GbPositionHost")）。

用法：python tools/_probe_footbar.py
输出：一行 JSON + 若干 PNG（面板截图 / 整屏截图），日志留在 tools/_forensic.log。
"""
import ctypes
import json
import os
import re
import subprocess
import sys
import time
from ctypes import wintypes

u32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    u32.SetProcessDPIAware()

from PIL import ImageGrab            # noqa: E402
import numpy as np                   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'Meter engine-server', 'Desktop GomokuOverlay.exe')
LOG = os.path.join(ROOT, 'tools', '_forensic.log')
PANEL_PNG = os.path.join(ROOT, 'tools', '_forensic_panel.png')
FOOT_PNG = os.path.join(ROOT, 'tools', '_forensic_footbar.png')
FULL_PNG = os.path.join(ROOT, 'tools', '_forensic_full.png')

DETACHED_PROCESS = 0x00000008
CREATE_NO_WINDOW = 0x08000000

# 面板底栏按钮当前的浅色配色（见 tools/extract-panel-ui.js 的 POS_ROW）
BTN_BG = (234, 246, 236)      # #eaf6ec
BTN_FG = (46, 125, 50)        # #2e7d32
BRAND = (59, 125, 216)        # 局面小窗的标题栏品牌蓝


def find_windows_by_class(cls):
    out = []
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    u32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

    def cb(hwnd, _lp):
        buf = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, buf, 256)
        if buf.value == cls:
            out.append(hwnd)
        return True
    _cb = CB(cb)
    u32.EnumWindows(_cb, 0)
    return out


def wrect(h):
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def click_at(x, y):
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    u32.mouse_event(0x0002, 0, 0, 0, 0)      # LEFTDOWN
    time.sleep(0.06)
    u32.mouse_event(0x0004, 0, 0, 0, 0)      # LEFTUP


VX = u32.GetSystemMetrics(76)          # 虚拟屏原点（多屏时可能为负）
VY = u32.GetSystemMetrics(77)


def log_text():
    try:
        with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        return '<<no log: %s>>' % e


def win_from_point(x, y):
    """点 (x,y) 处最上层的窗口是谁 —— 判断一记真实点击到底会落到哪个窗口上。

    这一步是「点了没反应」这类故障的分水岭：
      · 命中的是面板/WebView2 子窗 → 点击送到了网页那边，问题在页面/派发；
      · 命中的是**别的**窗口（残留实例、控制台、别的软件）→ 用户点的压根不是我们的按钮。
    """
    pt = wintypes.POINT(int(x), int(y))
    h = u32.WindowFromPoint(pt)
    if not h:
        return None
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, buf, 256)
    pid = wintypes.DWORD()
    u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    tb = ctypes.create_unicode_buffer(256)
    u32.GetWindowTextW(h, tb, 256)
    return {'hwnd': int(h), 'class': buf.value, 'pid': int(pid.value),
            'title': tb.value, 'rect': wrect(h)}


def belongs_to(hwin, top):
    """hwin 是不是 top 这棵窗口树里的（自己是或祖先链里有 top）。"""
    h = hwin
    for _ in range(8):
        if not h:
            return False
        if h == top:
            return True
        h = u32.GetParent(h)
    return False


def clickable_scan(top, x, y0, y1):
    """沿某一列扫「这一点的点击会不会落到 top 里」→ 找出可点区与不可点区的分界。

    这就是「底栏按键点不动」这类故障的**直接成因**：窗口 region 若比窗口本身矮一截，
    WebView2 的内容（走 DComp 视觉树）照样画得出来，但**命中测试被 region 挡在外面**，
    那一条上的点击会穿透到桌面/别的窗口上 —— 画面看着好好的，点下去毫无反应。
    """
    res = []
    step = 8
    cur = None
    for y in range(y0, y1 + 1, step):
        pt = wintypes.POINT(int(x), int(y))
        h = u32.WindowFromPoint(pt)
        inside = belongs_to(h, top)
        if cur is None or cur[2] != inside:
            if cur:
                res.append(cur)
            cur = [y, y, inside]
        else:
            cur[1] = y
    if cur:
        res.append(cur)
    return res


def window_region(h):
    """窗口 region 的外接矩形（窗口坐标系）—— 与窗口尺寸比对就知道 region 是不是过期了。"""
    r = wintypes.RECT()
    hr = ctypes.windll.gdi32.CreateRectRgn(0, 0, 0, 0)
    kind = u32.GetWindowRgn(h, hr)
    box = None
    if kind and kind != 1:            # 1 = NULLREGION；2 = SIMPLEREGION，3 = COMPLEXREGION
        ctypes.windll.gdi32.GetRgnBox(hr, ctypes.byref(r))
        box = [r.left, r.top, r.right, r.bottom]
    ctypes.windll.gdi32.DeleteObject(hr)
    return {'kind': int(kind), 'box': box, 'window': wrect(h)}


def click_css(report, btns, key, dpr, px, py):
    if not btns.get(key):
        return {'key': key, 'skipped': 'no usable geometry'}
    cx_css = btns[key][0] + btns[key][2] / 2.0
    cy_css = btns[key][1] + btns[key][3] / 2.0
    cx = px + int(round(cx_css * dpr))
    cy = py + int(round(cy_css * dpr))
    before = len(log_text())
    hit = win_from_point(cx, cy)
    # 真实鼠标点击前先确认光标真的停在目标上（用户若正在动鼠标，这一记会打到别处 —— 实测遇到过）
    for _ in range(5):
        u32.SetCursorPos(int(cx), int(cy))
        time.sleep(0.08)
        cp = wintypes.POINT()
        u32.GetCursorPos(ctypes.byref(cp))
        if abs(cp.x - cx) <= 2 and abs(cp.y - cy) <= 2:
            break
    click_at(cx, cy)
    time.sleep(1.8)
    t = log_text()[before:]
    return {'key': key, 'at': [cx, cy], 'hit_window': hit,
            'footClick': (key in t and 'footClick' in t),
            'openPos': 'openPos' in t,
            'log_tail': [l for l in t.splitlines() if '[ui]' in l or '[pos]' in l][-4:]}


def children_of(top):
    out = []
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _lp):
        out.append(_desc(h))
        return True
    _cb = CB(cb)
    u32.EnumChildWindows(top, _cb, 0)
    return out


def _desc(h):
    if not h:
        return None
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, buf, 256)
    pid = wintypes.DWORD()
    u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    return {'hwnd': int(h), 'class': buf.value, 'pid': int(pid.value), 'rect': wrect(h)}


def scan_column(top, x, y0, y1, step=4):
    """沿一列量「每个 Y 上 WindowFromPoint 是谁」——把可点/不可点的分界与**罪魁窗口**一起报出来。"""
    res, last = [], None
    for y in range(y0, y1 + 1, step):
        pt = wintypes.POINT(int(x), int(y))
        h = u32.WindowFromPoint(pt)
        d = _desc(h)
        inside = belongs_to(h, top)
        key = (inside, d['class'] if d else None, d['pid'] if d else None)
        if key != last:
            res.append({'yFrom': y, 'yTo': y, 'inside': inside, 'win': d})
            last = key
        else:
            res[-1]['yTo'] = y
    return res


def pick_btn_css(txt, key='__gb_pos'):
    """从日志里挑**当前版式**下那个键的几何。

    ★ 必须挑「hit=…(OK)」的那条：面板启动期会先按旧版式报一次（实测出现过
      `__gb_pos=[13,614 186x34 bottom=648 视口外! hit=null(被挡!)]`），按它算出来的坐标
      会偏 30px —— 上一轮就是这么把点击打到任务栏上的。
    """
    best = None
    for l in txt.splitlines():
        m = re.search(key + r'=\[(-?\d+),(-?\d+) (\d+)x(\d+)', l)
        if not m:
            continue
        if '(OK)' not in l:
            continue
        best = [int(m.group(i)) for i in range(1, 5)]
    return best


def step_panel(report, pr, txt, pr_hwnd):
    """截面板 → 用**页面自己上报的按钮几何**（CSS px × dpr）算屏幕坐标 → 真实鼠标点它。

    为什么不再按颜色找按钮：面板里成片都是浅色（近白），#eaf6ec 那点绿根本分不出来
    （实测整块面板里"近似 #eaf6ec"的像素有 2.8 万个，bbox 直接铺满面板）。
    页面侧的 footProbe 报的是 getBoundingClientRect()，再乘 dpr 就是物理像素，最可信。
    """
    full = ImageGrab.grab(all_screens=True)
    full.save(FULL_PNG)
    pa = np.asarray(full.convert('RGB')).astype(np.int32)
    px, py, pw, phh = pr

    # ---- 从日志里取 dpr 与按钮几何 ----
    dpr = 1.873
    for l in reversed(txt.splitlines()):
        m = re.search(r'\[panel\] applied geometry window=\(-?\d+,-?\d+\) \d+x\d+ '
                      r'panelCSS=\d+x\d+ dpr=([\d.]+)', l)
        if m:
            dpr = float(m.group(1))
            break
    report['dpr'] = dpr
    # 两个键的页面坐标都取出来：__gb_pos（用户点不动的那个）与 __gb_adjust（中部，
    # 历史日志里它被真实点中过 3 次）—— 后者是**对照组**：它要是能点动，
    # 就说明「点击送达面板」这条链是通的，问题只出在底栏这一块。
    pos_css = pick_btn_css(txt, '__gb_pos')
    adj_css = pick_btn_css(txt, '__gb_adjust')
    report['btn_css'] = pos_css
    report['btn_css_adjust'] = adj_css
    if not pos_css:
        report['err2'] = 'footProbe never reported a *usable* __gb_pos geometry'
        return

    # ---- 底栏带（按钮上下各留 6px 余量）与面板主体，分别取均色 ----
    def band(x0, y0, x1, y1):
        """面板内相对物理像素 → 屏幕数组切片（自动夹到合法范围、保证非空）。"""
        X0 = max(0, px + x0 - VX)
        X1 = min(pa.shape[1], max(X0 + 1, px + x1 - VX))
        Y0 = max(0, py + y0 - VY)
        Y1 = min(pa.shape[0], max(Y0 + 1, py + y1 - VY))
        return pa[Y0:Y1, X0:X1]

    bx, by, bw, bh = [int(round(v * dpr)) for v in pos_css]
    report['btn_phys'] = [bx, by, bw, bh]
    btns = {'__gb_pos': pos_css, '__gb_adjust': adj_css}
    foo = band(0, max(0, by - 6), pw, min(phh, by + bh + 6))
    report['footbar_strip_mean'] = [int(v) for v in foo.reshape(-1, 3).mean(axis=0)]
    # 按钮左边那 10px（底栏的 padding 区）——「它周围」到底透不透就看这里
    left = band(0, by, max(1, bx - 8), by + bh)
    report['bar_left_of_btn'] = [int(v) for v in left.reshape(-1, 3).mean(axis=0)]
    report['btn_mean'] = [int(v) for v in band(bx, by, bx + bw, by + bh)
                          .reshape(-1, 3).mean(axis=0)]
    # 面板主体（中部：卡片区），用来对照「别处是半透明的、这条是不透明的」
    report['panel_body_mean'] = [int(v) for v in
                                 band(4, int(phh * 0.45), pw - 4, int(phh * 0.45) + 40)
                                 .reshape(-1, 3).mean(axis=0)]
    # 面板左边 30px 处（= 桌面本身），作为「底」的参考
    report['desktop_left_of_panel'] = [int(v) for v in band(-30, int(phh * 0.45),
                                                           -8, int(phh * 0.45) + 40)
                                       .reshape(-1, 3).mean(axis=0)]
    # 底栏特写图（人眼复核用）
    ImageGrab.grab(bbox=(px, py + max(0, by - 30), px + pw, py + min(phh, by + bh + 30)),
                   all_screens=True).save(FOOT_PNG)

    # ---- 真实鼠标点击：先查落点窗口，再点，再查日志 ----
    report['panel_region'] = window_region(pr_hwnd)
    report['panel_children'] = children_of(pr_hwnd)
    col0, col1 = max(0, py - VY) + 40, min(pa.shape[0] - 1, py - VY + phh - 2)
    report['column_before'] = scan_column(pr_hwnd, px + pw // 2, col0, col1)
    report['click_pos'] = click_css(report, btns, '__gb_pos', dpr, px, py)
    report['click_adjust_control'] = click_css(report, btns, '__gb_adjust', dpr, px, py)

    # ---- 实验：把完整几何再下发一次（+SWP_FRAMECHANGED），可点区会不会整块恢复 ----
    x0, y0, w, h = pr
    SWP_NOACTIVATE, SWP_FRAMECHANGED = 0x0010, 0x0020
    u32.SetWindowPos(pr_hwnd, -1, x0, y0, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED)
    time.sleep(0.5)
    report['column_after_resetpos'] = scan_column(pr_hwnd, px + pw // 2, col0, col1)
    report['click_pos_after_resetpos'] = click_css(report, btns, '__gb_pos', dpr, px, py)
    # ---- 实验二：照当前尺寸重新 SetWindowRgn 一次 ----
    hr = ctypes.windll.gdi32.CreateRectRgn(0, 0, w + 1, h + 1)
    u32.SetWindowRgn(pr_hwnd, hr, True)
    time.sleep(0.5)
    report['column_after_setregion'] = scan_column(pr_hwnd, px + pw // 2, col0, col1)
    report['click_pos_after_setregion'] = click_css(report, btns, '__gb_pos', dpr, px, py)
    report['region_after'] = window_region(pr_hwnd)

    def scan_and_click(tag):
        time.sleep(0.5)
        col = scan_column(pr_hwnd, px + pw // 2, col0, col1)
        res = click_css(report, btns, '__gb_pos', dpr, px, py)
        report['column_' + tag] = col
        report['click_' + tag] = res
        return col, res

    GWL_EXSTYLE = -20
    WS_EX_LAYERED = 0x00080000
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER = 0x0001, 0x0002, 0x0004

    # ---- 实验三：真正改一次尺寸再改回来（强制走一遍 WM_SIZE 路径）----
    u32.SetWindowPos(pr_hwnd, 0, x0, y0, w, h + 1, SWP_NOACTIVATE | SWP_NOZORDER)
    u32.SetWindowPos(pr_hwnd, 0, x0, y0, w, h,
                     SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED)
    scan_and_click('after_resize')

    # ---- 实验四：隐藏再显示 ----
    u32.ShowWindow(pr_hwnd, 0)                     # SW_HIDE
    time.sleep(0.3)
    u32.ShowWindow(pr_hwnd, 8)                     # SW_SHOWNA
    scan_and_click('after_hideshow')

    # ---- 实验五：把 WS_EX_LAYERED 摘掉再加回来（刷新分层窗口的命中表面）----
    ex = u32.GetWindowLongW(pr_hwnd, GWL_EXSTYLE) & 0xFFFFFFFF
    u32.SetWindowLongW(pr_hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED)
    u32.SetWindowPos(pr_hwnd, 0, 0, 0, 0, 0,
                     SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
    time.sleep(0.3)
    u32.SetWindowLongW(pr_hwnd, GWL_EXSTYLE, ex)
    u32.SetWindowPos(pr_hwnd, 0, 0, 0, 0, 0,
                     SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
    scan_and_click('after_layered_toggle')


def main():
    env = dict(os.environ)
    env['GB_LOG_FILE'] = LOG
    env['GB_INSTANCE_ID'] = 'forensic'
    if os.path.exists(LOG):
        try:
            os.remove(LOG)
        except Exception:
            pass
    if not os.path.exists(EXE):
        print(json.dumps({'err': 'exe not found', 'exe': EXE}))
        return
    p = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), env=env,
                         creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report = {'pid': p.pid, 'exe': EXE}
    # 18s：这台机器上 WebView2 偶发 LAUNCH_FAILED → 宿主会自杀重启一次（约 +6s），
    # 面板真正可用之前拿到的是「上一轮的窗口」，探测结果会全错。
    time.sleep(18)

    txt = log_text()
    keys = [l for l in txt.splitlines() if ('[probe]' in l or '[pos]' in l or
                                           '[ui]' in l or '[boot]' in l or '[adjust]' in l)]
    report['boot_log'] = keys[-14:]

    panels = find_windows_by_class('GbPanelHost')
    if not panels:
        report['err'] = 'panel window (GbPanelHost) not found'
        print(json.dumps(report, ensure_ascii=False))
        return
    ph = panels[0]
    pr = wrect(ph)
    report['panel_rect'] = pr

    try:
        step_panel(report, pr, txt, ph)
    except Exception as e:
        import traceback
        report['err'] = 'panel step failed: %s' % e
        report['trace'] = traceback.format_exc()[-800:]

    txt2 = log_text()
    report['after_click_log'] = [l for l in txt2.splitlines()
                                 if ('[ui]' in l or '[pos]' in l or '[probe]' in l)][-14:]
    report['footClick_seen'] = 'received footbar click' in txt2
    report['openPos_seen'] = 'requested position window' in txt2

    posw = find_windows_by_class('GbPositionHost')
    report['pos_wnd'] = [wrect(h) for h in posw]

    # ---- ④ 现状：局面上小窗会不会被拍进截图（品牌蓝标题栏在不在整屏截图里）----
    try:
        full2 = ImageGrab.grab(all_screens=True)
        a2 = np.asarray(full2.convert('RGB')).astype(np.int32)
        brandmask = (np.abs(a2[:, :, 0] - BRAND[0]) <= 6) & (np.abs(a2[:, :, 1] - BRAND[1]) <= 6) & \
                    (np.abs(a2[:, :, 2] - BRAND[2]) <= 6)
        report['brand_blue_in_capture'] = int(brandmask.sum())
        if posw:
            r = wrect(posw[0])
            sub = a2[r[1] - VY:r[1] - VY + r[3], r[0] - VX:r[0] - VX + r[2]]
            if sub.size:
                report['pos_area_mean_in_capture'] = [int(v) for v in sub.reshape(-1, 3).mean(axis=0)]
                bm = brandmask[r[1] - VY:r[1] - VY + r[3], r[0] - VX:r[0] - VX + r[2]]
                report['pos_header_in_capture'] = int(bm.sum())
        full2.save(FULL_PNG)
    except Exception as e:
        report['capture_err'] = str(e)

    # 收摊（不想在用户屏幕上留一个自己拉起来的实例）
    try:
        subprocess.run(['taskkill', '/PID', str(p.pid), '/F', '/T'],
                       capture_output=True, timeout=15)
    except Exception:
        pass
    with open(os.path.join(ROOT, 'tools', '_forensic_report.json'), 'w',
              encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
