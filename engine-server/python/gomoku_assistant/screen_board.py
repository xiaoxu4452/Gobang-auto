# Assistant module - screen_board.

"""整屏五子棋棋盘定位与读子（桌面覆盖层应用的核心）。

与网页注入（bookmarklet）路线的区别：这里**没有 DOM 可用**，输入是**整屏截图**，
棋盘只是屏幕上的一小块（周围有浏览器 UI、桌面、其它窗口）。因此第一步必须是
「在整屏里把棋盘找出来」，之后才能复用既有的自适应读子逻辑。

思路（全部走 OpenCV 官方手段）：
  1. 抓屏（GDI，多显示器 + DPI 感知）。
  2. Canny(自动阈值) + HoughLinesP 取线段 → 按水平/垂直聚类成「线簇」。
  3. 在两类线簇里各找**近似等间距的线族**（棋盘网格的本质特征）：
     枚举起点对定公差，再向后贪心扩展；保留成员数 ≥8 且总长度最长的族。
  4. 横竖族配对成候选棋盘（间距需一致、面积合理）→ 取最优候选。
  5. 把候选区域裁出来，交给既有的精确网格定位（detector/adaptive）拿到 15×15 线坐标。
  6. 复用 adaptive.read_stones_adaptive 读子 —— 浅底/深底/空心描边等画法全部继承。

为什么用「等间距线族」而不是模板匹配/角点检测：
  棋盘的本质是两组**等间距长直线**，这个特征对缩放、底色、棋子、主题几乎免疫；
  而模板匹配对缩放敏感、角点检测会在文字/图标上炸出大量误检。
"""

from __future__ import annotations

import ctypes
import os
import sys

import cv2
import numpy as np

from . import adaptive
from .engine import BLACK, EMPTY, WHITE

IS_WIN = os.name == "nt"

def set_dpi_aware() -> None:
    """让抓屏与窗口坐标都用**物理像素**（否则系统缩放 125%/150% 时坐标会错位）。

    覆盖层窗口（Electron）同样会设置 DPI awareness，两侧必须一致，否则框会偏移。
    """
    if not IS_WIN:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

def capture_screen():
    """抓全屏（含所有显示器）：返回 (RGB ndarray, (ox, oy))，ox/oy 为虚拟屏原点偏移。

    多显示器时虚拟屏左上角可能为负（副屏在主屏左侧/上方），后续所有坐标都要减掉该偏移。
    """
    from PIL import ImageGrab
    set_dpi_aware()
    img = ImageGrab.grab(all_screens=True)
    rgb = np.asarray(img.convert("RGB"))
    
    try:
        ox, oy = int(img.info["bbox"][0]), int(img.info["bbox"][1])
    except Exception:
        ox, oy = 0, 0
    return rgb, (ox, oy)

