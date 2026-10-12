#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""识别预防针 —— 桌面端识别能力的极限压力自测（2026-09-19 用户要求）
=====================================================================

被 tools/test-recognize-adaptive.js 以子进程方式调用；退出码 0 = 全通过。

用户原话：「这才是最重要的功能，桌面端的识别能力应该提升：浅色盘白子、深色盘黑子、
棋子带光泽（五林五子棋等）、以及一些网站的可能的反识别手段……优先实现提升识别能力。」

与既有自测的分工（避免重复覆盖）：
  · recognize_selftest.py  —— 常规底色 × 空盘/中局/边角/密集 + 空心描边（基础回归）；
  · wulin_gloss_selftest.py —— 五林真实截图基准（光泽棋子机理钉数字）；
  · 本文件（疫苗）     —— **极端场景矩阵**：每一种都是「现场随时可能遇到」的形态，
    全部走生产管线 ``recognize()``（网格定位 → 双路读子仲裁 → 不变量闸门）。

矩阵（全部要求**逐子精确**复原或**零假阳**）：
  A. 浅色盘白子（极端低对比：近白底 #faf8f0 上的 #ffffff 白子）
  B. 深色盘黑子（近黑底 #18181c 上的 #040406 黑子，唯一线索是那一点对比）
  C. 拟真光泽棋子（径向渐变**在棋子外沿穿过底色对比零点** + 高光 + 落影，
     浅盘白子 / 深盘黑子 / 木盘两色 都覆盖 —— 五林类站点的通病）
  D. 反识别手段：高斯噪声、JPEG 重压缩、高斯模糊、亮度/对比偏移、
     半透明水印、细密抖动纹理（网站想方设法让自动化截图「读不准」）
  E. 空盘假阳性防线：上述任何组合下，空盘都必须读出 **0 子** 且不 suspect
     （识别要「知道自己不知道」，而不是把噪声当棋子）。
  F. 缩放 0.5×/0.7×：小窗口/低分辨率录屏下同样要读对。

