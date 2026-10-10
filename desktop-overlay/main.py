# Overlay helper script.

"""五子棋助手 · 桌面覆盖层（GomokuOverlay）

系统级浮动覆盖层：整屏识别五子棋棋盘 → 用「偏紫亮蓝紫」的 L 型框住棋盘 →
在棋盘上给出建议落点；屏幕四角另有荧光天蓝 L 型 + 细虚线，表示「覆盖层在工作中」。

设计要点（与项目其它部分的关系）：
  · UI 用 Web 技术（HTML/CSS/JS，见 overlay.html/css/js），与书签浮动面板同一套视觉。
  · 识别**完全复用**发布目录里共用的便携 Python + gomoku_assistant 包
    （浅底/深底/空心描边等画法的能力与网页注入路线一致），通过 :8971 扫描服务取结果。
  · 分析**复用** GomokuEngine.exe 的引擎服务 :8964（以 --as-backend 拉起，不参与互斥）。
  · 与 GomokuEngine.exe **互斥**：同一时间只能运行一个，后启动的弹窗提示并退出。
  · 默认**只给建议**，自动落子默认关闭（用户可在面板里开启；开启后走引擎的系统级点击）。
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

SCAN_PORT = 8971
ENGINE_PORT = 8964
APP_NAME = "GomokuOverlay"

IS_WIN = os.name == "nt"

def shared_dir() -> str:
    """定位发布根目录（两个 EXE 与 python/、resources/ 共用同一份资源）。

    打包后 exe 位于 <发布根>/GomokuOverlay/ 或就在发布根；开发时本文件在
    <项目>/desktop-overlay/，发布根为 <项目>/Meter engine-server。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [
        os.path.dirname(here),                                  
        here,                                                   
        os.path.join(os.path.dirname(here), "Meter engine-server"),
        os.path.join(here, "..", "Meter engine-server"),
    ]
    for c in cands:
        c = os.path.abspath(c)
        if os.path.exists(os.path.join(c, "GomokuEngine.exe")):
            return c
    return os.path.abspath(cands[0])

SHARED = shared_dir()
PY_EXE = os.path.join(SHARED, "python", "runtime", "python.exe")
SCAN_SRV = os.path.join(SHARED, "python", "screen_scan_server.py")
ENGINE_EXE = os.path.join(SHARED, "GomokuEngine.exe")

LOCK = os.path.join(os.environ.get("TEMP", "/tmp"), "gomoku_suite.lock")

def _lock_info():
    try:
        with open(LOCK, "r", encoding="utf-8") as f:
            j = json.load(f)
        return j if j.get("pid") else None
    except Exception:
        return None

def _pid_alive(pid: int) -> bool:
    if not IS_WIN:
        try:
            os.kill(pid, 0)
            return True
        except Exception:
            return False
    try:
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))   
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
            return True
        return False
    except Exception:
        return False

def acquire_lock():
    cur = _lock_info()
    if cur and cur.get("pid") != os.getpid() and _pid_alive(int(cur["pid"])):
        return cur
    try:
        with open(LOCK, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "app": APP_NAME, "ts": time.time()}, f)
    except Exception:
        pass
    return None

def release_lock():
    cur = _lock_info()
    if cur and int(cur.get("pid", -1)) == os.getpid():
        try:
            os.unlink(LOCK)
        except Exception:
            pass

def alert(msg: str, detail: str = "") -> None:
    """弹窗提示（互斥命中时用）。"""
    text = msg + ("\n" + detail if detail else "")
    if IS_WIN:
        try:
            ctypes.windll.user32.MessageBoxW(0, text, "五子棋助手", 0x30)   
            return
        except Exception:
            pass
    print(text)

def http_post(port: int, path: str, body: dict, timeout: float = 30.0):
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None

def http_get(port: int, path: str, timeout: float = 1.5):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=timeout) as r:
            return r.read().decode("utf-8")
    except Exception:
        return None

kids = []