def _cluster_segments(vals, tol):
    """把一维坐标（水平线的 y / 垂直线的 x）聚成簇：返回 [(均值, 成员数)]。"""
    if not vals:
        return []
    vals = np.sort(np.asarray(vals, dtype=np.float64))
    out = []
    cur = [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= tol:
            cur.append(v)
        else:
            out.append(cur)
            cur = [v]
    out.append(cur)
    return [(float(np.mean(c)), len(c)) for c in out]

def canny_screen(gray, ratio=0.40):
    """屏幕内容的自适应 Canny：阈值由**梯度幅值的 Otsu 二值化**决定。

    两个坑都踩过：
      · 沿用 adaptive.auto_canny 的「灰度中位数」→ 中位数就是底色（浅底棋盘 ~234），
        下阈值被抬到 160，而棋盘线对比度仅几十灰阶 → 边缘全被吞掉。
      · 改用「梯度幅值的固定分位」→ 屏幕大面是平坦底色，88 分位仍落在平坦区（≈0），
        阈值算出来 <8 → **一条边都没有**。
    正确做法：在梯度幅值上跑 Otsu，让算法自己分出「平坦区 / 真实边缘」两类，
    与底色深浅、边缘占比都无关。归一化用 99.5 分位，避免个别极值把尺度拉爆。
    """
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.abs(gx) + np.abs(gy)
    mx = float(np.percentile(mag, 99.5))
    if mx <= 1e-6:                                  
        return np.zeros(gray.shape, dtype=np.uint8)
    m8 = np.clip(mag / mx * 255.0, 0, 255).astype(np.uint8)
    t, _ = cv2.threshold(m8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    hi = float(t) / 255.0 * mx
    if hi < 4.0:
        hi = max(8.0, mx * 0.35)
    lo = max(4.0, hi * ratio)
    return cv2.Canny(gray, lo, hi)

def _collect_lines(gray, min_len, max_gap=6, thresh=80):
    """Canny + HoughLinesP → 水平/垂直线簇（带总长度，用于筛掉短碎线）。"""
    edges = canny_screen(gray)
    lines = cv2.HoughLinesP(edges, 1.0, np.pi / 180.0, threshold=thresh,
                            minLineLength=int(min_len), maxLineGap=int(max_gap))
    if lines is None:
        return [], []
    h_vals, v_vals = [], []
    h_len, v_len = [], []
    h_ext, v_ext = [], []          
    for s in np.asarray(lines, dtype=np.float64).reshape(-1, 4):
        x1, y1, x2, y2 = s
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        ln = float(np.hypot(dx, dy))
        if dx >= dy:                       
            h_vals.append((y1 + y2) / 2.0)
            h_len.append(ln)
            h_ext.append((min(x1, x2), max(x1, x2)))
        else:                              
            v_vals.append((x1 + x2) / 2.0)
            v_len.append(ln)
            v_ext.append((min(y1, y2), max(y1, y2)))
    return (_weighted_clusters(h_vals, h_len, h_ext, 3.0),
            _weighted_clusters(v_vals, v_len, v_ext, 3.0))

def _weighted_clusters(vals, lens, exts, tol):
    """聚簇时保留每簇的**线段总长度**（等权重会让一排短碎线盖过真正的棋盘长线），
    以及该簇在另一轴上的覆盖区间 [lo, hi]。"""
    if not vals:
        return []
    order = np.argsort(vals)
    vals = np.asarray(vals, dtype=np.float64)[order]
    lens = np.asarray(lens, dtype=np.float64)[order]
    exts = [exts[i] for i in order]
    out = []
    cur_v, cur_l, cur_e = [vals[0]], [lens[0]], [exts[0]]
    for v, l, e in zip(vals[1:], lens[1:], exts[1:]):
        if v - cur_v[-1] <= tol:
            cur_v.append(v)
            cur_l.append(l)
            cur_e.append(e)
        else:
            out.append((float(np.mean(cur_v)), float(np.sum(cur_l)),
                        min(x[0] for x in cur_e), max(x[1] for x in cur_e)))
            cur_v, cur_l, cur_e = [v], [l], [e]
    out.append((float(np.mean(cur_v)), float(np.sum(cur_l)),
                min(x[0] for x in cur_e), max(x[1] for x in cur_e)))
    return out

def _find_arithmetic_families(clusters, min_count=8, max_step=260.0, topk=6):
    """在一维线簇里找「近似等间距」的若干线族（按得分取前 topk）。

    棋盘网格 = 一组等间距平行线。做法：枚举前两个成员定公差 d，再向后贪心匹配
    （容差随 d 放大），收集所有候选族后按得分排序返回。

    ⚠️ 必须返回**多个候选**而不是只留最优：网页上的文字行也是等间距平行线，
    只取「最强族」会拿到文字行（间距 22px），再与另一方向的无关竖线配对时
    间距对不上 → 整个棋盘判定失败。留下多个候选，靠后续横竖交叉配对来甄别。
    """
    fams = _arithmetic_candidates(clusters, min_count, max_step)
    
    out = []
    for f in fams:
        dup = False
        for g in out:
            inter = len(set(np.round(f["pos"], 1)) & set(np.round(g["pos"], 1)))
            if inter >= 0.7 * min(len(f["pos"]), len(g["pos"])):
                dup = True
                break
        if not dup:
            out.append(f)
        if len(out) >= topk:
            break
    return out

def _find_arithmetic_family(clusters, min_count=8, max_step=260.0):
    """兼容旧调用：返回得分最高的一个等距线族。"""
    fams = _find_arithmetic_families(clusters, min_count, max_step, topk=1)
    return fams[0] if fams else None

def _arithmetic_candidates(clusters, min_count=8, max_step=260.0):
    if len(clusters) < min_count:
        return []
    
    lens = np.asarray([c[1] for c in clusters], dtype=np.float64)
    thr_len = float(lens.max()) * 0.15
    cand = [c for c, l in zip(clusters, lens) if l >= thr_len]
    if len(cand) < min_count:
        cand = clusters
    pos = np.asarray([c[0] for c in cand], dtype=np.float64)
    ln = np.asarray([c[1] for c in cand], dtype=np.float64)

    def ext_of(c):
        return (float(c[2]), float(c[3])) if len(c) >= 4 else (0.0, 0.0)

    cands = []
    n = len(pos)
    for i in range(n):
        for j in range(i + 1, min(n, i + 40)):
            d = (pos[j] - pos[i]) / float(j - i)
            if d < 8.0 or d > max_step:
                continue
            tol = max(2.5, d * 0.06)
            seq = [pos[i], pos[j]]
            tot = [ln[i], ln[j]]
            cand_idx = [cand[i], cand[j]]
            expect = pos[j] + d
            k = j + 1
            while k < n:
                diff = pos[k] - expect
                if abs(diff) <= tol:
                    seq.append(pos[k])
                    tot.append(ln[k])
                    cand_idx.append(cand[k])
                    expect = pos[k] + d
                elif diff > tol:
                    
                    m = int(round(diff / d))
                    if m >= 1 and abs(pos[k] - (expect + m * d)) <= tol:
                        seq.append(pos[k])
                        tot.append(ln[k])
                        cand_idx.append(cand[k])
                        expect = pos[k] + d
                    else:
                        break
                k += 1
            if len(seq) >= min_count:
                score = len(seq) * float(np.mean(tot))
                los = [ext_of(c)[0] for c in cand_idx]
                his = [ext_of(c)[1] for c in cand_idx]
                cands.append({
                    "pos": np.asarray(seq, dtype=np.float64),
                    "len": float(np.mean(tot)),
                    "step": float(d),
                    "score": float(score),
                    "lo": float(min(los)) if los else 0.0,
                    "hi": float(max(his)) if his else 0.0,
                })
    cands.sort(key=lambda c: -c["score"])
    return cands

def find_board_rects(gray, line_count=15, min_lines=8, scales=(1.0, 0.6),
                     len_ratios=(0.05, 0.10), topn=1):
    """同 find_board_rect，但返回**前 topn 个**候选（按 score 降序）。

    存在的理由：用户可能在桌面同时开着好几个五子棋窗口（或多个标签页），
    此时只取第一名会让「到底识别了哪一个」变得不可预期 —— 棋盘框会在几个窗口之间
    来回跳。拿到前几名后，上层就能判断「屏幕上不止一个棋盘」并提示用户只留一个。
    """
    H, W = gray.shape[:2]
    short = float(min(W, H))
    cands = []
    for sc in scales:
        if sc == 1.0:
            g = gray
        else:
            g = cv2.resize(gray, (max(64, int(W * sc)), max(64, int(H * sc))),
                           interpolation=cv2.INTER_AREA)
        gw, gh = g.shape[1], g.shape[0]
        gshort = float(min(gw, gh))
        max_step = gshort * 0.25
        for lr in len_ratios:
            min_len = max(20.0, gshort * lr)
            hc, vc = _collect_lines(g, min_len)
            if not hc or not vc:
                continue
            for hy in _find_arithmetic_families(hc, min_count=min_lines, max_step=max_step):
                for vx in _find_arithmetic_families(vc, min_count=min_lines, max_step=max_step):
                    cand = _pair_families(hy, vx, gw, gh, sc)
                    if cand is None:
                        continue
                    cands.append(cand)
    if not cands:
        return []
    cands.sort(key=lambda c: c["score"], reverse=True)
    return cands[:max(1, int(topn))]

def _rect_overlap_ratio(a, b):
    """两个候选矩形的交叠面积 / 较小矩形面积（0..1）。
    用于判定「两个候选其实是同一个棋盘」—— 同一块棋盘常被多个尺度/线长档位各命中一次。"""
    ax0, ay0, ax1, ay1 = a["rect"]
    bx0, by0, bx1, by1 = b["rect"]
    ix = min(ax1, bx1) - max(ax0, bx0)
    iy = min(ay1, by1) - max(ay0, by0)
    if ix <= 0 or iy <= 0:
        return 0.0
    inter = float(ix) * float(iy)
    smaller = min(float(ax1 - ax0) * float(ay1 - ay0),
                  float(bx1 - bx0) * float(by1 - by0))
    return inter / smaller if smaller > 1e-6 else 0.0

def find_board_rect(gray, line_count=15, min_lines=8, scales=(1.0, 0.6),
                    len_ratios=(0.05, 0.10)):
    """在整幅（屏幕）图里找棋盘：返回 dict(rect, step, vx, hy, score, size) 或 None。

    **分辨率/尺寸无关**（2K / 3K / 4K、16:9 / 4:3、小窗口 / 全屏都走同一套）：
      · 一切阈值都取**相对量**：最小线长 = 短边 × 比例、面积占比、格距上限 = 短边 × 0.25。
      · 多尺度搜索（1.0 / 0.6）：大棋盘在降采样图上更快更稳，小棋盘在原尺度上才检得出。
      · 多档最小线长（短边 ×5% / ×10%）：棋盘在窗口里可能只占一小块，线并不长。
      · 横竖族必须**真实交叉**：网页文字行也是等距平行线，光靠「等距」会把它们当成棋盘。
    评分做了尺度归一化，因此不同尺度/不同线长档位的候选可以直接横向比较。
    """
    top = find_board_rects(gray, line_count=line_count, min_lines=min_lines,
                           scales=scales, len_ratios=len_ratios, topn=1)
    return top[0] if top else None

def _subsample(fam, m):
    """把线族按每 m 个取一个（等价于格距 ×m）。

    用途：网页文字行（间距 ~16px）常与棋盘线混进同一个等距族，使该族公差被算小一半；
    此时只要「每隔一个取一条」就还原出真正的棋盘格距，从而与另一方向的族配对成功。
    """
    if m <= 1:
        return fam
    pos = fam["pos"][::m]
    if len(pos) < 6:
        return None
    out = dict(fam)
    out["pos"] = pos
    out["step"] = float(fam["step"]) * m
    out["len"] = float(fam["len"])
    return out

def _pair_families(hy, vx, gw, gh, sc):
    """把「水平等距族 + 垂直等距族」配成一个棋盘候选：要求格距一致且两组线真交叉。

    格距不必一开始就相等：允许 2~4 倍的整数关系并对间距较小的一方做子采样
    （见 _subsample），否则「文字行混进棋盘线族」会让棋盘永远配不上。
    """
    dx0, dy0 = float(vx["step"]), float(hy["step"])
    if dx0 <= 0 or dy0 <= 0:
        return None
    ratio = dx0 / dy0
    best = None
    for who in ("none", "h", "v"):
        hy2, vx2 = hy, vx
        if who == "h":                       
            m = int(round(dy0 / dx0)) if dy0 > dx0 else int(round(ratio))
            if not (2 <= m <= 4):
                continue
            hy2 = _subsample(hy, m)
        elif who == "v":
            m = int(round(dx0 / dy0)) if dx0 > dy0 else int(round(1.0 / ratio))
            if not (2 <= m <= 4):
                continue
            vx2 = _subsample(vx, m)
        if hy2 is None or vx2 is None:
            continue
        cand = _pair_once(hy2, vx2, gw, gh, sc)
        if cand is not None and (best is None or cand["score"] > best["score"]):
            best = cand
    return best

def _pair_once(hy, vx, gw, gh, sc):
    dx, dy = float(vx["step"]), float(hy["step"])
    if dx <= 0 or dy <= 0:
        return None
    if abs(dx - dy) / max(dx, dy) > 0.12:          
        return None
    x0, x1 = float(vx["pos"].min()), float(vx["pos"].max())
    y0, y1 = float(hy["pos"].min()), float(hy["pos"].max())
    
    h_lo, h_hi = float(hy.get("lo", 0.0)), float(hy.get("hi", 0.0))
    v_lo, v_hi = float(vx.get("lo", 0.0)), float(vx.get("hi", 0.0))
    if h_hi > h_lo and v_hi > v_lo:
        inter_x = min(x1, h_hi) - max(x0, h_lo)
        inter_y = min(y1, v_hi) - max(y0, v_lo)
        if inter_x < 0.35 * min(x1 - x0, h_hi - h_lo):
            return None
        if inter_y < 0.35 * min(y1 - y0, v_hi - v_lo):
            return None
    area = max(1.0, (x1 - x0) * (y1 - y0))
    if area < 0.008 * gw * gh or area > 0.98 * gw * gh:
        return None
    gshort = float(min(gw, gh))
    
    n = len(vx["pos"]) + len(hy["pos"])
    rel_len = (vx["len"] + hy["len"]) * 0.5 / max(1.0, gshort)
    score = n * 100.0 + rel_len * 60.0
    inv = 1.0 / sc
    return {
        "rect": (x0 * inv, y0 * inv, x1 * inv, y1 * inv),
        "step": (dx + dy) * 0.5 * inv,
        "vx": vx["pos"] * inv,
        "hy": hy["pos"] * inv,
        "score": float(score),
        "size": int(round(max(len(vx["pos"]), len(hy["pos"])))),
        "scale": float(sc),
    }

def refine_grid(rgb, cand, size=15):
    """把粗定位的候选区域裁出来，用既有逻辑精确定位 size×size 的网格线。

    返回 geometry（x_lines/y_lines/spacing）或 None。
    """
    H, W = rgb.shape[:2]
    x0, y0, x1, y1 = cand["rect"]
    step = cand["step"]
    pad = step * 1.5
    ax0 = max(0, int(x0 - pad)); ay0 = max(0, int(y0 - pad))
    ax1 = min(W, int(x1 + pad)); ay1 = min(H, int(y1 + pad))
    crop = rgb[ay0:ay1, ax0:ax1]
    if crop.size == 0:
        return None
    g = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)

    xs = ys = None
    spacing = float(cand["step"])
    source = "?"
    
    try:
        from . import detector
        bg = detector.locate_board(crop, size)
        if bg is not None and len(bg.x_lines) == size and len(bg.y_lines) == size:
            xs, ys = np.asarray(bg.x_lines, dtype=np.float64), np.asarray(bg.y_lines, dtype=np.float64)
            spacing = float(bg.spacing)
            source = "projection"
    except Exception:
        pass
    
    if xs is None:
        try:
            r = adaptive.locate_grid_hough(g, size)
            if r is not None:
                hx, hy, _res = r
                if hx is not None and len(hx) == size and len(hy) == size:
                    xs, ys = np.asarray(hx, dtype=np.float64), np.asarray(hy, dtype=np.float64)
                    spacing = float(np.mean(np.diff(xs))) if size > 1 else spacing
                    source = "hough"
        except Exception:
            pass
    if xs is None:
        return None
    return {
        "x_lines": [float(v) + ax0 for v in xs],   
        "y_lines": [float(v) + ay0 for v in ys],
        "spacing": spacing,
        "source": source,
        "origin": (ax0, ay0),
    }

def _search_near(gray, hint, size=15, expand=0.35):
    """在上一帧棋盘位置附近搜索（跟踪模式）：只在局部跑找线，比全屏快一个量级。

    expand: 相对棋盘尺寸向外扩张的比例（容忍窗口被拖动/缩放一点）。
    """
    H, W = gray.shape[:2]
    try:
        hx, hy = float(hint.get("x", 0)), float(hint.get("y", 0))
        hw, hh = float(hint.get("w", 0)), float(hint.get("h", 0))
    except Exception:
        return None
    if hw <= 0 or hh <= 0:
        return None
    ex, ey = hw * expand, hh * expand
    x0 = max(0, int(hx - ex)); y0 = max(0, int(hy - ey))
    x1 = min(W, int(hx + hw + ex)); y1 = min(H, int(hy + hh + ey))
    if x1 - x0 < 40 or y1 - y0 < 40:
        return None
    sub = gray[y0:y1, x0:x1]
    cand = find_board_rect(sub, line_count=size)
    if cand is None:
        return None
    
    rx0, ry0, rx1, ry1 = cand["rect"]
    cand = dict(cand)
    cand["rect"] = (rx0 + x0, ry0 + y0, rx1 + x0, ry1 + y0)
    cand["vx"] = cand["vx"] + x0
    cand["hy"] = cand["hy"] + y0
    return cand

def crop_board(rgb, x_lines, y_lines, spacing, pad_ratio=1.3):
    """裁出棋盘区域（留出 1.3 格边距，保证边角棋子的取样窗口完整）。

    返回 (裁剪图, (ox, oy))：后续坐标需减去该偏移。裁剪后棋盘占画面主体，
    背景估计/阈值才落在**棋盘底色**上，而不是桌面或页面底色。
    """
    H, W = rgb.shape[:2]
    pad = float(spacing) * pad_ratio
    x0 = max(0, int(float(x_lines[0]) - pad))
    x1 = min(W, int(float(x_lines[-1]) + pad) + 1)
    y0 = max(0, int(float(y_lines[0]) - pad))
    y1 = min(H, int(float(y_lines[-1]) + pad) + 1)
    return rgb[y0:y1, x0:x1], (x0, y0)

class Geo:
    """给 read_stones_adaptive 用的极简 geometry（它只读 size/spacing/x_lines/y_lines）。"""
    def __init__(self, size, spacing, x_lines, y_lines):
        self.size = size
        self.spacing = spacing
        self.x_lines = x_lines
        self.y_lines = y_lines

def _mask_excluded(rgb, exclude, off=(0, 0)):
    """把「本软件自己的窗口」在截图里抹成一块纯色。

    为什么要抹：整屏识别会连我们的浮动面板 / 局面窗口一起拍进去。面板里有密集的
    等距横线（参数行、曲线网格），它们的间距与棋盘的某一族非常接近，极易被当成
    第二个棋盘，或者把真正的棋盘定位拽歪。用户说得直白：那是软件系统里的窗口，
    不是别的五子棋软件，不该参与识别。

    exclude: [{x, y, w, h}] —— **虚拟屏幕坐标**（Win32 GetWindowRect 的口径）。
    截图数组下标 = 屏幕坐标 - off（多屏时虚拟屏原点可能为负），所以这里先减 off。
    """
    if not exclude:
        return rgb
    
    out = rgb if getattr(rgb, "flags", None) is not None and rgb.flags.writeable \
        else np.array(rgb)
    try:
        sample = np.asarray(out[::16, ::16].reshape(-1, 3), dtype=np.float64)
        fill = np.median(sample, axis=0) if len(sample) else np.array([128.0] * 3)
    except Exception:
        fill = np.array([128.0] * 3)
    ox, oy = off
    for r in exclude:
        try:
            x = int(r.get("x", 0)) - int(ox)
            y = int(r.get("y", 0)) - int(oy)
            w = int(r.get("w", 0))
            h = int(r.get("h", 0))
        except Exception:
            continue
        if w <= 0 or h <= 0:
            continue
        H, W = out.shape[:2]
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        if x1 <= x0 or y1 <= y0:
            continue
        out[y0:y1, x0:x1] = fill.astype(out.dtype)
    return out

def _count_distinct_boards(tops, score_ratio=0.55, overlap=0.5):
    """数一数候选里到底有几个**互相不重叠**的棋盘。

    同一块棋盘常被多尺度 / 多线长档位各命中一次（矩形高度重叠），
    那必须算作一个；只有彼此重叠很少、且分数都不低的才算「第二个棋盘」。
    """
    if not tops:
        return 0
    best_score = float(tops[0]["score"]) or 1.0
    picked = []
    for c in tops:
        if float(c["score"]) < best_score * score_ratio:
            continue
        if any(_rect_overlap_ratio(c, p) >= overlap for p in picked):
            continue
        picked.append(c)
    return len(picked)

def scan_once(rgb=None, size=15, hint=None, exclude=None, probe=False, region=None):
    """完整扫一屏：抓屏 → 找棋盘 → 精确定位 → 读子。

    hint: 上一帧的棋盘矩形 {x,y,w,h}；给了就先在它附近搜（快很多，用于持续跟踪），
          搜不到再退回全屏。首次调用没有 hint，走全屏。
    exclude: [{x,y,w,h}] 本软件自己的窗口矩形（虚拟屏幕坐标），会先被抹成纯色再识别。
    probe: True 时忽略 hint、做一次全量搜索并统计屏幕上的棋盘个数（multi_board）。
    region: 用户拖拽圈定的识别区域 [x,y,w,h]（虚拟屏幕物理像素）。给了就**只在这块矩形里**
          认盘（先裁屏再跑同一套检测），不再全屏自动找盘 —— 桌面端「手动调节」要的效果。
          输出几何仍按虚拟屏幕坐标（已把矩形原点加回去），覆盖层可直接画框。
    返回 dict(ok, geometry, black, white, suspect, multi_board, diag)；
    未找到棋盘时 ok=True 且 found=False。
    """
    if rgb is None:
        rgb, off = capture_screen()
    else:
        off = (0, 0)
    
    if region:
        
        ox_i = int(round(off[0]))
        oy_i = int(round(off[1]))
        rx0, ry0, rw0, rh0 = [int(round(float(v))) for v in region[:4]]
        rx, ry = rx0 - ox_i, ry0 - oy_i
        h, w = rgb.shape[:2]
        rx = max(0, min(rx, w - 1))
        ry = max(0, min(ry, h - 1))
        rw = max(1, min(rw0, w - rx))
        rh = max(1, min(rh0, h - ry))
        sub = rgb[ry:ry + rh, rx:rx + rw].copy()
        
        sub = _mask_excluded(sub, exclude, (rx0, ry0))
        res = _scan_sub(sub, size=size, hint=None, exclude=None, probe=probe, off=(0, 0))
        if res.get("found"):
            br = res.get("board_rect")
            if br:
                br["x"] = float(br["x"]) + rx
                br["y"] = float(br["y"]) + ry
            gl = res.get("geometry")
            if gl:
                gl["x_lines"] = [float(v) + rx for v in gl["x_lines"]]
                gl["y_lines"] = [float(v) + ry for v in gl["y_lines"]]
            if "offset" in res and isinstance(res["offset"], (tuple, list)):
                res["offset"] = (res["offset"][0] + rx, res["offset"][1] + ry)
        return res
    return _scan_sub(rgb, size=size, hint=hint, exclude=exclude, probe=probe, off=off)

def _scan_sub(rgb, size=15, hint=None, exclude=None, probe=False, off=(0, 0)):
    """scan_once 的核心：在给定 rgb（已是待识别画面，已含 off 偏移基准）上找盘读子。
    region 模式复用它时，rgb 是裁好的子图、off=(0,0)，几何由调用方加回矩形原点。"""
    masked = _mask_excluded(rgb, exclude, off)
    gray = cv2.cvtColor(masked, cv2.COLOR_RGB2GRAY)

    cand = None
    multi = 0
    if probe:
        
        tops = find_board_rects(gray, line_count=size, topn=6)
        if tops:
            cand = tops[0]
            multi = _count_distinct_boards(tops)
    if cand is None and hint:
        cand = _search_near(gray, hint, size)
    if cand is None:
        cand = find_board_rect(gray, line_count=size)
    if cand is None:
        return {"ok": True, "found": False, "offset": off, "multi_board": 0,
                "diag": {"reason": "no-board"}}
    geo = refine_grid(masked, cand, size)
    if geo is None:
        return {"ok": True, "found": False, "offset": off, "multi_board": multi,
                "diag": {"reason": "no-grid", "cand": {k: v for k, v in cand.items()
                                                       if k not in ("vx", "hy")}}}
    spacing = float(geo.get("spacing") or cand["step"])
    
    crop, (ox, oy) = crop_board(masked, geo["x_lines"], geo["y_lines"], spacing)
    g = Geo(size, spacing, [float(v) - ox for v in geo["x_lines"]],
            [float(v) - oy for v in geo["y_lines"]])
    board, conf, diag = adaptive.read_stones_adaptive(crop, g)
    ys, xs = np.where(board == BLACK)
    black = [{"x": int(x), "y": int(y)} for y, x in zip(ys, xs)]
    ys, xs = np.where(board == WHITE)
    white = [{"x": int(x), "y": int(y)} for y, x in zip(ys, xs)]
    
    xl, yl = geo["x_lines"], geo["y_lines"]
    return {
        "ok": True,
        "found": True,
        "offset": off,
        "board_rect": {
            "x": float(xl[0]), "y": float(yl[0]),
            "w": float(xl[-1] - xl[0]), "h": float(yl[-1] - yl[0]),
        },
        "geometry": {"x_lines": [float(v) for v in xl],
                     "y_lines": [float(v) for v in yl],
                     "spacing": float(geo.get("spacing") or cand["step"]),
                     "size": size},
        "black": black,
        "white": white,
        "suspect": bool(diag.get("suspect")),
        "multi_board": multi,
        "diag": diag,
    }
