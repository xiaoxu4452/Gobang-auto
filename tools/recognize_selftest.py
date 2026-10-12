#!/usr/bin/env python
"""自适应棋盘识别核心 —— 自测（合成棋盘 × 多底色 + 真实故障场景复刻）

被 tools/test-recognize-adaptive.js 以子进程方式调用；退出码 0 = 全通过。

覆盖：
  1. 空盘（含全部装饰：星位、坐标、开局限制蓝框、绿色十字标记）必须读出 **0 子**
     —— 这是本次故障的直接回归护栏：旧逻辑在此读出 224 个假白子 → 「对手五子连珠」。
  2. 五种棋盘底色（亮米底 / 经典木色 / 深色主题 / 浅灰底 / gomocalc 木色）下，
     棋子布局必须逐一精确读出（含落子编号、最后一手红圈、禁入点红叉等干扰）。
  3. 极淡网格线（线与底色对比 < 6 灰阶）时，Canny+Hough 兜底网格定位仍能读对。
  4. 棋理不变量自诊断：正常局面 suspect=False；整盘同色/黑白严重失衡 suspect=True。
"""
import base64
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.abspath(os.path.join(HERE, "..", "engine-server", "python"))
sys.path.insert(0, PYDIR)

from PIL import Image, ImageDraw  # noqa: E402
import numpy as np  # noqa: E402
import recognize_server  # noqa: E402
from gomoku_assistant import adaptive  # noqa: E402
from gomoku_assistant import engine as eng  # noqa: E402

SIZE = 15
W = 1200

PALETTES = {
    # 本次故障站点：浅米色底（亮度 234）+ 棕色细线 —— 旧逻辑的绝对阈值(215)被底色击穿
    "light_beige": dict(board=(242, 234, 216), line=(166, 152, 125), coord=(179, 165, 138),
                        black=(25, 25, 25), white=(255, 255, 255), stroke=(183, 173, 155),
                        num_on_black=(232, 232, 230), num_on_white=(25, 25, 25), last=(214, 74, 58)),
    "classic_wood": dict(board=(222, 184, 135), line=(120, 90, 50), coord=(120, 90, 50),
                         black=(20, 20, 20), white=(255, 255, 255), stroke=(140, 120, 90),
                         num_on_black=(235, 235, 235), num_on_white=(30, 30, 30), last=(200, 60, 50)),
    "dark_theme": dict(board=(43, 43, 46), line=(92, 92, 98), coord=(110, 110, 115),
                       black=(8, 8, 8), white=(248, 248, 248), stroke=(120, 120, 126),
                       num_on_black=(230, 230, 230), num_on_white=(20, 20, 20), last=(220, 80, 70)),
    "light_gray": dict(board=(232, 232, 232), line=(186, 186, 186), coord=(200, 200, 200),
                       black=(25, 25, 25), white=(255, 255, 255), stroke=(190, 190, 190),
                       num_on_black=(232, 232, 230), num_on_white=(25, 25, 25), last=(214, 74, 58)),
    "gomocalc": dict(board=(217, 179, 130), line=(120, 90, 60), coord=(120, 90, 60),
                     black=(18, 18, 18), white=(252, 252, 252), stroke=(150, 130, 100),
                     num_on_black=(235, 235, 235), num_on_white=(30, 30, 30), last=(200, 60, 50)),
    # —— 空心描边画法（用户 2026-09-16 提供的真实截图形态）——
    # 浅底站点常把白子画成「空心白圆 + 深色描边」，极端时**就是一个黑圆环**，
    # 内盘与底色完全同色 → 只能靠描边环识别。这曾是 adaptive 的致命盲区（白子全被判黑）。
    "hollow_white": dict(board=(255, 255, 255), line=(118, 118, 118), coord=(118, 118, 118),
                         black=(12, 12, 12), white=(255, 255, 255), stroke=(45, 45, 45),
                         ring_white=(40, 40, 40), ring_black=(40, 40, 40),
                         num_on_black=(235, 235, 235), num_on_white=(130, 130, 130),
                         last=(214, 74, 58)),
    # 对称画法：深色底站点反过来把**黑子**画成「浅色边框/边框阴影」，内盘与深底同色。
    "dark_hollow": dict(board=(30, 30, 34), line=(112, 112, 122), coord=(132, 132, 142),
                        black=(8, 8, 8), white=(246, 246, 250), stroke=(205, 205, 214),
                        ring_black=(210, 210, 220), ring_white=(210, 210, 220),
                        num_on_black=(210, 210, 220), num_on_white=(20, 20, 20),
                        last=(220, 80, 70)),
}

