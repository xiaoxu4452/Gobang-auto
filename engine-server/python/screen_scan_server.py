# Vision screen-scan service.

"""整屏棋盘扫描服务（桌面覆盖层应用的后端，默认 :8971）。

给 Electron 覆盖层提供「屏幕上有没有棋盘、棋盘在哪、棋子怎么摆」：
    GET  /health            -> {"ok": true}
    POST /scan              -> 见 screen_board.scan_once
         body: {hint?: {x,y,w,h}, size?: 15}   hint = 上一帧棋盘位置（跟踪模式，快得多）
    POST /quit              -> 优雅退出（供覆盖层关闭时调用）

刻意**复用** gomoku_assistant 包里的自适应读子，因此浅底/深底、实心/空心描边等
各种棋子画法的识别能力与网页注入路线完全一致。

单实例锁与 recognize_server 同款：多进程同端口会把请求随机分发到不同实例，
导致读到旧代码/旧状态，是「识别结果飘忽」类故障的经典成因。
"""
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gomoku_assistant import screen_board as SB  

PORT = int(os.environ.get("GB_SCAN_PORT", "8971"))
_last = {"res": None}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send({"ok": True, "port": PORT})
        else:
            self._send({"ok": False, "err": "not found"}, 404)

    def do_POST(self):
        if self.path == "/quit":
            self._send({"ok": True})
            threading.Thread(target=_shutdown, daemon=True).start()
            return
        if self.path != "/scan":
            self._send({"ok": False, "err": "not found"}, 404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        hint, size, exclude, probe, region = None, 15, None, False, None
        if n:
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
                hint = req.get("hint")
                size = int(req.get("size") or 15)
                
                exclude = req.get("exclude")
                probe = bool(req.get("probe"))
                
                region = req.get("region")
            except Exception:
                hint, size, exclude, probe, region = None, 15, None, False, None
        else:
            self.rfile.read(0)
        try:
            
            if hint is None and _last["res"] and _last["res"].get("board_rect"):
                hint = _last["res"]["board_rect"]
            res = SB.scan_once(None, size=size, hint=hint, exclude=exclude,
                               probe=probe, region=region)
            _last["res"] = res
            self._send(res)
        except Exception as e:  
            self._send({"ok": False, "err": "%s: %s" % (type(e).__name__, e)})

def _shutdown():
    import time
    time.sleep(0.2)
    try:
        SERVER.shutdown()
    except Exception:
        pass

def main():
    lock_path = os.path.join(tempfile.gettempdir(), "gomoku_scan_%d.lock" % PORT)
    try:
        import msvcrt
        lock_f = open(lock_path, "w")
        msvcrt.locking(lock_f.fileno(), msvcrt.LK_NBLCK, 1)
    except Exception:
        print("another scan server instance holds the lock - exit.")
        return
    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:%d/health" % PORT, timeout=1)
        print("port %d already serving - exit." % PORT)
        return
    except Exception:
        pass

    global SERVER
    SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("screen scan server on 127.0.0.1:%d" % PORT)
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass

SERVER = None

if __name__ == "__main__":
    main()
