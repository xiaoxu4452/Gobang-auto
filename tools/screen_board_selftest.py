"""整屏棋盘定位自测（桌面覆盖层应用的核心能力）。

验证三件事：
  1. 整幅就是棋盘时（等价于「棋盘铺满窗口」）能定位。
  2. 棋盘只是**屏幕上一小块**（周围有浏览器 UI / 桌面 / 其它窗口）时能定位，且位置误差 < 1 格。
  3. 屏幕上根本没有棋盘时不误报。
"""
import os
import sys

import numpy as np
import cv2
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'engine-server', 'python'))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from gomoku_assistant import screen_board as SB   # noqa: E402
import recognize_selftest as RST                  # noqa: E402  (复用它的棋盘合成器)

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


def check_close(name, got, want, tol, unit=""):
    global passed, failed
    ok = got is not None and abs(got - want) <= tol
    if ok:
        passed += 1
        print("  \u2713 " + name + "  (%s vs %s, tol %s%s)" % (round(got, 1), want, tol, unit))
    else:
        failed += 1
        print("  \u2717 " + name + "  got=" + repr(got) + " want=" + repr(want) + " tol=" + repr(tol))


def make_desktop(w=1920, h=1080):
    """合成一张「桌面」：任务栏 + 几个窗口 + 文字块（制造大量直线干扰）。"""
    img = Image.new("RGB", (w, h), (30, 42, 66))
    d = ImageDraw.Draw(img)
    # 任务栏
    d.rectangle([0, h - 48, w, h], fill=(22, 30, 48))
    for i in range(8):
        d.rectangle([20 + i * 90, h - 40, 80 + i * 90, h - 8], fill=(60, 70, 95))
    # 模拟浏览器窗口（标题栏 + 若干「文字行」横线）—— 干扰线的主要来源
    d.rectangle([80, 60, 900, 700], fill=(250, 250, 250))
    d.rectangle([80, 60, 900, 100], fill=(225, 228, 235))
    for i in range(14):
        y = 130 + i * 22
        d.line([(110, y), (110 + 300 + (i % 5) * 60, y)], fill=(150, 150, 150), width=2)
    # 另一个窗口 + 竖直分隔线
    d.rectangle([1000, 120, 1500, 620], fill=(242, 242, 245))
    for i in range(6):
        x = 1040 + i * 80
        d.line([(x, 150), (x, 600)], fill=(210, 210, 210), width=2)
    return img


def main():
    print("== 1) 整幅即棋盘：能定位（等价于棋盘铺满窗口）==")
    board_img = RST.render(RST.PALETTES["light_beige"], RST.layout) \
        if hasattr(RST, "layout") else None
    if board_img is None:
        RST.main  # noqa
        layout = [(r, c, RST.eng.BLACK) for r, c in RST.BLACK] + \
                 [(r, c, RST.eng.WHITE) for r, c in RST.WHITE]
        board_img = RST.render(RST.PALETTES["light_beige"], layout)
    rgb_full = np.asarray(board_img.convert("RGB"))
    g = cv2.cvtColor(rgb_full, cv2.COLOR_RGB2GRAY)
    cand = SB.find_board_rect(g)
    check("整幅棋盘能被找到", cand is not None, True)
    if cand:
        x0, y0, x1, y1 = cand["rect"]
        check_close("rect 左上角 x 接近棋盘起点", x0, 81.6, 60.0)
        check_close("rect 右下角 x 接近棋盘终点", x1, 1117.6, 60.0)
        check("识别为 15 路", cand["size"], 15)

    print("== 2) 棋盘只是屏幕上的一小块（周围全是干扰 UI）==")
    desk = make_desktop()
    bw, bh = 520, 520
    small = board_img.resize((bw, bh), Image.LANCZOS)
    px, py = 1180, 300                      # 贴图位置
    desk.paste(small, (px, py))
    rgb = np.asarray(desk.convert("RGB"))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    cand = SB.find_board_rect(gray)
    check("屏幕局部棋盘能被找到", cand is not None, True)
    if cand:
        x0, y0, x1, y1 = cand["rect"]
        # 缩放后棋盘在贴图中的内边距：81.6 * (520/1200) ≈ 35.4
        scale = bw / 1200.0
        exp_x0 = px + 81.6 * scale
        exp_x1 = px + 1117.6 * scale
        step = (exp_x1 - exp_x0) / 14.0
        check_close("棋盘左边界误差 < 1 格", x0, exp_x0, step, " px")
        check_close("棋盘右边界误差 < 1 格", x1, exp_x1, step, " px")
        check_close("棋盘上边界误差 < 1 格", y0, py + 81.6 * scale, step, " px")

    print("== 3) 精确定位 + 读子（复用既有自适应读子）==")
    res = SB.scan_once(rgb, size=15)
    check("scan_once 找到棋盘", bool(res.get("found")), True)
    if res.get("found"):
        xl, yl = res["geometry"]["x_lines"], res["geometry"]["y_lines"]
        check("网格线数量 = 15", (len(xl), len(yl)), (15, 15))
        check_close("首条竖线位置误差 < 1 格", xl[0], exp_x0, step, " px")
        # 棋盘上是 6 黑 5 白
        check("黑子数 = 6", len(res["black"]), 6)
        check("白子数 = 5", len(res["white"]), 5)
        check("不变量未报警", res.get("suspect"), False)
        check("输出了屏幕坐标矩形", set(res["board_rect"].keys()), {"x", "y", "w", "h"})

    print("== 4) 屏幕上没有棋盘：不误报 ==")
    desk2 = make_desktop()
    rgb2 = np.asarray(desk2.convert("RGB"))
    r2 = SB.scan_once(rgb2, size=15)
    check("无棋盘时 found=False", bool(r2.get("found")), False)

    print("== 5) region 模式（桌面端「手动调节」）同样要抹掉本软件自己的窗口 ==")
    # 为什么单列一节：scan_once 的 region 分支是**先裁屏再识别**，旧实现顺手把
    # exclude 传成了 None —— 于是用户手动框出来的那块里，一旦压着面板 / 局面窗 /
    # 中空选框（它们的等距行线极像棋盘线族），就会被当成本软件以外的棋盘。
    # 判据用**差分**：同一块识别区，抹色 ⇒ 认不出；不抹色 ⇒ 认得出。
    # 少了任何一条，测试都可能因为「反正都认不出」而假绿。
    region = [px, py, bw, bh]
    cover = [{"x": px, "y": py, "w": bw, "h": bh}]     # 把整个识别区抹掉（模拟面板压在上面）
    r5a = SB.scan_once(rgb, size=15, region=region, exclude=cover)
    check("region 模式下 exclude 真的生效（整个识别区被抹掉 → 认不出棋盘）",
          bool(r5a.get("found")), False)
    r5b = SB.scan_once(rgb, size=15, region=region)
    check("（对照）region 模式不抹色时仍能认出棋盘", bool(r5b.get("found")), True)
    if r5b.get("found"):
        # 加上 exclude 后必须**只**被抹在矩形内部：区域外的几何不该被挪位。
        check("（对照）region 模式的坐标基准没被 exclude 的 offset 弄歪",
              round(float(r5b["board_rect"]["x"])) == round(float(px + 81.6 * (bw / 1200.0))),
              True)

    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