# 这两个 palette 是「空心描边画法」专用：底色与白子/黑子同色，**只有靠描边环才可辨**。
# 让它们走「实心棋子」的常规用例没有意义（实心等于与底色融为一体，物理上不可辨），
# 故常规章节跳过，改由章节 5 用空心画法覆盖。
HOLLOW_ONLY = ("hollow_white", "dark_hollow")

# 一个真实中局（6 黑 5 白，交替落子 → |黑-白|=1）
BLACK = [(7, 7), (7, 8), (8, 7), (6, 6), (9, 9), (5, 7)]
WHITE = [(7, 6), (8, 8), (6, 7), (9, 8), (8, 6)]

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


def render(pal, stones, last=None, forbid=None, deco=True, faint=False, star_cross=True,
           hollow=None, thick=False, partial=False):
    """按站点 drawBoard 的图层顺序合成一张棋盘图。

    stones: [(row, col, 1|2)]；last: (row,col) 最后一手红圈；forbid: [(row,col)] 禁入点红叉
    hollow: None | "white" | "black" —— 指定颜色改用「空心描边」画法（内盘=底色，只有一圈描边）
    thick:  画粗网格线（真实站点截图那样，空交叉点内盘有一半是线）
    partial: 描边只画约 72% 的弧（模拟「多半圈描边 + 一面落影」的画法）
    """
    cell, margin = geom()
    img = Image.new("RGB", (W, W), pal["board"])
    d = ImageDraw.Draw(img)
    line_col = tuple(min(255, pal["board"][i] + 10) for i in range(3)) if faint else pal["line"]
    px = lambda i: margin + i * cell  # noqa: E731
    grid_end = px(SIZE - 1)
    lw = 3 if thick else 1
    for i in range(SIZE):
        d.line([(px(0), px(i)), (grid_end, px(i))], fill=line_col, width=lw)
        d.line([(px(i), px(0)), (px(i), grid_end)], fill=line_col, width=lw)
    d.rectangle([px(0), px(0), grid_end, grid_end], outline=line_col, width=2 if not thick else 4)
    # 星位
    for sx, sy in [(3, 3), (11, 3), (7, 7), (3, 11), (11, 11)]:
        r = max(2.2, cell * 0.08)
        d.ellipse([px(sx) - r, px(sy) - r, px(sx) + r, px(sy) + r], fill=pal["line"])
    # 坐标文字（棋盘网格之外，绝不该被读成棋子）
    for i in range(SIZE):
        d.text((px(i), px(SIZE - 1) + margin * 0.62), chr(65 + i), fill=pal["coord"], anchor="mm")
        d.text((px(0) - margin * 0.62, px(i)), str(SIZE - i), fill=pal["coord"], anchor="mm")
    if deco:
        # 开局限制「蓝框」：四角 L 型粗折线（截图里的蓝色角标）
        bl = (46, 134, 193)
        lw = max(2, int(cell * 0.07))
        arm = cell * 3
        for cx, cy, dx, dy in [(px(0), px(0), 1, 1), (grid_end, px(0), -1, 1),
                               (px(0), grid_end, 1, -1), (grid_end, grid_end, -1, -1)]:
            d.line([(cx, cy), (cx + dx * arm, cy)], fill=bl, width=lw)
            d.line([(cx, cy), (cx, cy + dy * arm)], fill=bl, width=lw)
        # 星位上的绿色十字标记（截图里星位是绿十字）
        if star_cross:
            gc = (60, 200, 110)
            cw = max(2, int(cell * 0.06))
            a = cell * 0.22
            for sx, sy in [(3, 3), (11, 3), (7, 7), (3, 11), (11, 11)]:
                d.line([(px(sx) - a, px(sy)), (px(sx) + a, px(sy))], fill=gc, width=cw)
                d.line([(px(sx), px(sy) - a), (px(sx), px(sy) + a)], fill=gc, width=cw)
    # 棋子（含落子编号）
    r = cell * 0.44
    ring_lw = max(2, int(cell * 0.09))
    for idx, (row, col, color) in enumerate(stones):
        cx, cy = px(col), px(row)
        box = [cx - r, cy - r, cx + r, cy + r]
        is_hollow = (hollow == "both") or (hollow == "white" and color == eng.WHITE) or \
                    (hollow == "black" and color == eng.BLACK)
        if is_hollow:
            # 空心描边：内盘保持底色，靠一圈（或大半圈）描边表示棋子
            ring = pal.get("ring_white" if color == eng.WHITE else "ring_black", pal["stroke"])
            if partial:
                d.arc(box, start=-70, end=190, fill=ring, width=ring_lw)
            else:
                d.ellipse(box, outline=ring, width=ring_lw)
            d.text((cx, cy), str(idx + 1), fill=pal["coord"], anchor="mm")
        elif color == eng.BLACK:
            d.ellipse(box, fill=pal["black"])
            d.text((cx, cy), str(idx + 1), fill=pal["num_on_black"], anchor="mm")
        else:
            d.ellipse(box, fill=pal["white"], outline=pal["stroke"], width=1)
            d.text((cx, cy), str(idx + 1), fill=pal["num_on_white"], anchor="mm")
    if last is not None:
        cx, cy = px(last[1]), px(last[0])
        rr = r + 1.2
        lw = max(2, int(cell * 0.06))
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=pal["last"], width=lw)
    for row, col in (forbid or []):
        cx, cy = px(col), px(row)
        c = cell * 0.2
        lw = max(2, int(cell * 0.07))
        d.line([(cx - c, cy - c), (cx + c, cy + c)], fill=pal["last"], width=lw)
        d.line([(cx + c, cy - c), (cx - c, cy + c)], fill=pal["last"], width=lw)
    return img


