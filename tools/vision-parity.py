#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""C++ 识别服务 与 Python 参考实现 的逐子对拍（开发期工具，不进发布包）
=====================================================================
用途：把 OpenCV C++ 版 GomokuVision.exe 与 Python 版 recognize_server 放在
**完全相同的激励**上跑，逐子比对，证明移植没有引入行为回归。

激励集直接复用 tools/recog_vaccine_selftest.py 的「预防针」矩阵（A~H）——
那份矩阵本来就是 2026-09-19 现场钉出来的极端场景，是本次移植最重要的护栏。

用法：
    python tools/python-bundle/runtime/python.exe tools/vision-parity.py
退出码 0 = 完全一致。

★ 全离线：两侧都走「离线单图入口」，**不需要先启动任何服务**
  （C++ 侧 --recognize-image / --scan-image；Python 侧直接 import 参考实现）。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import recog_vaccine_selftest as V  # noqa: E402  复用调色板/渲染/扰动
import recognize_server as RS  # noqa: E402  Python 参考实现

PORT = int(os.environ.get("GB_RECOG_PORT", "8970"))
SIZE = 15
URL = "http://127.0.0.1:%d/recognize" % PORT

passed = 0
failed = 0
mismatches = []


def png_b64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def py_read(img):
    return RS.recognize(png_b64(img), SIZE)


def cpp_read(img):
    """C++ 侧离线跑一遍 /recognize（不走 HTTP —— 于是不需要先起服务）。"""
    import subprocess
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), "gb_recog_parity.png")
    img.convert("RGB").save(tmp, format="PNG")
    r = subprocess.run([EXE, "--recognize-image", tmp],
                       capture_output=True, text=True, encoding="utf-8")
    if not r.stdout.strip():
        raise RuntimeError("no stdout: %s" % (r.stderr or "")[:400])
    return json.loads(r.stdout.strip().splitlines()[-1])


def stone_sets(res):
    b = {(s["y"], s["x"]) for s in res.get("black", [])}
    w = {(s["y"], s["x"]) for s in res.get("white", [])}
    return b, w


EXE = os.path.abspath(os.path.join(HERE, "..", "desktop-vision", "build", "GomokuVision.exe"))


def cpp_scan(img, probe=False):
    import subprocess
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), "gb_scan_parity.png")
    img.convert("RGB").save(tmp, format="PNG")
    args = [EXE, "--scan-image", tmp] + (["--probe"] if probe else [])
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
    if not r.stdout.strip():
        raise RuntimeError("no stdout: %s" % (r.stderr or "")[:400])
    return json.loads(r.stdout)


def py_scan(img, probe=False):
    from gomoku_assistant import screen_board as SB
    return SB.scan_once(np.asarray(img.convert("RGB")), size=15, probe=probe)


def scan_parity(img, tag, probe=False):
    """整屏找盘对拍：found / 黑白子集合 / 棋盘矩形 必须一致"""
    global passed, failed
    try:
        a = py_scan(img, probe)
    except Exception as e:            # noqa: BLE001
        a = {"ok": False, "found": False, "err": "py: %r" % (e,)}
    try:
        b = cpp_scan(img, probe)
    except Exception as e:            # noqa: BLE001
        b = {"ok": False, "found": False, "err": "cpp: %r" % (e,)}

    ab, aw = stone_sets(a)
    bb, bw = stone_sets(b)
    ok = (bool(a.get("found")) == bool(b.get("found")) and ab == bb and aw == bw)
    detail = []
    if bool(a.get("found")) != bool(b.get("found")):
        detail.append("found: py=%s cpp=%s" % (a.get("found"), b.get("found")))
    if ab != bb:
        detail.append("黑: py缺%s cpp缺%s" % (sorted(bb - ab), sorted(ab - bb)))
    if aw != bw:
        detail.append("白: py缺%s cpp缺%s" % (sorted(bw - aw), sorted(aw - bw)))
    if a.get("found") and b.get("found"):
        ra, rb = a.get("board_rect", {}), b.get("board_rect", {})
        d = max(abs(ra.get(k, 0) - rb.get(k, 0)) for k in ("x", "y", "w", "h"))
        if d > 1.0:
            ok = False
            detail.append("board_rect 偏差 %.1f (%s vs %s)" % (d, ra, rb))
        if probe and a.get("multi_board") != b.get("multi_board"):
            ok = False
            detail.append("multi_board: py=%s cpp=%s" % (a.get("multi_board"),
                                                         b.get("multi_board")))
    if ok:
        passed += 1
        return True
    failed += 1
    mismatches.append("  ✗ %s :: %s" % (tag, " | ".join(detail)))
    return False


