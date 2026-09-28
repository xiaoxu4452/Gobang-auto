# -*- coding: utf-8 -*-
"""临时探针：对 tools/fixtures 里的图跑 recognize，打印结果摘要。"""
import base64
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..", "engine-server", "python")
sys.path.insert(0, os.path.abspath(PKG))

import numpy as np  # noqa: E402
import cv2  # noqa: E402


def probe(path):
    import importlib
    rs = importlib.import_module("recognize_server")
    with open(path, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode()
    res = rs.recognize(b64, 15)
    if not res.get("ok"):
        print(path, "->", "FAIL:", res.get("err"))
        return
    nb, nw = len(res["black"]), len(res["white"])
    g = res.get("geometry") or {}
    print("%s -> ok  black=%d white=%d suspect=%s partial=%s src=%s step=%s" % (
        os.path.basename(path), nb, nw, res.get("suspect"), res.get("partial"),
        g.get("source"), g.get("stepX")))
    print("   diag:", json.dumps({k: v for k, v in (res.get("diag") or {}).items()
                                  if not isinstance(v, list)})[:300])


if __name__ == "__main__":
    fixdir = os.path.join(HERE, "fixtures")
    for name in sys.argv[1:] or ["big-photo-small-board.png"]:
        probe(os.path.join(fixdir, name))