def start_scan_server():
    py = PY_EXE if os.path.exists(PY_EXE) else "python"
    src = SCAN_SRV if os.path.exists(SCAN_SRV) else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "engine-server", "python", "screen_scan_server.py")
    env = dict(os.environ, GB_SCAN_PORT=str(SCAN_PORT))
    k = subprocess.Popen([py, os.path.abspath(src)], cwd=os.path.dirname(os.path.abspath(src)),
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kids.append(k)

def start_engine():
    if not os.path.exists(ENGINE_EXE):
        return
    
    kids.append(subprocess.Popen([ENGINE_EXE, "--as-backend"], cwd=SHARED,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

def stop_all():
    try:
        http_post(SCAN_PORT, "/quit", {}, timeout=1.0)
    except Exception:
        pass
    for k in kids:
        try:
            k.terminate()
        except Exception:
            pass
    release_lock()

class App:
    """暴露给前端的 API（pywebview 的 js_api）。"""

    def __init__(self):
        self.cfg = {"side": "auto", "auto": False, "hz": 700}
        self.last_rect = None
        self.last_sig = ""
        self.running = True
        self.window = None
        threading.Thread(target=self._loop, daemon=True).start()

    def set_side(self, v):
        self.cfg["side"] = str(v)
        self.last_sig = ""

    def set_auto(self, v):
        self.cfg["auto"] = bool(v)

    def set_hz(self, v):
        try:
            self.cfg["hz"] = max(200, min(5000, int(v)))
        except Exception:
            pass

    def close(self):
        self.running = False
        try:
            if self.window:
                self.window.destroy()
        except Exception:
            pass

    def ping(self):
        return "pong"

    def _board_of(self, black, white):
        b = [[0] * 15 for _ in range(15)]
        for s in (black or []):
            y, x = int(s["y"]), int(s["x"])
            if 0 <= y < 15 and 0 <= x < 15:
                b[y][x] = 1
        for s in (white or []):
            y, x = int(s["y"]), int(s["x"])
            if 0 <= y < 15 and 0 <= x < 15:
                b[y][x] = 2
        return b

    def _loop(self):
        while self.running:
            try:
                self._tick()
            except Exception:
                pass
            time.sleep(max(0.2, self.cfg["hz"] / 1000.0))

    def _tick(self):
        st = http_post(SCAN_PORT, "/scan", {"hint": self.last_rect} if self.last_rect else {}, timeout=25)
        if not st:
            return
        if st.get("found"):
            self.last_rect = st.get("board_rect")
        board = self._board_of(st.get("black"), st.get("white"))
        bn = sum(r.count(1) for r in board)
        wn = sum(r.count(2) for r in board)
        to_move_is_black = (bn == wn)
        our_is_black = True if self.cfg["side"] == "auto" else (str(self.cfg["side"]) in ("1", "b", "black"))
        our_turn = (to_move_is_black == our_is_black)

        eval_mine, best = None, None
        if st.get("found") and our_turn and not st.get("suspect"):
            sig = json.dumps(board) + ("|b" if our_is_black else "|w")
            if sig != self.last_sig:
                self.last_sig = sig
                r = http_post(ENGINE_PORT, "/api/analyze",
                              {"board": board, "turnMs": 2500, "topN": 1, "rule": 0, "lane": "main"},
                              timeout=30)
                if r and not r.get("error"):
                    if isinstance(r.get("eval"), (int, float)):
                        eval_mine = r["eval"]
                    if r.get("best"):
                        best = {"x": r["best"]["x"], "y": r["best"]["y"]}
                    
                    if self.cfg["auto"] and best and st.get("geometry"):
                        xl = st["geometry"].get("x_lines") or []
                        yl = st["geometry"].get("y_lines") or []
                        if best["x"] < len(xl) and best["y"] < len(yl):
                            http_post(ENGINE_PORT, "/api/click",
                                      {"x": xl[best["x"]], "y": yl[best["y"]]}, timeout=5)

        payload = {
            "found": st.get("found"), "offset": st.get("offset"),
            "board_rect": st.get("board_rect"), "geometry": st.get("geometry"),
            "black": st.get("black"), "white": st.get("white"),
            "suspect": st.get("suspect"), "eval": eval_mine, "best": best,
            "turn": 1 if to_move_is_black else 2,
        }
        if self.window:
            try:
                self.window.evaluate_js("window.__applyState && window.__applyState(%s)"
                                        % json.dumps(payload, ensure_ascii=False))
            except Exception:
                pass

def make_click_through(hwnd: int) -> None:
    """置顶 + 点击穿透（除面板外的区域全部把鼠标让给下面的棋盘）。"""
    if not IS_WIN:
        return
    GWL_EXSTYLE = -20
    WS_EX_LAYERED = 0x00080000
    WS_EX_TRANSPARENT = 0x00000020
    WS_EX_TOOLWINDOW = 0x00000080
    HWND_TOPMOST = -1
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0010
    try:
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        style |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW
        ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        ctypes.windll.user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                          SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    except Exception:
        pass

def main():
    holder = acquire_lock()
    if holder:
        who = "桌面覆盖层" if holder.get("app") == "GomokuOverlay" else "五子棋引擎"
        alert('检测到「%s」正在运行。' % who, "同一时间只能运行其中一个，请先关闭它再启动本程序。")
        return 0

    import webview

    set_dpi_aware()
    start_scan_server()
    if http_get(ENGINE_PORT, "/health") is None:
        start_engine()

    api = App()
    html = os.path.join(os.path.dirname(os.path.abspath(__file__)), "overlay.html")
    win = webview.create_window(
        "GomokuOverlay", url=html, js_api=api,
        frameless=True, transparent=True, on_top=True,
        background_color="#00000000", easy_drag=False,
        width=1200, height=800, resizable=False,
    )
    api.window = win

    def on_shown():
        """窗口显示后铺满整个虚拟屏，并设为置顶 + 点击穿透。"""
        try:
            screens = webview.screens
            x0 = min(s.x for s in screens)
            y0 = min(s.y for s in screens)
            x1 = max(s.x + s.width for s in screens)
            y1 = max(s.y + s.height for s in screens)
            win.resize(x1 - x0, y1 - y0)
            win.move(x0, y0)
        except Exception:
            pass
        try:
            hwnd = int(win.native.Handle)          
            make_click_through(hwnd)
        except Exception:
            pass

    try:
        webview.start(on_shown, private_mode=False, debug=False)
    finally:
        api.running = False
        stop_all()
    return 0

def set_dpi_aware() -> None:
    if not IS_WIN:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

if __name__ == "__main__":
    sys.exit(main())