def read(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return recognize_server.recognize(b64, SIZE)


def stones_of(res):
    b = {(s["y"], s["x"]) for s in res.get("black", [])}
    w = {(s["y"], s["x"]) for s in res.get("white", [])}
    return b, w


def main():
    layout = [(r, c, eng.BLACK) for r, c in BLACK] + [(r, c, eng.WHITE) for r, c in WHITE]
    want_b, want_w = set(BLACK), set(WHITE)

    print("== 1) 空盘 + 全部装饰：必须读出 0 子（旧逻辑在此读出 224 假白子）==")
    for name, pal in PALETTES.items():
        res = read(render(pal, [], deco=True))
        b, w = stones_of(res)
        check("空盘零子 [%s]" % name, (len(b), len(w)), (0, 0))
        check("空盘不变量 OK [%s]" % name, res.get("suspect"), False)

    print("== 2) 多底色中局：布局精确读对（含编号/红圈/禁入点红叉干扰）==")
    for name, pal in PALETTES.items():
        if name in HOLLOW_ONLY:
            continue
        img = render(pal, layout, last=WHITE[-1], forbid=[(4, 4), (10, 10)], deco=True)
        res = read(img)
        b, w = stones_of(res)
        check("黑子集合 [%s]" % name, sorted(b), sorted(want_b))
        check("白子集合 [%s]" % name, sorted(w), sorted(want_w))
        check("不变量 OK [%s]" % name, res.get("suspect"), False)

    print("== 2b) 边角棋子 + 密集棋簇收官盘（旧实现的两处盲区）==")
    edge = [(0, 0, eng.BLACK), (0, 14, eng.WHITE), (14, 0, eng.WHITE),
            (14, 14, eng.BLACK), (0, 7, eng.WHITE), (7, 0, eng.BLACK)]
    for name in ("light_beige", "dark_theme"):
        pal = PALETTES[name]
        res = read(render(pal, edge, last=(0, 7), deco=True))
        b, w = stones_of(res)
        check("边角黑子 [%s]" % name, sorted(b), sorted({(r, c) for r, c, v in edge if v == eng.BLACK}))
        check("边角白子 [%s]" % name, sorted(w), sorted({(r, c) for r, c, v in edge if v == eng.WHITE}))
    dense = []
    idx = 0
    for r in range(5, 10):
        for c in range(5, 10):
            dense.append((r, c, eng.BLACK if idx % 2 == 0 else eng.WHITE))
            idx += 1
    for name in ("light_beige", "classic_wood", "dark_theme"):
        pal = PALETTES[name]
        res = read(render(pal, dense, last=(9, 9), forbid=[(4, 4)], deco=True))
        b, w = stones_of(res)
        check("密集盘黑子数 [%s]" % name, len(b), len([1 for _, _, v in dense if v == eng.BLACK]))
        check("密集盘白子数 [%s]" % name, len(w), len([1 for _, _, v in dense if v == eng.WHITE]))
        check("密集盘布局精确 [%s]" % name,
              (sorted(b), sorted(w)),
              (sorted((r, c) for r, c, v in dense if v == eng.BLACK),
               sorted((r, c) for r, c, v in dense if v == eng.WHITE)))

    print("== 3) 极淡网格线：Canny+Hough 兜底定位仍读对 ==")
    for name in ("light_beige", "classic_wood"):
        pal = PALETTES[name]
        res = read(render(pal, layout, last=WHITE[-1], faint=True))
        b, w = stones_of(res)
        check("淡线网格黑子 [%s]" % name, sorted(b), sorted(want_b))
        check("淡线网格白子 [%s]" % name, sorted(w), sorted(want_w))
        print("     （网格来源=%s conf=%.3f）" % (res["geometry"]["source"], res["geometry"]["confidence"]))

    print("== 3b) Hough 兜底网格定位（直接单测）==")
    import cv2  # noqa: E402
    cell, margin = geom()
    pal = PALETTES["classic_wood"]
    img = render(pal, [], deco=False)
    gray = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2GRAY)
    got = adaptive.locate_grid_hough(gray, SIZE)
    check("Hough 定位返回结果", got is not None, True)
    if got is not None:
        xs, ys, resid = got
        truth = np.array([margin + i * cell for i in range(SIZE)])
        check("Hough 归一化残差 < 0.2 格", bool(resid < 0.2), True)
        check("Hough 横线误差 < 2.5px", bool(float(np.max(np.abs(ys - truth))) < 2.5), True)
        check("Hough 竖线误差 < 2.5px", bool(float(np.max(np.abs(xs - truth))) < 2.5), True)

    print("== 4) 棋理不变量自诊断 ==")
    ok = np.zeros((SIZE, SIZE), dtype=np.int8)
    ok[7, 7] = eng.BLACK
    ok[7, 8] = eng.WHITE
    check("正常局面 suspect=False", adaptive.invariants(ok)["suspect"], False)
    swamp = np.full((SIZE, SIZE), eng.WHITE, dtype=np.int8)
    swamp[7, 7] = eng.EMPTY
    check("整盘同色 suspect=True", adaptive.invariants(swamp)["suspect"], True)
    unbal = np.zeros((SIZE, SIZE), dtype=np.int8)
    for i in range(6):
        unbal[3, i] = eng.BLACK
    unbal[9, 3] = eng.WHITE
    check("黑白失衡 suspect=True", adaptive.invariants(unbal)["suspect"], True)

    print("== 4b) 外边界伪棋子清理（棋盘外框/窗口边框被读成棋子）==")
    print("      （实测故障：桌面端真实屏幕上「最外一行整行同色」→ 黑白失衡 → suspect=True")
    print("        → 宿主丢弃整帧 → 面板永远显示「未检测到棋盘」）")
    edge = np.zeros((SIZE, SIZE), dtype=np.int8)
    for i in range(SIZE):
        edge[0, i] = eng.WHITE                     # 外框被当成「整行 15 个白子」
    conf_e = np.ones((SIZE, SIZE), dtype=np.float32)
    removed = adaptive.strip_border_artifacts(edge, conf_e)
    check("外边界整行同色被剔除", int(removed), SIZE)
    check("剔除后盘面为空", int((edge != eng.EMPTY).sum()), 0)
    check("剔除后置信度一并清零", float(conf_e[0].sum()), 0.0)
    check("剔除后 suspect=False（不再误杀整帧）", adaptive.invariants(edge)["suspect"], False)
    # 竖边同理（外框可能在左右两侧）
    edge_c = np.zeros((SIZE, SIZE), dtype=np.int8)
    edge_c[:, SIZE - 1] = eng.BLACK
    check("外边界整列同色被剔除", int(adaptive.strip_border_artifacts(edge_c)), SIZE)
    # 反向护栏 1：真实棋形（含终局五连）绝不能被误删
    real = np.zeros((SIZE, SIZE), dtype=np.int8)
    for i in range(5):
        real[7, 4 + i] = eng.BLACK                 # 合法存在的终局五连
    for i in range(4):
        real[8, 4 + i] = eng.WHITE
    before = int((real != eng.EMPTY).sum())
    check("内部五连/四连绝不被误删", int(adaptive.strip_border_artifacts(real)), 0)
    check("真实棋形盘面不变", int((real != eng.EMPTY).sum()), before)
    # 反向护栏 2：整盘同色清理边界后内部仍失衡 → 依旧 suspect
    swamp2 = np.full((SIZE, SIZE), eng.WHITE, dtype=np.int8)
    adaptive.strip_border_artifacts(swamp2)
    check("整盘同色清理后仍 suspect=True", adaptive.invariants(swamp2)["suspect"], True)

    print("== 4c) exclude 抹除路径：截图为 PIL 只读视图时不得崩 ==")
    print("      （实测故障：capture_screen 用 np.asarray(img.convert('RGB')) 拿到的是**只读**")
    print("        视图，_mask_excluded 原地写入抛 'assignment destination is read-only'；")
    print("        而宿主每一帧都带 exclude → 整帧 ok:false → 永远拿不到 found →")
    print("        面板永远「未检测到棋盘」、屏幕上不画任何指导层。")
    print("        Pillow 12 起 np.asarray(pil) 变为只读，随包运行时一升级就复发。）")
    from gomoku_assistant import screen_board as sb  # noqa: E402

    base = np.full((60, 80, 3), 200, dtype=np.uint8)
    base[10:30, 10:30] = 40                     # 待抹除区：与底色中位数明显不同，便于判定
    ro = base.copy()
    ro.flags.writeable = False                  # 复刻 np.asarray(pil) 的只读视图
    check("只读数组前置条件成立", ro.flags.writeable, False)
    m = sb._mask_excluded(ro, [{"x": 10, "y": 10, "w": 20, "h": 20}], (0, 0))
    check("抹除路径不抛异常且返回可写数组", bool(m.flags.writeable), True)
    check("抹除区被填成底色中位数（不再是最初的 40）", int(m[15, 15, 0]), 200)
    check("外部区域不受影响", int(m[40, 40, 0]), 200)
    check("原始只读数组未被改动", int(ro[15, 15, 0]), 40)
    check("无 exclude 时原样返回（每帧不做多余的全屏拷贝）",
          sb._mask_excluded(ro, None, (0, 0)) is ro, True)
    check("空 exclude 列表同样原样返回",
          sb._mask_excluded(ro, [], (0, 0)) is ro, True)

    print("== 5) 空心描边画法：浅底「白子=深色圆环」/ 深底「黑子=浅色圆环」==")
    print("      （旧 adaptive 在此把白子全判成黑子：它用整块连通域的中位数判色，拿到的是描边）")
    # 浅底：黑子实心、白子空心深色圆环
    res = read(render(PALETTES["hollow_white"], layout, hollow="white"))
    gb, gw = stones_of(res)
    check("空心白子·黑子集合 [hollow_white]", gb, want_b)
    check("空心白子·白子集合 [hollow_white]", gw, want_w)
    check("空心白子·不变量 OK [hollow_white]", res.get("suspect"), False)
    # 深底：白子实心、黑子空心浅色圆环（对称画法）
    res = read(render(PALETTES["dark_hollow"], layout, hollow="black"))
    gb, gw = stones_of(res)
    check("空心黑子·黑子集合 [dark_hollow]", gb, want_b)
    check("空心黑子·白子集合 [dark_hollow]", gw, want_w)
    check("空心黑子·不变量 OK [dark_hollow]", res.get("suspect"), False)
    # 极端：白子就是「纯黑圆环」，内盘=底色；且网格线加粗（空点内盘本就有一半是线）
    res = read(render(PALETTES["hollow_white"], layout, hollow="white", thick=True))
    gb, gw = stones_of(res)
    check("粗网格线+黑圆环·黑子集合", gb, want_b)
    check("粗网格线+黑圆环·白子集合", gw, want_w)
    # 多半圈描边 + 落影：环不闭合，但连续弧仍应过半圈
    res = read(render(PALETTES["hollow_white"], layout, hollow="white", partial=True))
    gb, gw = stones_of(res)
    check("多半圈描边·黑子集合", gb, want_b)
    check("多半圈描边·白子集合", gw, want_w)
    # 反向护栏：粗网格线的**空盘**绝不能读出一堆子（空点内盘被线十字占掉一半）
    for nm, pl, hw in [("hollow_white", PALETTES["hollow_white"], "white"),
                       ("dark_hollow", PALETTES["dark_hollow"], "black")]:
        res = read(render(pl, [], hollow=hw, thick=True))
        gb, gw = stones_of(res)
        check("粗线空盘零子 [%s]" % nm, (len(gb), len(gw)), (0, 0))

    print("== 6) 用户矩形区域 region：只在该矩形内认盘，几何偏移回整屏坐标 ==")
    print("      （桌面端「手动调节」要让用户拖一个矩形圈定识别区域，宿主只在这块里认盘；")
    print("        输出几何必须与全屏自动找盘处在同一坐标系，且子数一致。region 与 exclude")
    print("        同口径 = 虚拟屏绝对物理像素，合成图棋盘居中 + 四周装饰，直接拿整图坐标当 region。）")
    for nm in ("light_beige", "dark_theme"):
      pal = PALETTES[nm]
      img = render(pal, layout, last=WHITE[-1], deco=True)
      arr = np.asarray(img, dtype=np.uint8)
      base = sb.scan_once(arr, size=SIZE)            # 全屏基线
      check("region 基线 found [%s]" % nm, base.get("found"), True)
      bb, bw = stones_of(base)
      # 圈定一块覆盖整盘（含少量边距）的矩形，模拟用户手拖
      reg = [60, 60, arr.shape[1] - 120, arr.shape[0] - 120]
      res = sb.scan_once(arr, size=SIZE, region=reg)
      check("region found [%s]" % nm, res.get("found"), True)
      rb, rw = stones_of(res)
      check("region 黑子集合==全屏 [%s]" % nm, sorted(rb), sorted(bb))
      check("region 白子集合==全屏 [%s]" % nm, sorted(rw), sorted(bw))
      # 几何偏移回整屏坐标：region 模式下 board_rect 应与全屏基线完全一致（同一空间）
      check("region board_rect==全屏 [%s]" % nm,
            (int(round(res["board_rect"]["x"])), int(round(res["board_rect"]["y"])),
             int(round(res["board_rect"]["w"])), int(round(res["board_rect"]["h"]))),
            (int(round(base["board_rect"]["x"])), int(round(base["board_rect"]["y"])),
             int(round(base["board_rect"]["w"])), int(round(base["board_rect"]["h"]))))
      check("region suspect==全屏 [%s]" % nm, res.get("suspect"), base.get("suspect"))
      # 反向护栏：region 框在棋盘外（顶部中段空白，无 L 角框/坐标字/网格）应 found=False
      out = sb.scan_once(arr, size=SIZE, region=[300, 5, 200, 55])
      check("框在棋盘外的 region 找不到盘 [%s]" % nm, out.get("found"), False)

    print("--- %d passed, %d failed ---" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