开源参考（用户要求）：调研了开源五子棋盘识别的主流做法——Canny+Hough 直线定位、
Hough 圆找子、HSV 色域判色、逐格 CNN 分类（xieemily/Chess AI、CSDN 裁判系统等）。
本管线已含直线定位与形状验证的官方手段；判色不学「绝对色阈」（正是浅/深底翻车的根因），
坚持「相对局部背景的统计证据」路线，把开源做法作为形态参考而非照抄。
"""
from __future__ import annotations

import base64
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.abspath(os.path.join(HERE, "..", "engine-server", "python"))
sys.path.insert(0, PYDIR)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

import recognize_server  # noqa: E402
from gomoku_assistant import engine as eng  # noqa: E402

SIZE = 15
W = 1200

# ---------------------------------------------------------------- 调色板
# 全部是「现场可能出现」的极端形态；亮度值括注，便于日后增补。
PALETTES = {
    # A 类：浅色盘 + 纯白白子（白子与底色只差 ~10 灰阶，唯一线索是描边/数字/那一点对比）
    "ultra_light": dict(board=(250, 248, 240), line=(198, 192, 176), coord=(205, 199, 184),
                        black=(20, 20, 22), white=(255, 255, 255), stroke=(150, 144, 130),
                        num_on_black=(238, 238, 236), num_on_white=(90, 90, 90),
                        last=(214, 74, 58)),
    # A 类变体：淡蓝底站点（白子亮 ~8）
    "pale_blue": dict(board=(226, 236, 246), line=(152, 172, 196), coord=(168, 186, 206),
                      black=(18, 20, 26), white=(252, 254, 255), stroke=(140, 158, 180),
                      num_on_black=(238, 240, 244), num_on_white=(70, 80, 96),
                      last=(214, 74, 58)),
    # A 类变体：薄荷绿底
    "mint": dict(board=(224, 240, 230), line=(140, 176, 156), coord=(158, 192, 172),
                 black=(16, 22, 18), white=(252, 255, 253), stroke=(130, 164, 146),
                 num_on_black=(236, 242, 238), num_on_white=(60, 88, 72),
                 last=(214, 74, 58)),
    # B 类：深色盘 + 近黑黑子（黑子与底色只差 ~18 灰阶，靠浅色描边辅助）
    "deep_dark": dict(board=(24, 24, 28), line=(64, 64, 72), coord=(84, 84, 92),
                      black=(4, 4, 6), white=(250, 250, 250), stroke=(150, 150, 160),
                      num_on_black=(226, 226, 230), num_on_white=(20, 20, 22),
                      last=(224, 84, 72)),
    # B 类变体：深蓝底
    "dark_blue": dict(board=(22, 28, 44), line=(66, 78, 110), coord=(88, 100, 132),
                      black=(4, 6, 12), white=(248, 250, 254), stroke=(140, 152, 184),
                      num_on_black=(222, 228, 240), num_on_white=(18, 22, 34),
                      last=(224, 84, 72)),
    # C 类：拟真光泽棋子用的木盘（无光泽实心棋子也照常可读，作对照）
    "warm_wood": dict(board=(214, 178, 128), line=(112, 84, 48), coord=(118, 90, 54),
                      black=(16, 16, 16), white=(252, 252, 250), stroke=(146, 126, 96),
                      num_on_black=(238, 238, 236), num_on_white=(28, 28, 28),
                      last=(206, 62, 48)),
}

# ---------------------------------------------------------------- 布局
# 中局 + 两颗角子（角子是最难的：四角底色采样只剩盘内侧 + 边缘暗角风险）
BLACK = [(7, 7), (7, 8), (8, 7), (6, 6), (9, 9), (5, 7), (0, 0)]
WHITE = [(7, 6), (8, 8), (6, 7), (9, 8), (8, 6), (14, 14)]

passed = 0
failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print("  \u2713 " + name)
    else:
        failed += 1
        print("  \u2717 " + name + "  got=" + repr(got) + " want=" + repr(want))


def geom():
    cell = W / (SIZE + 1.2)
    return cell, cell * 1.1


# ---------------------------------------------------------------- 绘制
def _gloss_stone(img, cx, cy, r, color, sign):
    """在 numpy 图上画一颗「拟真光泽棋子」。

    关键特征（与五林现场剖面一致，见 wulin_gloss_selftest.py 的注释）：
      · 亮度差从中心向**外沿单调衰减**，在棋子外沿**穿过底色对比零点** ——
        「棋子 vs 底色」这条线索在最需要它的外沿消失；
      · 高光：左上 35% 半径处再亮一截；
      · 落影：右下外侧一圈比底色暗一点的软阴影（这让相邻空点出现「弱暗环」，
        识别必须不把阴影当成子）。
    sign=+1 亮子（白），-1 暗子（黑）。中心亮度差取 +38/-170（白/黑）。
    """
    h, w = img.shape[:2]
    x0, x1 = max(0, int(cx - r * 1.5)), min(w, int(cx + r * 1.5) + 1)
    y0, y1 = max(0, int(cy - r * 1.5)), min(h, int(cy + r * 1.5) + 1)
    if x1 <= x0 or y1 <= y0:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.hypot(xx - cx, yy - cy) / max(r, 1.0)
    inside = d <= 1.0
    prof = np.clip(1.0 - d, 0.0, 1.0) ** 0.65          # 外沿衰减到 0
    hx, hy = cx - r * 0.35, cy - r * 0.35              # 高光（左上）
    hd = np.hypot(xx - hx, yy - hy) / (r * 1.1)
    hl = np.clip(1.0 - hd, 0.0, 1.0) ** 2 * 14.0
    delta = sign * (38.0 if sign > 0 else 170.0) * prof + hl * (1.0 if sign > 0 else 0.25)
    # 落影：右下偏移的软阴影（只画在棋子外）
    sx, sy = cx + r * 0.22, cy + r * 0.30
    sd = np.hypot((xx - sx) / 1.12, (yy - sy) / 0.92) / r
    shadow = np.clip(1.0 - sd, 0.0, 1.0) ** 1.6 * (1.0 - inside) * 9.0
    region = img[y0:y1, x0:x1].astype(np.float32)
    region += (delta - shadow)[..., None]
    img[y0:y1, x0:x1] = np.clip(region, 0, 255).astype(np.uint8)


def render(pal, stones, last=None, style="solid", watermark=False, dither=False):
    """合成一张棋盘图。style: solid | gloss（光泽棋子）。"""
    cell, margin = geom()

    def px(i):
        return margin + i * cell

    img = Image.new("RGB", (W, W), pal["board"])
    d = ImageDraw.Draw(img)
    grid_end = px(SIZE - 1)
    for i in range(SIZE):
        d.line([(px(0), px(i)), (grid_end, px(i))], fill=pal["line"], width=1)
        d.line([(px(i), px(0)), (px(i), grid_end)], fill=pal["line"], width=1)
    d.rectangle([px(0), px(0), grid_end, grid_end], outline=pal["line"], width=2)
    for sx, sy in [(3, 3), (11, 3), (7, 7), (3, 11), (11, 11)]:
        rr = max(2.2, cell * 0.08)
        d.ellipse([px(sx) - rr, px(sy) - rr, px(sx) + rr, px(sy) + rr], fill=pal["line"])
    for i in range(SIZE):
        d.text((px(i), px(SIZE - 1) + margin * 0.62), chr(65 + i), fill=pal["coord"], anchor="mm")
        d.text((px(0) - margin * 0.62, px(i)), str(SIZE - i), fill=pal["coord"], anchor="mm")

    arr = np.asarray(img).astype(np.uint8).copy()
    r = cell * 0.44
    ring_lw = max(2, int(cell * 0.09))
    if style == "gloss":
        # 光泽子走 numpy 渐变合成（先画），数字后面统一补。
        # ★ 真实站点的拟真棋子也带一圈细描边（否则极浅底上人眼都看不见）—— 补 3px 细边。
        rim_w = max(2, int(cell * 0.045))
        for idx, (row, col, color) in enumerate(stones):
            cx, cy = px(col), px(row)
            _gloss_stone(arr, cx, cy, r, None, 1.0 if color == eng.WHITE else -1.0)
            cv2.circle(arr, (int(round(cx)), int(round(cy))), int(round(r)),
                       pal["stroke"], thickness=rim_w, lineType=cv2.LINE_AA)
        img = Image.fromarray(arr)
        d = ImageDraw.Draw(img)
        for idx, (row, col, color) in enumerate(stones):
            cx, cy = px(col), px(row)
            d.text((cx, cy), str(idx + 1),
                   fill=pal["num_on_black"] if color == eng.BLACK else pal["num_on_white"],
                   anchor="mm")
    else:
        d = ImageDraw.Draw(img)
        for idx, (row, col, color) in enumerate(stones):
            cx, cy = px(col), px(row)
            box = [cx - r, cy - r, cx + r, cy + r]
            # ★ 极端底色上棋子必有**可见边框**（用户 2026-09-19 确认的真实形态）：
            #   浅色盘白子带深色边、深色盘黑子带浅色边 —— 否则人眼也分不出来。
            if color == eng.BLACK:
                d.ellipse(box, fill=pal["black"], outline=pal["stroke"], width=ring_lw)
                d.text((cx, cy), str(idx + 1), fill=pal["num_on_black"], anchor="mm")
            else:
                d.ellipse(box, fill=pal["white"], outline=pal["stroke"], width=ring_lw)
                d.text((cx, cy), str(idx + 1), fill=pal["num_on_white"], anchor="mm")
    if last is not None:
        cx, cy = px(last[1]), px(last[0])
        rr = r + 1.2
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=pal["last"],
                  width=max(2, int(cell * 0.06)))
    if watermark:
        # 半透明水印：大号浅色字母横贯棋盘（低对比、大面积 —— 反识别常见手段）
        ov = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.text((W * 0.5, W * 0.5), "AI", fill=(255, 255, 255, 26), anchor="mm",
                font_size=int(W * 0.6))
        img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
        d = ImageDraw.Draw(img)
    if dither:
        # 细密抖动纹理：整幅 1px 棋盘格明暗交替（±3 灰阶）——考阈值与中位数
        arr = np.asarray(img).astype(np.int16)
        yy, xx = np.mgrid[0:W, 0:W]
        arr += (((xx + yy) % 2) * 6 - 3)[..., None]
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return img


# ---------------------------------------------------------------- 扰动
def perturb_jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=q)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def perturb_noise(img, sigma, seed=7):
    rng = np.random.RandomState(seed)
    arr = np.asarray(img).astype(np.float32)
    arr += rng.normal(0.0, sigma, arr.shape).astype(np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def perturb_blur(img, k):
    return Image.fromarray(cv2.GaussianBlur(np.asarray(img), (k, k), 0))


def perturb_gain(img, gain, bias=0.0):
    arr = np.asarray(img).astype(np.float32) * gain + bias
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def perturb_scale(img, sc):
    return Image.fromarray(cv2.resize(np.asarray(img), None, fx=sc, fy=sc,
                                      interpolation=cv2.INTER_AREA))


def read(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return recognize_server.recognize(b64, SIZE)


def stones_of(res):
    b = {(s["y"], s["x"]) for s in res.get("black", [])}
    w = {(s["y"], s["x"]) for s in res.get("white", [])}
    return b, w


def assert_layout(tag, res):
    want_b = sorted({(r, c) for r, c, v in STONES if v == eng.BLACK})
    want_w = sorted({(r, c) for r, c, v in STONES if v == eng.WHITE})
    b, w = stones_of(res)
    check("黑子集合 [%s]" % tag, sorted(b), want_b)
    check("白子集合 [%s]" % tag, sorted(w), want_w)
    check("不 suspect [%s]" % tag, res.get("suspect"), False)


STONES = [(r, c, eng.BLACK) for r, c in BLACK] + [(r, c, eng.WHITE) for r, c in WHITE]
LAST = WHITE[-1]

# 现场截图真值（屏江棋院，2026-09-19）：13 黑 + 13 白，(y, x) 约定
PJ_BLACK = [(7, 7), (7, 8), (8, 6), (8, 10), (9, 8), (9, 9), (9, 10), (10, 10),
            (10, 11), (10, 12), (11, 11), (12, 10), (12, 12)]
PJ_WHITE = [(6, 8), (7, 9), (7, 10), (8, 7), (8, 8), (8, 9), (9, 6), (9, 11),
            (9, 13), (10, 8), (10, 13), (11, 10), (13, 13)]


def main():
    print("== A) 浅色盘白子（极端低对比）==")
    for name in ("ultra_light", "pale_blue", "mint"):
        res = read(render(PALETTES[name], STONES, last=LAST))
        assert_layout("浅盘白子 %s" % name, res)

    print("== B) 深色盘黑子（极端低对比）==")
    for name in ("deep_dark", "dark_blue"):
        res = read(render(PALETTES[name], STONES, last=LAST))
        assert_layout("深盘黑子 %s" % name, res)

    print("== C) 拟真光泽棋子（渐变在外沿穿过底色 + 高光 + 落影）==")
    for name in ("warm_wood", "ultra_light", "deep_dark"):
        res = read(render(PALETTES[name], STONES, last=LAST, style="gloss"))
        assert_layout("光泽子 %s" % name, res)

    print("== D) 反识别手段（在常规木盘上逐项加压）==")
    base_img = render(PALETTES["warm_wood"], STONES, last=LAST)
    variants = [
        ("JPEG q35", perturb_jpeg(base_img, 35)),
        ("JPEG q70", perturb_jpeg(base_img, 70)),
        ("噪声 σ6", perturb_noise(base_img, 6.0)),
        ("噪声 σ10", perturb_noise(base_img, 10.0, seed=11)),
        ("高斯模糊 3x3", perturb_blur(base_img, 3)),
        ("亮度 -15%", perturb_gain(base_img, 0.85)),
        ("亮度 +15%", perturb_gain(base_img, 1.15)),
        ("对比 0.7", perturb_gain(base_img, 0.7, 128 * 0.3)),
        ("对比 1.3", perturb_gain(base_img, 1.3, -128 * 0.3)),
        ("水印 AI", render(PALETTES["warm_wood"], STONES, last=LAST, watermark=True)),
        ("抖动纹理", render(PALETTES["warm_wood"], STONES, last=LAST, dither=True)),
    ]
    for tag, img in variants:
        res = read(img)
        assert_layout("反识别 %s" % tag, res)

    print("== E) 空盘假阳性防线（任何组合下都必须 0 子）==")
    for name in ("ultra_light", "pale_blue", "mint", "deep_dark", "dark_blue", "warm_wood"):
        pal = PALETTES[name]
        res = read(render(pal, [], watermark=True))
        b, w = stones_of(res)
        check("空盘+水印 0 子 [%s]" % name, (len(b), len(w)), (0, 0))
        check("空盘+水印不 suspect [%s]" % name, res.get("suspect"), False)
    for tag, img in [
        ("噪声 σ10", perturb_noise(render(PALETTES["warm_wood"], []), 10.0, seed=3)),
        ("JPEG q35", perturb_jpeg(render(PALETTES["warm_wood"], []), 35)),
        ("抖动", render(PALETTES["warm_wood"], [], dither=True)),
        ("深盘噪声", perturb_noise(render(PALETTES["deep_dark"], []), 8.0, seed=5)),
    ]:
        res = read(img)
        b, w = stones_of(res)
        check("空盘 0 子 [%s]" % tag, (len(b), len(w)), (0, 0))

    print("== F) 缩放 0.5x / 0.7x（小窗口/低分辨率录屏）==")
    for sc in (0.5, 0.7):
        res = read(perturb_scale(base_img, sc))
        assert_layout("缩放 %.1fx" % sc, res)
        res = read(perturb_scale(render(PALETTES["ultra_light"], STONES, last=LAST), sc))
        assert_layout("缩放+浅盘 %.1fx" % sc, res)

    print("== G) 整屏定位（同色系暖色页面背景 —— renjuworld/五林的真实形态）==")
    # 现场教训（2026-09-19）：renjuworld 把棋盘画在与棋盘**同色系**的木纹页面背景上，
    # 颜色候选分支全灭、网格分支被背景纹理桥接成超大轮廓 → 整屏 locate 直接失败，
    # 桌面覆盖层永远显示「未检测到棋盘」。救手是「投影晶格」候选分支
    # （detector._lattice_rectangles）。这里用合成整屏把它钉死：
    #   · 背景 = 与盘面几乎同色的暖木底 + 纹理噪声 + 全宽 UI 横线 + 大暗块（背景画）；
    #   · 棋盘**不带边框**直接贴上去（现场就是无框同色相接）；
    #   · 判据 = 不给任何提示、整屏 recognize 精确复原 26 颗子。
    board_img = render(PALETTES["warm_wood"], STONES, last=LAST, style="gloss")
    rng = np.random.default_rng(42)
    page = np.empty((1500, 2000, 3), np.float32)
    page[...] = (205, 168, 118)                       # 与盘面（214,178,128）几乎同色
    grain = rng.normal(0, 9.0, page.shape[:2]).astype(np.float32)
    page = np.clip(page + grain[..., None], 0, 255).astype(np.uint8)
    for yy in (120, 360, 640, 980, 1300):             # 全宽 UI 分隔线
        cv2.line(page, (0, yy), (1999, yy), (168, 128, 82), 2)
    cv2.rectangle(page, (60, 760), (430, 1180), (96, 74, 52), -1)   # 背景画暗块
    page_img = Image.fromarray(page)
    page_img.paste(board_img, (180, 160))             # 无框同色相接
    res = read(page_img)
    assert_layout("整屏 同色系背景", res)
    small_page = page_img.resize(
        (int(page_img.width * 0.6), int(page_img.height * 0.6)), Image.LANCZOS)
    res = read(small_page)
    assert_layout("整屏 同色系背景 0.6x", res)

    print("== H) 现场截图回归：屏江棋院（2026-09-19 桌面助手真实失败案例）==")
    # 现场教训（两处源码级修复都在这张图上钉死）：
    #   ① 棋子密集时**横格线被棋子拦腰切断**（两子间隙 < 形态学开核长）→ y 轴投影
    #      晶格被伪晶格劫持（步长 43.9 vs 真格距 52.8）→「未检测到棋盘」或 hp 兜底
    #      锁错位 →「黑白失衡」。修复 = detector._lattice_rectangles 两轴互救。
    #   ② 棋子画得**极大**（直径≈格距、边缘几乎相触）→ 邻子身体/光晕探进平斑块
    #      闸门的环带 → 簇内 10 颗真白子被连杀。
    #      修复 = adaptive 平斑块闸门加「边界环边缘」复核。
    #   此图是真实整屏截图（含任务栏/看图软件/助手面板/桌面图标），走生产 recognize
    #   全路径，不给任何几何提示。0.6x 属网格量化 luck 边缘（0.5x/0.7x 均过），
    #   不设门槛。
    fx = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures",
                      "pingjiang-20260919.jpg")
    if os.path.exists(fx):
        img0 = Image.open(fx).convert("RGB")
        variants = [("1.0x", img0),
                    ("1.6x", img0.resize((int(img0.width * 1.6), int(img0.height * 1.6)),
                                         Image.LANCZOS)),
                    ("0.7x", img0.resize((int(img0.width * 0.7), int(img0.height * 0.7)),
                                         Image.LANCZOS)),
                    ("0.5x", img0.resize((int(img0.width * 0.5), int(img0.height * 0.5)),
                                         Image.LANCZOS))]
        for tag, im in variants:
            res = read(im)
            b, w = stones_of(res)
            check("黑子集合 [屏江 %s]" % tag, sorted(b), sorted(PJ_BLACK))
            check("白子集合 [屏江 %s]" % tag, sorted(w), sorted(PJ_WHITE))
            check("不 suspect [屏江 %s]" % tag, res.get("suspect"), False)
    else:
        print("  （缺 fixtures/pingjiang-20260919.jpg，跳过现场回归）")

    print("\n== recog_vaccine: %d passed, %d failed ==" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
