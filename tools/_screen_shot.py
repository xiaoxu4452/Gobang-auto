#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""按物理像素截图（可只截某个矩形），并可选打印该区域两条色带的均色。

给 tools/test-overlay-alpha.js 用；手动排查覆盖层/面板/局面窗时也直接用它。

为什么用项目自带的 embeddable Python（PIL + numpy）而不是 PowerShell + System.Drawing：
  那段脚本会被杀软的 AMSI 直接拦掉 ——
    "This script contains malicious content and has been blocked by your antivirus software"
  进程内截图不触发 AMSI，也不依赖 PowerShell 执行策略。
  （顺带印证用户反复提的那条：「总被系统杀毒软件查杀」不是空穴来风。）

★ 必须先把自己标成 per-monitor DPI aware，否则拿到的 DISPLAY DC 是**逻辑像素**，
  和宿主日志里的窗口坐标（物理像素）对不上 —— 多显示器机器上会裁到完全无关的区域
  （踩过：1920 主屏 + 右侧副屏，面板在 x=2619，按「物理/逻辑」缩放后裁出来是一张桌面截图）。
  标成 DPI aware 之后，截图与窗口坐标同处物理像素空间，直接按矩形裁即可。
  另外多屏时虚拟屏原点可能不是 (0,0)（副屏在主屏左边时是负数），所以要减掉 SM_XVIRTUALSCREEN。

用法：
  python _screen_shot.py full <outPng>
  python _screen_shot.py crop <x> <y> <w> <h> <outPng> [--stats]
  python _screen_shot.py posbands <x> <y> <w> <h> <outPng>
  python _screen_shot.py posinfo <x> <y> <w> <h> <pad> <outPng>
输出：--stats 时打印一行 JSON {"W","H","hdr":[r,g,b],"body":[r,g,b]}
      posbands 时打印一行 JSON（局面小窗专用分带统计，见 posbands_stats 注释）
      posinfo  时先按「非纯色背景」**自己定位**窗口（见 locate_window），再输出同一份分带统计
               + "loc":{"x","y","dx","dy","spanX","spanY"}
