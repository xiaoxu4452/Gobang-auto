# Vision recognize service.

"""本地 OpenCV 棋盘识别服务（lizzieyzy 方法内核）
POST /recognize  {image: <base64 png/jpg>, size: 15|19}
  -> {ok, geometry:{x0,y0,stepX,stepY,grid,source,confidence}, black:[..], white:[..], err?}
供 bookmarklet 内嵌使用：页面把棋盘图像(含CSS背景合成)发来，OpenCV 定位 15x15 网格并读子。
"""
import sys, io, base64, json, os, tempfile, msvcrt, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import cv2
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from gomoku_assistant import detector
from gomoku_assistant import adaptive
from gomoku_assistant.models import BoardGeometry

PORT = 8970

def _read_stones_robust(gray, xs, ys, bg, step):
    """连通域读子：交点窗口内最大连通域=棋子，域内主色判色（对棋子数字标注鲁棒）"""
    H, W = gray.shape
    board = np.zeros((len(ys), len(xs)), dtype=np.int8)
    rw = int(step * 0.56)
    for j in range(len(ys)):
        for i in range(len(xs)):
            cx, cy = int(round(xs[i])), int(round(ys[j]))
            x1p, y1p = cx - rw, cy - rw
            if x1p < 0 or y1p < 0 or x1p + 2*rw + 1 > W or y1p + 2*rw + 1 > H:
                continue
            patch = gray[y1p:y1p+2*rw+1, x1p:x1p+2*rw+1]
            win_area = patch.size
            dark_mask = (patch < bg - 25).astype(np.uint8)
            bright_mask = (patch > bg + 15).astype(np.uint8)
            def largest(mask):
                n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
                if n <= 1:
                    return 0
                return int(np.max(stats[1:, cv2.CC_STAT_AREA])) if n > 1 else 0
            ad = largest(dark_mask)
            ab = largest(bright_mask)
            thr = win_area * 0.22
            if ad > thr and ad > ab:
                board[j, i] = 1
            elif ab > thr and ab > ad:
                board[j, i] = 2
    return board

def _refine_lines(gray, lines, step, axis, W, H, polarity=-1.0):
    """网格线精修：在初定位线位置 ±0.30*step 内找「线感最强」的位置。

    polarity=-1 表示**暗线**（比底色暗，浅色棋盘；旧行为），+1 表示**亮线**（深色主题棋盘：
    底色深、网格线浅）。极性自适应后，深色主题站点也能精修到正确位置。

    评分用 **1px 窄条 + 沿垂直方向的中位数**，而不是「3px 宽条 + 均值」：
    均值会被穿过该列的棋子/标记（约占 6% 面积）带偏，3 轮迭代会一路走飞
    （实测深色主题下 84 → 20）；中位数只反映该列的主体颜色，对棋子完全免疫。
    """
    out = []
    half = max(2, int(step * 0.30))
    lo, hi = int(round(lines[0])) - int(step), int(round(lines[-1])) + int(step)
    for p in lines:
        p0 = int(round(p)); best = p0; best_score = -1e18
        for d in range(-half, half + 1):
            pos = p0 + d
            if pos < 0 or pos >= (W if axis == 0 else H):
                continue
            if axis == 0:
                seg = gray[max(0, lo):min(H, hi), pos]
            else:
                seg = gray[pos, max(0, lo):min(W, hi)]
            if not seg.size:
                continue
            score = float(polarity) * float(np.median(seg))
            if score > best_score:
                best_score = score; best = pos
        out.append(float(best))
    return np.array(out)

def _line_polarity(gray, lines, axis):
    """判定网格线相对底色的极性：+1=亮线（深色主题）/ -1=暗线（浅色棋盘）。

    判定方式：对每条线，取其**附近 ±3px 内偏离背景最远**的那一点（线只有 1~2px，
    初定位常有 ±2px 误差，直接采单列会采到背景 → 极性判反 → 精修每轮偏移 0.3 格、
    三轮累积整一格，整盘棋子串行错位；实测深色主题正是这样被读成「全部平移一格」）。
    """
    H, W = gray.shape
    step = float(np.median(np.diff(lines))) if len(lines) > 1 else 0.0
    d = max(4, int(step * 0.3))
    votes = []
    for p in lines[1:-1]:
        pos = int(round(float(p)))
        if pos - d < 0 or pos + d >= (W if axis == 0 else H):
            continue
        if axis == 0:
            off = (float(np.median(gray[:, pos - d])) + float(np.median(gray[:, pos + d]))) / 2.0
            prof = [float(np.median(gray[:, pos + k])) for k in range(-3, 4)]
        else:
            off = (float(np.median(gray[pos - d, :])) + float(np.median(gray[pos + d, :]))) / 2.0
            prof = [float(np.median(gray[pos + k, :])) for k in range(-3, 4)]
        devs = [v - off for v in prof]
        k = int(np.argmax([abs(v) for v in devs]))
        if abs(devs[k]) > 6.0:
            votes.append(1.0 if devs[k] > 0 else -1.0)
    if not votes:
        return -1.0
    return 1.0 if float(np.mean(votes)) > 0 else -1.0