def compare(tag, img):
    """两种实现必须给出同样的黑白子集合与 suspect 判定"""
    global passed, failed
    try:
        a = py_read(img)
    except Exception as e:            # noqa: BLE001
        a = {"ok": False, "err": "py: %r" % (e,)}
    try:
        b = cpp_read(img)
    except Exception as e:            # noqa: BLE001
        b = {"ok": False, "err": "cpp: %r" % (e,)}

    ab, aw = stone_sets(a)
    bb, bw = stone_sets(b)
    same = (a.get("ok") == b.get("ok") and ab == bb and aw == bw
            and bool(a.get("suspect")) == bool(b.get("suspect")))
    if same:
        passed += 1
        return True
    failed += 1
    detail = []
    if ab != bb:
        detail.append("黑: py缺%s cpp缺%s" % (sorted(bb - ab), sorted(ab - bb)))
    if aw != bw:
        detail.append("白: py缺%s cpp缺%s" % (sorted(bw - aw), sorted(aw - bw)))
    if bool(a.get("suspect")) != bool(b.get("suspect")):
        detail.append("suspect: py=%s cpp=%s" % (a.get("suspect"), b.get("suspect")))
    if a.get("ok") != b.get("ok"):
        detail.append("ok: py=%s(%s) cpp=%s(%s)" % (a.get("ok"), a.get("err"),
                                                    b.get("ok"), b.get("err")))
    geo = ""
    if a.get("ok") and b.get("ok"):
        ga, gb = a.get("geometry", {}), b.get("geometry", {})
        geo = "  [geo py=%s/%s cpp=%s/%s]" % (ga.get("x0"), ga.get("source"),
                                              gb.get("x0"), gb.get("source"))
    mismatches.append("  ✗ %s :: %s%s" % (tag, " | ".join(detail), geo))
    return False