"""
import ctypes
import json
import sys

# ---- 1) 先标 DPI 感知（必须在任何 GDI/截图调用之前）----
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)      # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from PIL import ImageGrab            # noqa: E402  (必须在 DPI 设置之后导入/调用)
import numpy as np                   # noqa: E402


def virtual_origin():
    """虚拟屏左上角（多屏时可能为负）。"""
    u = ctypes.windll.user32
    return u.GetSystemMetrics(76), u.GetSystemMetrics(77)   # SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN


def _longest_run(idx):
    """把一组递增下标里**最长的一段连续区间**挑出来，返回 (起点, 终点)；空则 None。

    为什么不是「取最小值」：这一带可能还有**别人的**窗口在抢屏 —— 本程序自己残留的
    实例（面板崩溃自愈会重启整个进程，老进程的窗口还在）、或者别的 topmost 程序。
    只取「最上面那一行有内容的像素」时，一块比小窗更靠上的 2px 虚线框就能把定位
    整个带偏（踩过：整轮截图裁偏 79px，标题栏带读出来是底色、一堆像素断言假红，
    真正的原因却是取样框偏了）。小窗自身是一整块 718px 高的实心矩形，
    而这类外来内容总是又薄又碎 —— 「最长连续段」正好把两者分开。"""
    if len(idx) == 0:
        return None
    best = (idx[0], idx[0]); cur = (idx[0], idx[0])
    for k in range(1, len(idx)):
        if idx[k] == cur[1] + 1:
            cur = (cur[0], idx[k])
        else:
            cur = (idx[k], idx[k])
        if cur[1] - cur[0] > best[1] - best[0]:
            best = cur
    return best


def locate_window(full, x, y, w, h, pad, tint=(0, 255, 0), tol=28):
    """在 (x-pad, y-pad, w+2pad, h+2pad) 这块区域里**自己找出**「局面」小窗在哪。

    为什么要多这一步：宿主的 [pos] geometry 日志只记录**创建时**的坐标，而截图是几百毫秒
    之后的事 —— 期间主面板可能因为等待页面回报而移动（小窗默认贴在面板左侧），
    或者上一次运行残留的实例窗口还压在屏幕上。直接按日志坐标裁，就会裁偏
    （现场表现：截图顶部没有蓝色标题栏、底部多出一条覆盖层底色）。

    定位依据**不依赖颜色**（低透明度下标题栏的蓝会被底色稀释成青绿，按颜色找必然失手）：
    测试用 GB_TEST_BACKDROP 把主覆盖层铺成纯色（默认纯绿），于是「不是这个纯色的像素」
    就一定是小窗自己画的。

    两步都是「先挑够宽/够高的一行/一列，再取**最长连续段**」：
      · 列：整列里非底色像素 > 0.3h 才算「小窗的一列」→ 取最长连续的一段，左端即窗口左边界；
      · 行：在窗口宽度范围内，非底色像素 > 0.6w 才算「小窗的一行」→ 同样取最长连续段，
        上端即窗口上边界。

    ⚠ 行阈值从 0.3w 提到 0.6w、并且加了「最长连续段」这一层，都是被真实事故逼出来的：
      覆盖层的角框 / 棋盘虚线框会压在测试底色上（已修），而**任何**别的 topmost 窗口都能
      再犯同样的错。小窗的每一行几乎都是满宽的实心内容（标题栏是满宽色带、卡片是满宽白底），
      拿 0.6w 去量绰绰有余；薄薄的虚线段则必然被挡在外面。
    """
    a = np.asarray(full.convert('RGB')).astype(np.float64)
    H, W = a.shape[:2]
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(W, x + w + pad); y1 = min(H, y + h + pad)
    sub = a[y0:y1, x0:x1]
    nong = np.abs(sub - np.array(tint, dtype=np.float64)).max(axis=2) > tol

    tall = np.nonzero(nong.sum(axis=0) > 0.3 * h)[0]
    if not len(tall):
        return None
    run_c = _longest_run(tall)
    left = int(run_c[0])
    right = int(min(sub.shape[1], left + w))

    rowcnt = nong[:, left:right].sum(axis=1)
    wide = np.nonzero(rowcnt > 0.6 * w)[0]
    if not len(wide):
        return None
    run_r = _longest_run(wide)
    top, bot = int(run_r[0]), int(run_r[1])
    return {'dx': int(x0 + left) - x, 'dy': int(y0 + top) - y,
            'spanY': int(bot - top + 1), 'spanX': int(right - left)}


def posbands_stats(a):
    """「局面」小窗专用分带统计。

    分带比例**直接来自 host.cpp 的 POS_* 设计常量**（窗口 268x416 设计单位）：
      标题栏纯色块 x 90..205 y 4..26   （避开左侧「局面」文字与右侧按钮，取一块纯品牌蓝）
      标题栏参考   x 30..60  y 2..26
      棋盘卡片     x 12..256 y 38..278 （POS_PAD/POS_CARD_W/POS_BY/POS_CARD_H=240）
      坐标栏         左 x 12..25 / 右 x 241..255 / 下 y 261..275
                     （棋盘线跨度 x 29..239 y 46..256；标注与棋盘线的缝 = POS_COORD_GAP = 6）
      代码卡片文字 x 20..248 y 294..362（POS_CODE_Y(286) + 8 起）
      按钮行       x 22..246 y 378..404（POS_BTN_Y(378)..+POS_BTN_H(26)）
    ⚠ 这几条比例是「渲染断言是否可信」的前提：写错就会把代码卡片/按钮行的像素算进棋盘带，
      所有数字一起失真。2026-09-17 的两次版式改动（420 → 406 → 410，棋盘 224 → 196 → 210）
      和 2026-09-19 的坐标缝改动都要同步改这里：
        POS_COORD_GAP 2 → 6（用户：「有的子落到棋盘边缘会没过数字和字母」，缝必须 > 棋子半径 5.5）
        ⇒ 卡片下内衬 POS_CARD_PB 16 → 22 ⇒ 卡片高 234 → 240 ⇒ 窗口高 410 → 416；
        左右两侧的标注也各往外挪 4 个设计单位（文字右缘 27 → 23、左缘 241 → 245），
        下方那一行列号整体下移 4（257..271 → 261..275）。
      tools/test-guide-layer.js 会盯着它和 host.cpp 的常量是否还对得上。
    所以本函数的输出只在「局面小窗的截图」上有意义 —— 它就是为了把
    「棋盘到底画出来没有 / 透明度到底是多少」变成可断言的数字。
    """
    H, W = a.shape[:2]

    def band(x0f, x1f, y0f, y1f):
        x0, x1 = int(W * x0f), int(W * x1f)
        y0, y1 = int(H * y0f), int(H * y1f)
        x0, x1 = max(0, x0), min(W, max(x1, x0 + 1))
        y0, y1 = max(0, y0), min(H, max(y1, y0 + 1))
        return a[y0:y1, x0:x1]

    hdr = band(30 / 268.0, 60 / 268.0, 2 / 416.0, 26 / 416.0)
    # 纯色块：一定要避开标题文字 —— 文字是白的，会把「按 R 通道反推 alpha」算歪。
    hdrFlat = band(90 / 268.0, 205 / 268.0, 4 / 416.0, 26 / 416.0)
    # 棋盘卡片带：**含**四周的坐标栏（它们也在卡片里）。坐标字用 cSub（浅色 132,138,150），
    # 刻意落在各条颜色判据的区间之外，不会污染 boardGrid / boardDeep 的计数。
    #   下界 278 = POS_BY(38) + POS_CARD_H(240) —— 卡片高了 6（下内衬 16 → 22），跟着走。
    board = band(12 / 268.0, 256 / 268.0, 38 / 416.0, 278 / 416.0)
    # 按钮行带：**必须正好**等于 POS_BTN_Y .. POS_BTN_Y+POS_BTN_H（378..404）。
    #   ⚠ 2026-09-19 差点栽在这：卡片下内衬 16 → 22 把代码卡片/按钮行整体往下推了 6，
    #     而这条带还停在 372..398 —— 于是它把按钮拦腰截断，渲染测试量出「按钮只有 20 设计
    #     单位高」（实际 26），看起来像「按钮变小了」的产品问题，其实是**量错了地方**。
    btnrow = band(22 / 268.0, 246 / 268.0, 378 / 416.0, 404 / 416.0)
    # 坐标栏（用户 2026-09-17：「棋盘的左右侧和下面写上坐标代码…不要与棋盘堆叠」）：
    #   左栏 x 12..25 / 右栏 x 241..255 / 下栏 x 21..248 y 261..275；
    #   棋盘线跨度是 x 29..239 / y 46..256（POS_OX/POS_GRID/POS_OY），与三条栏**完全不重叠**。
    #   于是「标注画在棋盘外」可以两向证明：栏里有标注色、且栏里没有网格色。
    #   ⚠ 2026-09-19：POS_COORD_GAP 2 → 6 之后三条栏**整体往外挪了 4 个设计单位** ——
    #     左栏的内边界从 28 收到 25（文字右缘现在贴 23，不再是 27）、右栏从 240 挪到 241
    #     （文字左缘现在贴 245）、下栏从 257..271 挪到 261..275。
    #     还按老区间量的话，左栏会漏掉一半字形（右半边落在栏外），
    #     「coordLeft > 20」这类断言就会开始飘。
    #   下栏的下界刻意从 261 起（不是 260）——261 正是「格线(256) + 缝(6) − 1」。
    gutL = band(12 / 268.0, 25 / 268.0, 39 / 416.0, 264 / 416.0)
    gutR = band(241 / 268.0, 255 / 268.0, 39 / 416.0, 264 / 416.0)
    gutB = band(21 / 268.0, 248 / 268.0, 261 / 416.0, 275 / 416.0)
    # 局面代码卡片里的文字行（x 20..248 y 288..356 = POS_CODE_Y(286)+2 起、每边去掉内衬）。
    #   「总代码」那一行只能靠**行数**来验：卡片里本来就是 3 行（抬头 + B: + W:），
    #   加了 A: 之后必须变成 4 行。这样「代码内容变了没有」就不再只靠源码断言。
    #   POS_CODE_Y 不再是 280（= 38 + 卡片 234 + 8），而是 286（卡片 240）——
    #   这一带跟着 286+8 起、286+76 止（旧值 288..356 只对得上旧版式）。
    code = band(20 / 268.0, 248 / 268.0, 294 / 416.0, 362 / 416.0)

    def mean3(b):
        return [int(v) for v in b.reshape(-1, 3).mean(axis=0)]

    R = board[:, :, 0]; G = board[:, :, 1]; B = board[:, :, 2]
    # 黑子：(17,17,17) —— 浅色模式下用 <70 就够（卡片是白的）；
    # 深色模式卡片刻意更亮一点（36,40,50），所以另给一个 <25 的严格量 boardDeep，
    # 它只认真正的黑子，浅深两种主题下都成立。
    dark = int((np.maximum(np.maximum(R, G), B) < 70).sum())
    deep = int((np.maximum(np.maximum(R, G), B) < 25).sum())
    # 浅色模式下的网格线 (176,184,198)：偏冷色（B > R）
    grid = int(((np.abs(R - 176) <= 34) & (np.abs(G - 184) <= 34) &
                (np.abs(B - 198) <= 34) & (B > R + 6)).sum())
    # 深色模式下的网格线 (96,104,126)：同样是偏冷的中间调
    mR = np.abs(R - 96) <= 26
    mG = np.abs(G - 104) <= 26
    mB = np.abs(B - 126) <= 26
    gridset = int((mR & mG & mB & ((B - R) > 10)).sum())
    uniq = int(len(np.unique(board.reshape(-1, 3), axis=0)))

    # 低透明度下的黑子：整窗 alpha 合成到**已知纯绿底**上时，
    #   黑子 (17,17,17) 按 0.60 合成 → (10,112,10)，max=112；
    #   而网格线 (176,184,198) → (106,212,119)，max=212；卡片白 → 255。
    #   所以「max(rgb) < 150」这一条只圈得住棋子，可以在 25% 档下证明棋盘还在。
    # （不能用 boardDeep<25：那是「本窗不透明」时才成立的口径。）
    def dark150(b):
        return int((np.maximum(np.maximum(b[:, :, 0], b[:, :, 1]), b[:, :, 2]) < 150).sum())
    dark150n = dark150(board)

    # 坐标标注像素：只认 cSub 的两套色（浅 132,138,150 / 深 150,158,175）±10。
    #   为什要收得这么窄：白棋子的描边是 (150,154,163)，宽区间会把它也算进来，
    #   于是「棋盘内部没有标注」这条断言会被棋子假性打破。±10 正好把描边排除在外
    #   （B=163 < 165），又保得住字形的实心笔画。
    def labelmask(b):
        r = b[:, :, 0]; gg = b[:, :, 1]; bb = b[:, :, 2]
        mL = (np.abs(r - 132) <= 10) & (np.abs(gg - 138) <= 10) & (np.abs(bb - 150) <= 10)
        mD = (np.abs(r - 150) <= 10) & (np.abs(gg - 158) <= 10) & (np.abs(bb - 175) <= 10)
        return mL | mD
    nCoordL = int(labelmask(gutL).sum())
    nCoordR = int(labelmask(gutR).sum())
    nCoordB = int(labelmask(gutB).sum())

    def gridmask(b):
        r = b[:, :, 0]; gg = b[:, :, 1]; bb = b[:, :, 2]
        gL = (np.abs(r - 176) <= 26) & (np.abs(gg - 184) <= 26) & (np.abs(bb - 198) <= 26) & (bb > r + 6)
        gD = (np.abs(r - 96) <= 26) & (np.abs(gg - 104) <= 26) & (np.abs(bb - 126) <= 26) & (bb > r + 10)
        return gL | gD

    # ---- ★ 棋盘线的**真实位置与尺寸**（换成设计单位）----
    # 「标注有没有压到棋盘」不能靠「坐标栏里有没有网格色」来判：坐标字的抗锯齿边缘从
    # cSub(132,138,150) 过渡到卡片白，中间正好会穿过网格色 (176,184,198) 的邻域，
    # 于是那一列会被误判成「网格伸进了坐标栏」（实测每栏两三百像素的假阳性）。
    # 直接量棋盘本身更硬：一列里网格色像素数远多于一个字形的十几像素（竖格线有整条边那么长），
    # 取「≥ 三成卡片高」的列即可挑出 15 条竖线；再按相邻列并组取中心，抗锯齿把线拆到两列也不怕。
    sxu = 268.0 / W          # 每个像素 = 多少设计单位
    syu = 416.0 / H          # 窗口高 416（2026-09-19：POS_H 410 → 416）
    cx0 = max(0, int(round(12 / sxu))); cx1 = min(W, int(round(256 / sxu)))
    cy0 = max(0, int(round(38 / syu))); cy1 = min(H, int(round(278 / syu)))
    card = a[cy0:cy1, cx0:cx1]
    gmark = gridmask(card)
    nh, nw = gmark.shape

    def groups(sel):
        """把相邻为真的下标并成组，返回每组的中心。"""
        out, run = [], []
        for i in sel:
            if run and i == run[-1] + 1:
                run.append(i)
            else:
                if run:
                    out.append(sum(run) / len(run))
                run = [i]
        if run:
            out.append(sum(run) / len(run))
        return out

    vcols = groups(list(np.nonzero(gmark.sum(axis=0) >= 0.30 * nh)[0]))
    hrows = groups(list(np.nonzero(gmark.sum(axis=1) >= 0.30 * nw)[0]))
    gridX0 = round((cx0 + vcols[0]) * sxu, 1) if vcols else None
    gridX1 = round((cx0 + vcols[-1]) * sxu, 1) if vcols else None
    gridY0 = round((cy0 + hrows[0]) * syu, 1) if hrows else None
    gridY1 = round((cy0 + hrows[-1]) * syu, 1) if hrows else None

    # 代码卡片里的文字行数：逐行统计「明显偏离卡片底色的像素」，再把连续行并成一条。
    #   浅色主题：卡片白 → 文字是暗的，判据 max(rgb)<140；
    #   深色主题：卡片暗 → 文字是亮的，判据 min(rgb)>170。
    #   两个都算出来，调用方按当前主题挑一条断言即可。
    def rows_of(mask2d):
        n = 0
        prev = False
        for v in mask2d:
            if v and not prev:
                n += 1
            prev = bool(v)
        return n
    cmax = np.maximum(np.maximum(code[:, :, 0], code[:, :, 1]), code[:, :, 2])
    cmin = np.minimum(np.minimum(code[:, :, 0], code[:, :, 1]), code[:, :, 2])
    nCodeRowsLight = rows_of((cmax < 140).sum(axis=1) >= 3)
    nCodeRowsDark = rows_of((cmin > 170).sum(axis=1) >= 3)

    # 主按钮：实心品牌蓝 #3b7dd8 —— 在按钮行里按颜色框出它的外接矩形，
    # 高度可直接换算成「设计单位高度」，用来验证「按键小一圈」。
    bR = btnrow[:, :, 0]; bG = btnrow[:, :, 1]; bB = btnrow[:, :, 2]
    blue = (bB - np.maximum(bR, bG) > 40) & (bR < 150) & (bB > 140)
    bbox = None
    if int(blue.sum()) > 40:
        ys, xs = np.nonzero(blue)
        bbox = {'x': int(xs.min()), 'y': int(ys.min()),
                'w': int(xs.max() - xs.min() + 1), 'h': int(ys.max() - ys.min() + 1),
                'px': int(blue.sum())}
    # 透明度反推：标题栏纯色块 = 品牌蓝 (59,125,216) 按本窗 alpha 合成到覆盖层纯绿上。
    #   实测 R = 59*a（绿底的 R 通道是 0），所以 a = R / 59 是**直接读数**，
    #   与桌面壁纸无关，也不受低透明度下颜色被稀释的影响。
    hf = mean3(hdrFlat)
    alphaFromHdr = round(hf[0] / 59.0, 3)
    return {
        'W': W, 'H': H,
        'hdr': mean3(hdr),
        'hdrFlat': hf,
        'alphaFromHdr': alphaFromHdr,
        'board': mean3(board),
        'boardUniq': uniq,
        'boardDark': dark,
        'boardDeep': deep,
        'boardDark150': dark150n,
        'boardGrid': grid,
        'boardGridDark': gridset,
        'coordLeft': nCoordL,
        'coordRight': nCoordR,
        'coordBottom': nCoordB,
        'gridVCount': len(vcols),
        'gridHCount': len(hrows),
        'gridX0': gridX0, 'gridX1': gridX1,
        'gridY0': gridY0, 'gridY1': gridY1,
        'codeRowsLight': nCodeRowsLight,
        'codeRowsDark': nCodeRowsDark,
        'btnRow': mean3(btnrow),
        'btnBlue': bbox,
        'btnBluePx': int(blue.sum()),
        'all': mean3(a),
    }


def main():
    mode = sys.argv[1]
    stats = '--stats' in sys.argv
    if mode == 'full':
        out = sys.argv[2]
        img = ImageGrab.grab(all_screens=True)
    elif mode == 'posinfo':
        x, y, w, h = (int(v) for v in sys.argv[2:6])
        pad = int(sys.argv[6])
        out = sys.argv[7]
        vx, vy = virtual_origin()
        full = ImageGrab.grab(all_screens=True)
        loc = locate_window(full, x, y, w, h, pad)
        if loc is None:
            print(json.dumps({'err': 'title bar not found', 'expect': [x, y, w, h]}))
            sys.exit(2)
        ax, ay = x + loc['dx'], y + loc['dy']
        box = (ax - vx, ay - vy, ax - vx + w, ay - vy + h)
        if box[0] < 0 or box[1] < 0 or box[2] > full.size[0] or box[3] > full.size[1]:
            print(json.dumps({'err': 'located out of range', 'box': box,
                              'captured': list(full.size)}))
            sys.exit(2)
        img = full.crop(box)
        img.save(out)
        st = posbands_stats(np.asarray(img.convert('RGB')).astype(np.float64))
        st['loc'] = {'x': ax, 'y': ay, 'dx': loc['dx'], 'dy': loc['dy'],
                     'spanX': loc['spanX'], 'spanY': loc['spanY']}
        print(json.dumps(st))
        return
    else:
        x, y, w, h = (int(v) for v in sys.argv[2:6])
        out = sys.argv[6]
        vx, vy = virtual_origin()
        full = ImageGrab.grab(all_screens=True)
        box = (x - vx, y - vy, x - vx + w, y - vy + h)
        if box[0] < 0 or box[1] < 0 or box[2] > full.size[0] or box[3] > full.size[1]:
            print(json.dumps({'err': 'crop out of range', 'box': box,
                              'captured': list(full.size), 'virtualOrigin': [vx, vy]}))
            sys.exit(2)
        img = full.crop(box)

    img.save(out)
    if mode == 'posbands':
        a = np.asarray(img.convert('RGB')).astype(np.float64)
        print(json.dumps(posbands_stats(a)))
        return
    if not stats:
        print(json.dumps({'W': img.size[0], 'H': img.size[1], 'out': out}))
        return

    a = np.asarray(img.convert('RGB')).astype(np.float64)
    H, W = a.shape[:2]
    x0, x1 = int(W * 0.10), int(W * 0.90)
    if x1 <= x0:
        x0, x1 = 0, W
    # 标题栏：最上面 5%（不透明的品牌蓝，用来证明「面板真的画出来了」）
    hdr = a[0:max(1, int(H * 0.05)), x0:x1].reshape(-1, 3).mean(axis=0)
    # 正文带：42%~58%（这里只有面板的半透明底，直接反映「透不透」）
    body = a[int(H * 0.42):int(H * 0.58), x0:x1].reshape(-1, 3).mean(axis=0)
    print(json.dumps({
        'W': W, 'H': H,
        'hdr': [int(v) for v in hdr],
        'body': [int(v) for v in body],
    }))


if __name__ == '__main__':
    main()