def _grid_plausible(xs, ys) -> bool:
    """网格合理性校验：15 条线必须严格递增、步距均匀。

    投影法在「深底亮线」等极性相反的棋盘上会给出重复/忽宽忽窄的假网格
    （实测深色主题下 xs 出现 [..,322,322,..,633,633,..]），必须拦下来改走 Hough 兜底。
    """
    for arr in (xs, ys):
        if len(arr) < 2:
            return False
        d = np.diff(arr)
        if float(np.min(d)) <= 0.5 * float(np.median(d)):
            return False
        if float(np.std(d)) / max(float(np.mean(d)), 1e-6) > 0.25:
            return False
    return True

def _arbitrate(primary, secondary):
    """两层读子结果仲裁 → (board, picked)。

    科学化的“第二次意见”：
      * 两者一致 → 直接采信（picked='agree'）；
      * 自适应结果违反棋理不变量、而旧路径不违反 → 采信旧路径；
      * 自适应一个子都没读到、旧路径读到且不变量通过 → 保守采信旧路径（保既有站点兼容）；
      * 其余情况以自适应为准（它天然与底色/光照无关，是本轮故障的根治手段）。
    """
    if primary is None:
        return secondary, "legacy"
    if secondary is None:
        return primary, "adaptive"
    if np.array_equal(primary, secondary):
        return primary, "agree"
    inv_a, inv_b = adaptive.invariants(primary), adaptive.invariants(secondary)
    if inv_a["suspect"] and not inv_b["suspect"]:
        return secondary, "legacy"
    if inv_a["total"] == 0 and inv_b["total"] > 0 and not inv_b["suspect"]:
        return secondary, "legacy"
    return primary, "adaptive"

def _dark_detail_projection(gray, axis):
    """轴「暗细节」投影：与 detector._axis_projection 同式（float64 累加）。"""
    H, W = gray.shape[:2]
    sigma = max(2.0, min(H, W) / 120.0)
    blur = cv2.GaussianBlur(gray, (0, 0), sigmaX=sigma)
    detail = np.maximum(blur.astype(np.float32) - gray.astype(np.float32), 0)
    if axis == 0:
        return detail.mean(axis=0, dtype=np.float64)
    return detail.mean(axis=1, dtype=np.float64)