def main():
    print("== A) 浅色盘白子 ==")
    for name in ("ultra_light", "pale_blue", "mint"):
        compare("A/%s" % name, V.render(V.PALETTES[name], V.STONES, last=V.LAST))

    print("== B) 深色盘黑子 ==")
    for name in ("deep_dark", "dark_blue"):
        compare("B/%s" % name, V.render(V.PALETTES[name], V.STONES, last=V.LAST))

    print("== C) 拟真光泽棋子 ==")
    for name in ("warm_wood", "ultra_light", "deep_dark"):
        compare("C/%s" % name,
                V.render(V.PALETTES[name], V.STONES, last=V.LAST, style="gloss"))

    print("== D) 反识别手段 ==")
    base = V.render(V.PALETTES["warm_wood"], V.STONES, last=V.LAST)
    for tag, img in [
        ("JPEG q35", V.perturb_jpeg(base, 35)),
        ("JPEG q70", V.perturb_jpeg(base, 70)),
        ("噪声σ6", V.perturb_noise(base, 6.0)),
        ("噪声σ10", V.perturb_noise(base, 10.0, seed=11)),
        ("模糊3x3", V.perturb_blur(base, 3)),
        ("亮度-15%", V.perturb_gain(base, 0.85)),
        ("亮度+15%", V.perturb_gain(base, 1.15)),
        ("对比0.7", V.perturb_gain(base, 0.7, 128 * 0.3)),
        ("对比1.3", V.perturb_gain(base, 1.3, -128 * 0.3)),
        ("水印", V.render(V.PALETTES["warm_wood"], V.STONES, last=V.LAST, watermark=True)),
        ("抖动", V.render(V.PALETTES["warm_wood"], V.STONES, last=V.LAST, dither=True)),
    ]:
        compare("D/%s" % tag, img)

    print("== E) 空盘假阳性防线 ==")
    for name in ("ultra_light", "pale_blue", "mint", "deep_dark", "dark_blue", "warm_wood"):
        compare("E/空盘水印/%s" % name,
                V.render(V.PALETTES[name], [], watermark=True))
    compare("E/空盘噪声", V.perturb_noise(V.render(V.PALETTES["warm_wood"], []), 10.0, seed=3))
    compare("E/空盘JPEG", V.perturb_jpeg(V.render(V.PALETTES["warm_wood"], []), 35))
    compare("E/空盘抖动", V.render(V.PALETTES["warm_wood"], [], dither=True))
    compare("E/空盘深盘噪声", V.perturb_noise(V.render(V.PALETTES["deep_dark"], []), 8.0, seed=5))

    print("== F) 缩放 ==")
    for sc in (0.5, 0.7):
        compare("F/木盘%.1fx" % sc, V.perturb_scale(base, sc))
        compare("F/浅盘%.1fx" % sc,
                V.perturb_scale(V.render(V.PALETTES["ultra_light"], V.STONES, last=V.LAST), sc))

    print("== G) 整屏同色系背景 ==")
    board_img = V.render(V.PALETTES["warm_wood"], V.STONES, last=V.LAST, style="gloss")
    rng = np.random.default_rng(42)
    page = np.empty((1500, 2000, 3), np.float32)
    page[...] = (205, 168, 118)
    grain = rng.normal(0, 9.0, page.shape[:2]).astype(np.float32)
    page = np.clip(page + grain[..., None], 0, 255).astype(np.uint8)
    import cv2
    for yy in (120, 360, 640, 980, 1300):
        cv2.line(page, (0, yy), (1999, yy), (168, 128, 82), 2)
    cv2.rectangle(page, (60, 760), (430, 1180), (96, 74, 52), -1)
    page_img = Image.fromarray(page)
    page_img.paste(board_img, (180, 160))
    compare("G/整屏1.0x", page_img)
    compare("G/整屏0.6x", page_img.resize(
        (int(page_img.width * 0.6), int(page_img.height * 0.6)), Image.LANCZOS))

    print("== H) 现场截图 屏江棋院 ==")
    fx = os.path.join(HERE, "fixtures", "pingjiang-20260919.jpg")
    if os.path.exists(fx):
        img0 = Image.open(fx).convert("RGB")
        for tag, sc in [("1.0x", 1.0), ("1.6x", 1.6), ("0.7x", 0.7), ("0.5x", 0.5)]:
            im = img0 if sc == 1.0 else img0.resize(
                (int(img0.width * sc), int(img0.height * sc)), Image.LANCZOS)
            compare("H/屏江%s" % tag, im)
    else:
        print("  （缺 fixtures/pingjiang-20260919.jpg，跳过）")

    print("== I) 五林真实截图 ==")
    wx = os.path.join(HERE, "fixtures", "wulin_gloss_board.jpg")
    if os.path.exists(wx):
        compare("I/五林", Image.open(wx).convert("RGB"))
    else:
        print("  （缺 fixtures/wulin_gloss_board.jpg，跳过）")

    print("== J) /scan 整屏找盘（等距线族配对，:8971 独有路径）==")
    scan_parity(page_img, "J/整屏同色系背景")
    scan_parity(page_img, "J/整屏同色系背景(probe)", probe=True)
    scan_parity(page_img.resize((int(page_img.width * 0.6), int(page_img.height * 0.6)),
                                Image.LANCZOS), "J/整屏0.6x")
    if os.path.exists(fx):
        scan_parity(Image.open(fx).convert("RGB"), "J/屏江现场")
    if os.path.exists(wx):
        scan_parity(Image.open(wx).convert("RGB"), "J/五林截图")
    # 无棋盘的一屏（纯桌面底 + 噪声）：两边都必须 found=False
    blank = Image.fromarray(np.clip(page + rng.normal(0, 6.0, page.shape), 0, 255).astype(np.uint8))
    scan_parity(blank, "J/无棋盘")
    # 两个棋盘：probe 必须数出 2
    two = Image.fromarray(page.astype(np.uint8))
    two.paste(V.render(V.PALETTES["deep_dark"], V.STONES, last=V.LAST), (1200, 200))
    scan_parity(two, "J/双棋盘(probe)", probe=True)

    print("== K) 裁边残盘（晶格兜底 partial_lattice）==")
    # 用户样张形态：棋盘被裁边、整线定位必然失败，只剩等距周期可辨。
    # 两侧都必须走 partial_lattice 且给出**同一套**居中后的黑白子。
    cell, margin = V.geom()
    def crop_board(pal, stones, r0, r1, c0, c1, pad=3):
        img = np.asarray(V.render(pal, stones))
        y1 = int(margin + r0 * cell) - pad
        x1 = int(margin + c0 * cell) - pad
        y2 = int(margin + r1 * cell) + pad
        x2 = int(margin + c1 * cell) + pad
        return Image.fromarray(img[max(0, y1):y2, max(0, x1):x2].copy())
    kstones = [(3, 3, 1), (4, 4, 2), (5, 5, 1), (6, 6, 2), (7, 7, 1),
               (0, 0, 2), (0, 14, 1), (14, 14, 2), (14, 0, 1)]
    compare("K/木盘裁12x11", crop_board(V.PALETTES["warm_wood"], kstones, 2, 13, 2, 12))
    compare("K/木盘裁边JPEG60", V.perturb_jpeg(
        crop_board(V.PALETTES["warm_wood"], kstones, 2, 13, 2, 12), 60))
    compare("K/浅盘裁11x10", crop_board(V.PALETTES["ultra_light"], kstones, 1, 11, 3, 12))
    compare("K/深盘裁11x11", crop_board(V.PALETTES["deep_dark"], kstones, 3, 13, 3, 13))
    compare("K/木盘只留角部", crop_board(V.PALETTES["warm_wood"], kstones, 0, 6, 0, 6))

    if mismatches:
        print("\n---- 不一致明细 ----")
        for m in mismatches:
            print(m)
    print("\n== parity: %d passed, %d failed ==" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