def _lattice_axis(proj):
    """单轴周期+相位：归一化自相关主周期（升序首个 ≥0.85*best，防 2 倍频），
    相位 = Σ proj[k*s+phase] 能量最大。返回 (s, phase, corr) 或 None。"""
    n = len(proj)
    if n < 48:
        return None
    x = proj - float(np.mean(proj))
    lo, hi = 8, max(9, n // 5)
    best_corr, best_lag = -2.0, -1
    corrs = {}
    for lag in range(lo, hi + 1):
        a, b = x[: n - lag], x[lag:]
        den = float(np.sqrt(np.sum(a * a) * np.sum(b * b)))
        c = float(np.sum(a * b) / den) if den > 1e-9 else -2.0
        corrs[lag] = c
        if c > best_corr:
            best_corr, best_lag = c, lag
    if best_lag < 0:
        return None
    pick = next((l for l in sorted(corrs) if corrs[l] >= 0.85 * best_corr), best_lag)
    s = pick
    if s < 8:
        return None
    best_e, phase = -1e18, 0
    for ph in range(s):
        e = float(np.sum(proj[ph:n:s]))
        if e > best_e:
            best_e, phase = e, ph
    return s, phase, best_corr

def _live_lines(proj, s, phase):
    """活线：k*s+phase 处 ±r 内投影峰 > base+0.6*spread。死线可能是被棋子压住
    的线 —— 活线只用于定 k 区间，区间内死线照样参与读子。"""
    n = len(proj)
    base = float(np.percentile(proj, 55))
    spread = max(float(np.percentile(proj, 95) - base), 0.5)
    r = max(2, int(s * 0.12))
    ks = []
    k = 0
    while True:
        p = k * s + phase
        if p - r >= n:
            break
        loL, hiL = max(0, p - r), min(n, p + r + 1)
        if hiL > loL and float(np.max(proj[loL:hiL])) > base + 0.6 * spread:
            ks.append(k)
        k += 1
    return ks

def _partial_grid_stones(img, gray, size):
    """★ 残盘晶格兜底（2026-09-21 用户样张）：整线定位失败（棋盘被裁边，图里可能
    只剩 14×13 条线，主路径强求 15 条线必然失败）时的防线。与 C++ 版
    PartialGridStones 同口径：自相关周期+相位 → 活线定 k 区间 → 方形晶格 →
    复用主路径读子（自适应 + 旧路径 → 仲裁）→ 包围盒居中贴进 size 路盘。
    命中返回 partial JSON，diag.method="partial_lattice"。"""
    try:
        H, W = gray.shape[:2]
        colp = _dark_detail_projection(gray, 0)
        rowp = _dark_detail_projection(gray, 1)
        rx = _lattice_axis(colp)
        ry = _lattice_axis(rowp)
        if not rx or not ry:
            return None
        sx, phx, cx = rx
        sy, phy, cy = ry
        if sx < 8 or sy < 8:
            return None
        if abs(sx - sy) > 0.25 * max(sx, sy):
            return None
        if cx < 0.30 or cy < 0.30:
            return None
        kxs = _live_lines(colp, int(sx), int(phx))
        kys = _live_lines(rowp, int(sy), int(phy))
        if len(kxs) < 6 or len(kys) < 6:
            return None
        nx = kxs[-1] - kxs[0] + 1
        ny = kys[-1] - kys[0] + 1
        if nx < 6 or ny < 6 or nx > size or ny > size:
            return None
        n = max(nx, ny)
        xs = [(kxs[0] + k) * sx + phx for k in range(n)]
        ys = [(kys[0] + k) * sy + phy for k in range(n)]
        step = (sx + sy) / 2.0
        x0i = max(0, int(xs[0]) + int(step * 2)); x1i = min(W, int(xs[-1]) - int(step * 2))
        y0i = max(0, int(ys[0]) + int(step * 2)); y1i = min(H, int(ys[-1]) - int(step * 2))
        bg = 200
        if x1i > x0i and y1i > y0i:
            region = gray[y0i:y1i, x0i:x1i]
            bg = int(np.argmax(np.bincount(region.ravel(), minlength=256)))
        geo = BoardGeometry(x_lines=np.array(xs, dtype=float), y_lines=np.array(ys, dtype=float),
                            confidence=0.5, source="partial_lattice")
        try:
            board_a, _conf, _diag = adaptive.read_stones_adaptive(img, geo)
        except Exception:
            board_a = None
        try:
            board_b, _ = detector.read_stones(img, geo, bg)
        except Exception:
            board_b = None
        board, _picked = _arbitrate(board_a, board_b)
        if board is None or board.shape != (n, n):
            return None
        board = np.where(board == detector.WHITE, 2, board).astype(np.int8)
        nb = int(np.sum(board == 1)); nw = int(np.sum(board == 2))
        idx = np.argwhere(board != 0)
        if len(idx) < 2:
            return None
        (jmin, imin), (jmax, imax) = idx.min(axis=0), idx.max(axis=0)
        if imax - imin + 1 > size or jmax - jmin + 1 > size:
            return None
        if abs(nb - nw) > 3:
            return None
        board_n = np.zeros((size, size), dtype=np.int8)
        offi = (size - (imax - imin + 1)) // 2 - imin
        offj = (size - (jmax - jmin + 1)) // 2 - jmin
        for j, i in idx:
            board_n[j + offj, i + offi] = board[j, i]
        blacks = np.argwhere(board_n == 1)
        whites = np.argwhere(board_n == 2)
        return {
            "ok": True,
            "size": size,
            "partial": True,
            "suspect": False,
            "diag": {"method": "partial_lattice"},
            "black": [{"x": int(b), "y": int(a)} for a, b in blacks],
            "white": [{"x": int(b), "y": int(a)} for a, b in whites],
        }
    except Exception:
        return None

def _board_crop_candidates(gray, max_candidates=3):
    """★ 大图内嵌小棋盘（2026-09-22 用户样张，参照国际通用 OpenCV 棋盘/文档定位法）：
    Canny + 膨胀连通 → 找「近似方形」的大轮廓（棋盘在页面/照片里总是一块近方形区域）
    → 包围矩形外扩 4% → 返回全分辨率坐标 [(x, y, w, h), …]，按面积从大到小，
    最多 max_candidates 个。主定位把整幅大图的 UI 纹理当网格、读出违反棋理的数量时
    （黑子应等于白子或白子+1），把候选区域裁出来重新定位读子。"""
    H, W = gray.shape[:2]
    scale = min(1.0, 800.0 / max(H, W))
    small = cv2.resize(gray, (int(round(W * scale)), int(round(H * scale))),
                       interpolation=cv2.INTER_AREA) if scale < 1.0 else gray
    sh, sw = small.shape[:2]
    edges = cv2.Canny(small, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    total = float(sh * sw)
    cands = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w < 48 or h < 48:
            continue
        ar = w / float(h)
        if ar < 0.5 or ar > 2.0:
            continue
        area = w * float(h)
        if area < 0.06 * total or area > 0.97 * total:
            continue
        cands.append((area, x, y, w, h))
    cands.sort(reverse=True)
    out = []
    for _area, x, y, w, h in cands[:max_candidates]:
        mx, my = int(w * 0.04), int(h * 0.04)
        x0 = max(0, int((x - mx) / scale)); y0 = max(0, int((y - my) / scale))
        x1 = min(W, int((x + w + mx) / scale)); y1 = min(H, int((y + h + my) / scale))
        if x1 - x0 >= 120 and y1 - y0 >= 120:
            out.append((x0, y0, x1 - x0, y1 - y0))
    return out

def _partial_stones_fallback(gray, size=15):
    """残棋子找圆兜底（与 C++ PartialStonesFallback 同口径，2026-09-22 对齐）：
    HoughCircles 找候选圆 → 圆心小窗均值 vs 全图众数背景分黑/白 →
    最近邻中位距离 = 格距 → 以最靠左上的子为锚取整格坐标（残差 >0.38 格丢弃）
    → 包围盒居中贴进 size 路盘。|黑-白| > 3 视为没认出来。"""
    try:
        H, W = gray.shape[:2]
        mn = float(min(W, H))
        if mn < 160:
            return None
        circles = cv2.HoughCircles(gray, cv2.HOUGH_GRADIENT, 1.5, mn / 45.0,
                                   param1=110, param2=0.72,
                                   minRadius=int(mn / 50.0), maxRadius=int(mn / 10.0))
        if circles is None or len(circles[0]) < 2:
            return None
        hist = np.bincount(gray.ravel(), minlength=256)
        bg = int(np.argmax(hist[1:]) + 1)
        stones = []
        for cx, cy, rr in circles[0][:200]:
            cx, cy, rr = float(cx), float(cy), float(rr)
            r0 = max(1, int(rr * 0.5))
            x1p, y1p = int(cx) - r0, int(cy) - r0
            if x1p < 0 or y1p < 0 or x1p + 2 * r0 + 1 > W or y1p + 2 * r0 + 1 > H:
                continue
            m = float(np.mean(gray[y1p:y1p + 2 * r0 + 1, x1p:x1p + 2 * r0 + 1]))
            color = 0
            if m < bg - 34:
                color = 1
            elif m > bg + 26:
                color = 2
            if color:
                stones.append((cx, cy, color))
        if len(stones) < 2:
            return None
        nn = []
        for i, (ax, ay, _) in enumerate(stones):
            best = min((ax - bx) ** 2 + (ay - by) ** 2
                       for k, (bx, by, _) in enumerate(stones) if k != i)
            nn.append(best ** 0.5)
        med = float(np.median(nn))
        nn2 = sorted(d for d in nn if med * 0.6 < d < med * 1.6)
        if not nn2:
            return None
        s = nn2[len(nn2) // 2]
        if not s > 8:
            return None
        anchor = min(range(len(stones)), key=lambda i: stones[i][0] + stones[i][1])
        ax, ay = stones[anchor][0], stones[anchor][1]
        board = np.zeros((15, 15), dtype=np.int8)
        nb = nw = 0
        for px, py, color in stones:
            fi, fj = (px - ax) / s, (py - ay) / s
            i, j = int(round(fi)), int(round(fj))
            if abs(fi - i) > 0.38 or abs(fj - j) > 0.38:
                continue
            if 0 <= j < 15 and 0 <= i < 15 and board[j, i] == 0:
                board[j, i] = color
                if color == 1:
                    nb += 1
                else:
                    nw += 1
        idx = np.argwhere(board != 0)
        if len(idx) < 2 or nb + nw < 2:
            return None
        (jmin, imin), (jmax, imax) = idx.min(axis=0), idx.max(axis=0)
        if imax - imin + 1 > size or jmax - jmin + 1 > size:
            return None
        if abs(nb - nw) > 3:
            return None
        board_n = np.zeros((size, size), dtype=np.int8)
        offi = (size - (imax - imin + 1)) // 2 - imin
        offj = (size - (jmax - jmin + 1)) // 2 - jmin
        for j, i in idx:
            board_n[j + offj, i + offi] = board[j, i]
        blacks = np.argwhere(board_n == 1)
        whites = np.argwhere(board_n == 2)
        return {
            "ok": True,
            "size": size,
            "partial": True,
            "suspect": False,
            "diag": {"method": "partial"},
            "black": [{"x": int(b), "y": int(a)} for a, b in blacks],
            "white": [{"x": int(b), "y": int(a)} for a, b in whites],
        }
    except Exception:
        return None

def _otsu_read_stones(gray, xs_i, ys_i, step):
    """★ 单图自分类读子（2026-09-22，参照皮卡鱼/开源棋盘识别「逐点特征 + 无监督分类」）：
    每个交点取「盘心均值 − 环带中位」的有符号对比度，对全图对比度分布做
    **multi-Otsu 三分类**（暗类=黑子 / 中间类=空点 / 亮类=白子）—— 阈值由本张图
    自己的分布决定，不依赖手调常数，满盘密局、黑盘黑子等形态上反而最稳。
    返回引擎约定盘面（1=黑 / -1=白 / 0=空）；只作兜底层，结果必须再过棋理不变量。"""
    try:
        H, W = gray.shape[:2]
        n = min(len(xs_i), len(ys_i))
        if n < 5 or not step > 4:
            return None
        rd = max(2, int(step * 0.45))
        r_in = max(3, int(step * 0.60))
        r_out = max(4, int(step * 0.95))
        yy, xx = np.mgrid[-rd:rd + 1, -rd:rd + 1]
        disc = (xx * xx + yy * yy) <= rd * rd
        full = int(disc.sum())
        disc_off = np.argwhere(disc) - rd                       
        ys0, xs0 = np.mgrid[-r_out:r_out + 1, -r_out:r_out + 1]
        d2o = xs0 * xs0 + ys0 * ys0
        ring_idx = np.argwhere((d2o >= r_in * r_in) & (d2o <= r_out * r_out))
        if len(ring_idx) > 512:
            ring_idx = ring_idx[::len(ring_idx) // 512 + 1]
        cellc = np.zeros((n, n), dtype=float)
        okm = np.zeros((n, n), dtype=bool)
        allv = []
        for j in range(n):
            for i in range(n):
                cx, cy = int(round(xs_i[i])), int(round(ys_i[j]))
                dpx = cx + disc_off[:, 1]; dpy = cy + disc_off[:, 0]
                vin = (dpx >= 0) & (dpx < W) & (dpy >= 0) & (dpy < H)
                if int(vin.sum()) < full / 2:
                    continue
                dm = float(gray[dpy[vin], dpx[vin]].mean())
                rpx = cx + ring_idx[:, 1]; rpy = cy + ring_idx[:, 0]
                rin = (rpx >= 0) & (rpx < W) & (rpy >= 0) & (rpy < H)
                if int(rin.sum()) < 16:
                    continue
                bgv = float(np.median(gray[rpy[rin], rpx[rin]]))
                c = bgv - dm
                cellc[j, i] = c
                okm[j, i] = True
                allv.append(c)
        if len(allv) < n * n * 0.4:
            return None
        v = np.sort(np.array(allv, dtype=float))
        m = len(v)
        pre = np.concatenate([[0.0], np.cumsum(v)])
        mt = pre[-1] / m
        cuts = np.where(np.diff(v) > 1e-9)[0] + 1
        best_var, t1, t2 = -1.0, 0.0, 0.0
        for ai in range(len(cuts)):
            a = int(cuts[ai])
            for bi in range(ai + 1, len(cuts)):
                b = int(cuts[bi])
                w0, w1, w2 = a, b - a, m - b
                m0 = pre[a] / w0; m1 = (pre[b] - pre[a]) / w1; m2 = (pre[-1] - pre[b]) / w2
                var = w0 * (m0 - mt) ** 2 + w1 * (m1 - mt) ** 2 + w2 * (m2 - mt) ** 2
                if var > best_var:
                    best_var = var
                    t1 = (v[a - 1] + v[a]) / 2.0
                    t2 = (v[b - 1] + v[b]) / 2.0
        if best_var <= 0:
            return None
        board = np.zeros((n, n), dtype=np.int8)
        board[okm & (cellc > t2)] = detector.BLACK
        board[okm & (cellc < t1)] = detector.WHITE
        return board
    except Exception:
        return None

def _recognize_core(img, gray, size: int = 15) -> dict:
    """单次「定位 + 读子」全流程（供 recognize 主调用与棋盘区域裁剪重试共用）。"""
    H, W = gray.shape

    geo_err = None
    xs = ys = None
    source, confidence = "auto", 0.0
    try:
        geo1 = detector.locate_board(img, line_count=size)
        xs = np.array(geo1.x_lines, dtype=float)
        ys = np.array(geo1.y_lines, dtype=float)
        source, confidence = geo1.source, float(geo1.confidence)
    except Exception as e:
        geo_err = f"locate: {type(e).__name__}: {e}"
    
    hough_alt = None
    if xs is None or not _grid_plausible(xs, ys) or confidence < 0.45:
        try:
            hough_alt = adaptive.locate_grid_hough(gray, size)
        except Exception:
            hough_alt = None
        if hough_alt and hough_alt[2] < 0.15:
            hough_score = min(0.95, 1.0 - hough_alt[2] * 4.0)
            if xs is None or not _grid_plausible(xs, ys) or hough_score > confidence:
                xs, ys = np.array(hough_alt[0], dtype=float), np.array(hough_alt[1], dtype=float)
                source, confidence = "hough", hough_score
    if xs is None:
        
        try:
            _sigma = max(2.0, min(gray.shape) / 120.0)
            _blur = cv2.GaussianBlur(gray, (0, 0), sigmaX=_sigma)
            _detail = np.abs(_blur.astype(np.float32) - gray.astype(np.float32))
            _hp = np.clip(255.0 - _detail * 3.0, 0, 255).astype(np.uint8)
            geo_hp = detector.locate_board(cv2.cvtColor(_hp, cv2.COLOR_GRAY2RGB), size)
            xs = np.array(geo_hp.x_lines, dtype=float)
            ys = np.array(geo_hp.y_lines, dtype=float)
            source, confidence = "hp", float(geo_hp.confidence)
        except Exception:
            pass
    if xs is None:
        
        p = _partial_grid_stones(img, gray, size)
        if p:
            return p
        
        p = _partial_stones_fallback(gray, size)
        if p:
            return p
        return {"ok": False, "err": geo_err or "locate failed"}
    sx = float(np.median(np.diff(xs))); sy = float(np.median(np.diff(ys)))
    xs0, ys0, step0 = float(xs[0]), float(ys[0]), (sx + sy) / 2.0   
    
    pol_x = _line_polarity(gray, xs, 0)
    pol_y = _line_polarity(gray, ys, 1)
    for _ in range(3):
        nx = _refine_lines(gray, xs, sx, 0, W, H, pol_x)
        ny = _refine_lines(gray, ys, sy, 1, W, H, pol_y)
        
        if (not _grid_plausible(nx, ny)
                or abs(nx[0] - xs0) > step0 * 0.35 or abs(ny[0] - ys0) > step0 * 0.35):
            break
        xs, ys = nx, ny
        sx = float(np.median(np.diff(xs))); sy = float(np.median(np.diff(ys)))
    step = (sx + sy) / 2

    xs_i = np.round(xs).astype(int); ys_i = np.round(ys).astype(int)
    x0i = max(0, int(xs_i[0]) + int(step * 2)); x1i = min(W, int(xs_i[-1]) - int(step * 2))
    y0i = max(0, int(ys_i[0]) + int(step * 2)); y1i = min(H, int(ys_i[-1]) - int(step * 2))
    region = gray[y0i:y1i, x0i:x1i]
    bg = int(np.argmax(np.bincount(region.ravel(), minlength=256))) if region.size else 200

    geo_final = BoardGeometry(x_lines=xs.astype(float), y_lines=ys.astype(float),
                              confidence=confidence, source=source)

    try:
        board_a, _conf, diag = adaptive.read_stones_adaptive(img, geo_final)
    except Exception as e:
        board_a, diag = None, {"method": "adaptive", "err": repr(e)}
    try:
        board_b, _ = detector.read_stones(img, geo_final, bg)
    except Exception as e:
        board_b, diag["legacy_err"] = None, repr(e)
    board, diag["picked"] = _arbitrate(board_a, board_b)
    if board is None:
        return {"ok": False, "err": diag.get("err") or "read failed"}
    diag.update(adaptive.invariants(board))     
    
    if diag.get("suspect"):
        ob = _otsu_read_stones(gray, xs_i, ys_i, step)
        if ob is not None:
            inv2 = adaptive.invariants(ob)
            if not inv2.get("suspect") and inv2.get("total", 0) > 0:
                board = ob
                diag.update(inv2)
                diag["method"] = "otsu"
    board = np.where(board == detector.WHITE, 2, board)   

    blacks = np.argwhere(board == 1)
    whites = np.argwhere(board == 2)
    return {
        "ok": True,
        "size": size,
        "suspect": bool(diag.get("suspect")),
        "diag": diag,
        "geometry": {
            "x0": int(xs_i[0]), "y0": int(ys_i[0]),
            "stepX": round(float(sx), 2), "stepY": round(float(sy), 2),
            "xs": xs_i.tolist(), "ys": ys_i.tolist(),
            "source": source, "confidence": float(confidence),
            "bg": bg,
        },
        "black": [{"x": int(b), "y": int(a)} for a, b in blacks],
        "white": [{"x": int(b), "y": int(a)} for a, b in whites],
    }

def recognize(image_b64: str, size: int = 15) -> dict:
    """recognize 主入口：核心流程 + **棋理仲裁重试链**（2026-09-22 用户要求）。

    核心流程读出的局面若违反棋理不变量（suspect：黑白差过大 / 落子占比过高，
    正常对局黑子数应等于白子或白子+1），按可信度递减依次重试，取第一个
    「不违反棋理」的结果：
      1) ★ 自动吸附棋盘（与桌面版五子棋助手整屏扫描同源）：
         screen_board.find_board_rects 在大图里找「横竖等距线族真交叉」的棋盘矩形，
         逐个裁出来重新走核心流程 —— 大图内嵌小棋盘（手机照片 / 网页截图）的主修法；
      2) 标准 OpenCV 文档定位法：Canny + 轮廓找近似方形大区域（棋盘总是一块近方形）；
      3) 残盘兜底：晶格（自相关周期）→ 找圆（HoughCircles）。
    全部失败则原样返回核心结果（带 suspect 提示，页面会说「识别不稳定」）。
    """
    raw = base64.b64decode(image_b64)
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    img = np.asarray(pil)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    res = _recognize_core(img, gray, size)
    if not (res.get("ok") and res.get("suspect")):
        return res

    H, W = gray.shape[:2]

    def try_crop(x0, y0, x1, y1, method):
        x0 = max(0, int(x0)); y0 = max(0, int(y0))
        x1 = min(W, int(x1)); y1 = min(H, int(y1))
        if x1 - x0 < 120 or y1 - y0 < 120:
            return None
        crop = np.ascontiguousarray(img[y0:y1, x0:x1])
        sub = _recognize_core(crop, cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), size)
        if sub.get("ok") and not sub.get("suspect"):
            sub.setdefault("diag", {})["method"] = method
            sub["diag"]["crop_rect"] = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
            return sub
        return None

    try:
        from gomoku_assistant import screen_board
        for cand in screen_board.find_board_rects(gray, line_count=size, topn=3):
            rx0, ry0, rx1, ry1 = cand["rect"]
            pad = float(cand.get("step") or 20) * 0.5
            sub = try_crop(rx0 - pad, ry0 - pad, rx1 + pad, ry1 + pad, "snap_rect")
            if sub:
                return sub
    except Exception:
        pass

    for (x0, y0, w, h) in _board_crop_candidates(gray):
        sub = try_crop(x0, y0, x0 + w, y0 + h, "crop_quad")
        if sub:
            return sub

    p = _partial_grid_stones(img, gray, size)
    if p:
        return p
    p = _partial_stones_fallback(gray, size)
    if p:
        return p
    return res

def recognize_wulin(geo: dict, win: dict, size: int = 15) -> dict:
    """五林（renjuworld / Cocos WebGL）适配：服务端截屏，按前端校准几何（页面 CSS 坐标）
    换算屏幕坐标后直接读子。绕开 WebGL canvas 无法 drawImage 的问题——屏幕截图是 WebGL
    渲染后的真实画面。棋盘几何来自前端手动调节一次后的缓存，几何固定 → 无 Y 轴抖动。
    """
    from PIL import ImageGrab
    try:
        pil = ImageGrab.grab()
    except Exception as e:
        return {"ok": False, "err": "grab: %s: %s" % (type(e).__name__, e)}
    img = np.asarray(pil.convert("RGB"))
    gh, gw = img.shape[:2]
    
    iw = float(win.get("innerWidth") or gw)
    ih = float(win.get("innerHeight") or gh)
    scale_x = (gw / iw) if iw > 100 else 1.0
    scale_y = (gh / ih) if ih > 100 else scale_x
    sx = float(win.get("screenX") or 0)
    sy = float(win.get("screenY") or 0)
    tb = float(win.get("topBorder") or 0)          
    
    x0 = (float(geo["x0"]) + sx + 8.0) * scale_x
    y0 = (float(geo["y0"]) + sy + max(0.0, tb - 8.0)) * scale_y
    step = float(geo.get("stepX") or geo.get("step") or 50) * scale_x
    n = int(geo.get("grid") or 15)
    xs = np.array([x0 + i * step for i in range(n)], dtype=float)
    ys = np.array([y0 + i * step for i in range(n)], dtype=float)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    H, W = gray.shape
    
    x0i = max(0, int(xs[0]) - int(step * 0.5)); x1i = min(W, int(xs[-1]) + int(step * 0.5))
    y0i = max(0, int(ys[0]) - int(step * 0.5)); y1i = min(H, int(ys[-1]) + int(step * 0.5))
    region = gray[y0i:y1i, x0i:x1i]
    bg = int(np.argmax(np.bincount(region.ravel(), minlength=256))) if region.size else 200
    gf = BoardGeometry(x_lines=xs, y_lines=ys, confidence=1.0, source="wulin")
    try:
        board_a, _c, _d = adaptive.read_stones_adaptive(img, gf)
    except Exception:
        board_a = None
    try:
        board_b, _ = detector.read_stones(img, gf, bg)
    except Exception:
        board_b = None
    board, _picked = _arbitrate(board_a, board_b)
    if board is None:
        board = _read_stones_robust(gray, xs.tolist(), ys.tolist(), bg, step)
    board = np.where(board == detector.WHITE, 2, board)
    blacks = np.argwhere(board == 1)
    whites = np.argwhere(board == 2)
    return {
        "ok": True,
        "size": size,
        "black": [{"x": int(b), "y": int(a)} for a, b in blacks],
        "white": [{"x": int(b), "y": int(a)} for a, b in whites],
    }

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/recognize":
            self.send_error(404); return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n))
            size = int(body.get("size", 15))
            mode = str(body.get("mode") or "image")
            if mode == "wulin":
                res = recognize_wulin(body.get("geo") or {}, body.get("win") or {}, size)
            else:
                res = recognize(body.get("image", ""), size)
            payload = json.dumps(res).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            payload = json.dumps({"ok": False, "err": repr(e)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_error(404)

def main():
    
    lock_path = os.path.join(tempfile.gettempdir(), "gomoku_recognize_8970.lock")
    try:
        lock_f = open(lock_path, "w")
        msvcrt.locking(lock_f.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        print("another recognize server instance holds the lock - exit.")
        return
    
    try:
        urllib.request.urlopen("http://127.0.0.1:%d/health" % PORT, timeout=1)
        print("port %d already serving - recognize server already running, exit." % PORT)
        return
    except Exception:
        pass
    print(f"recognize server on 127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

if __name__ == "__main__":
    main()
