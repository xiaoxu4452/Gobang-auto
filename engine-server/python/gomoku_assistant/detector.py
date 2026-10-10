# Assistant module - detector.

from __future__ import annotations

from dataclasses import replace

import cv2
import numpy as np

from .engine import BLACK, EMPTY, WHITE
from .models import BoardGeometry

class DetectionError(RuntimeError):
    pass

def _profile_peaks(prof: np.ndarray) -> list[int]:
    """投影剖面的局部极大峰位（相对阈值，容忍「全宽 UI 线比棋盘格线高」的情形）。"""
    m = float(prof.max())
    if m < 8:
        return []
    thr = max(8.0, 0.12 * m)
    pos: list[int] = []
    for i in range(1, len(prof) - 1):
        if prof[i] >= thr and prof[i] >= prof[i - 1] and prof[i] >= prof[i + 1]:
            pos.append(i)
    return pos

def _cluster_1d(positions: list[int], tol: float = 3.0) -> list[float]:
    """把相邻 ≤tol 的峰位聚成一簇，取均值作中心。"""
    if not positions:
        return []
    centers: list[float] = []
    run = [float(positions[0])]
    for v in positions[1:]:
        if v - run[-1] <= tol:
            run.append(float(v))
        else:
            centers.append(sum(run) / len(run))
            run = [float(v)]
    centers.append(sum(run) / len(run))
    return centers

def _axis_lattice(prof: np.ndarray, line_count: int):
    """在一条 1D 投影里找「等距 line_count 条线」的晶格（RANSAC 思路）。

    为什么要有它：renjuworld（五林）这类站点把棋盘直接画在与棋盘同色系的木纹
    页面背景上 —— 颜色分支必然连成一片，网格分支也被背景纹理桥接成超大轮廓。
    但棋盘的格线在行/列投影上仍是**全场唯一重复 14 次的等距结构**：
      1. 峰位聚类（格线 + UI 线 + 木纹噪声都变成中心点）；
      2. 相邻峰距做直方图，取计数最多的间距（真格距出现 ≥10 次，噪声随机分散）；
      3. 拿候选间距做相位对齐（任一峰都试作第 k 条线），
         ≥line_count-3 条线附近 ±tol 内真有峰才算数，按（内点数，幅度）取最优。
    返回 (first, last, step, inliers) 或 None。"""
    n = len(prof)
    if n < line_count * 4:
        return None
    centers = _cluster_1d(_profile_peaks(prof))
    if len(centers) < line_count:
        return None
    centers_arr = np.asarray(centers, dtype=float)
    
    hist: dict[int, int] = {}
    max_step = n / max(4.0, line_count / 2.0)
    for i in range(len(centers) - 1):
        for j in range(i + 1, len(centers)):
            d = centers_arr[j] - centers_arr[i]
            if 8.0 <= d <= max_step:
                key = int(round(d))
                hist[key] = hist.get(key, 0) + 1
    if not hist:
        return None
    best = None
    best_score = None
    for base in sorted(hist, key=lambda k: hist[k], reverse=True)[:3]:
        near = [d for d in hist if abs(d - base) <= 1]
        weight = sum(hist[d] for d in near)
        step = sum(d * hist[d] for d in near) / weight
        if step < 6:
            continue
        t = max(2.0, step * 0.12)
        span = (line_count - 1) * step
        bestk = None
        for c in centers:
            for k in range(line_count):
                first = c - k * step
                if first < 0 or first + span > n - 1:
                    continue
                idx = first + np.arange(line_count) * step
                j = np.searchsorted(centers_arr, idx)
                j = np.clip(j, 1, len(centers) - 1)
                choose = np.where(
                    np.abs(centers_arr[j] - idx) < np.abs(centers_arr[j - 1] - idx), j, j - 1
                )
                dist = np.abs(centers_arr[choose] - idx)
                inl = int((dist <= t).sum())
                if inl < line_count - 3:
                    continue
                amps = np.median(prof[np.clip(np.rint(idx).astype(int), 0, n - 1)])
                score = (inl, float(amps))
                if bestk is None or score > bestk[0]:
                    bestk = (score, idx, inl)
        if bestk is not None and (best_score is None or bestk[0] > best_score):
            best = (bestk[1], step, bestk[2])
            best_score = bestk[0]
    if best is None:
        return None
    idx, step, inl = best
    return float(idx[0]), float(idx[-1]), float(step), inl

def _axis_lattice_strip(prof: np.ndarray, line_count: int, step_hint: float):
    """条带内「步长×相位」穷举（``_lattice_rectangles`` 两轴互救专用）。

    为什么不做峰位检测：峰位正是被污染的源头 —— 棋子密集时棋子的环形边缘/落影
    在投影里造出一堆假峰，把 ``_axis_lattice`` 的等距拟合带偏（屏江棋院现场：
    y 轴被步长 43.9 的伪晶格劫持，真格距 52.8）。这里直接拿平滑后的**原始二值
    剖面**，在 step_hint±8% × 全相位的网格上找「line_count 条采样线平均幅度」
    的最大值 —— 格线、棋子（都落在格线上）共同托高真晶格的幅度，噪声则随机
    分散。返回 (first, last, step, line_count) 或 None。
    """
    n = len(prof)
    if n < line_count * 4 or step_hint < 6:
        return None
    prof_s = np.convolve(prof, np.ones(5) / 5.0, mode="same")
    best: tuple[float, float] | None = None
    best_score = -1.0
    for step in np.linspace(step_hint * 0.92, step_hint * 1.08, 33):
        span = (line_count - 1) * step
        if span > n - 1:
            continue
        for first in np.arange(0.0, n - 1 - span, 0.5):
            vals = np.interp(first + np.arange(line_count) * step, np.arange(n), prof_s)
            score = float(vals.mean())
            if score > best_score:
                best_score = score
                best = (float(first), float(step))
    if best is None:
        return None
    first, step = best
    return first, first + (line_count - 1) * step, step, line_count

def _lattice_rectangles(image_rgb: np.ndarray, line_count: int) -> list[tuple[int, int, int, int]]:
    """「投影晶格」候选（2026-09-19）：见 ``_axis_lattice`` 的注释。

    与网格分支共用同一套线掩码；横竖两个方向都找到晶格才生成候选，
    且准方形校验交给 ``locate_board`` 的 ``_grid_metrics``（grid_aspect）兜底。
    """
    height, width = image_rgb.shape[:2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    scale = min(1.0, 1400.0 / max(height, width))
    if scale < 1:
        small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        small = gray
    block = max(15, int(round(min(small.shape[:2]) / 45)) | 1)
    binary = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 5
    )
    line_len = max(12, int(min(small.shape[:2]) / 65))
    hor = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((1, line_len), np.uint8))
    ver = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((line_len, 1), np.uint8))
    ry = _axis_lattice(hor.sum(axis=1).astype(np.float32) / 255.0, line_count)
    rx = _axis_lattice(ver.sum(axis=0).astype(np.float32) / 255.0, line_count)

    def _steps_disagree(a, b) -> bool:
        if a is None or b is None:
            return False
        return abs(a[2] - b[2]) / max(a[2], b[2]) > 0.12

    if _steps_disagree(ry, rx):
        if rx is not None and (ry is None or rx[3] >= ry[3]):
            off = max(0, int(rx[0]) - 2)
            strip = binary[:, off:int(rx[1]) + 1].sum(axis=1).astype(np.float32) / 255.0
            t = _axis_lattice_strip(strip, line_count, rx[2])
            
            if t is not None:
                ry = t
        elif ry is not None:
            off = max(0, int(ry[0]) - 2)
            strip = binary[off:int(ry[1]) + 1, :].sum(axis=0).astype(np.float32) / 255.0
            t = _axis_lattice_strip(strip, line_count, ry[2])
            
            if t is not None:
                rx = t
    elif rx is None and ry is not None:
        off = max(0, int(ry[0]) - 2)
        strip = binary[off:int(ry[1]) + 1, :].sum(axis=0).astype(np.float32) / 255.0
        t = _axis_lattice_strip(strip, line_count, ry[2])
        if t is not None:
            rx = t          
    elif ry is None and rx is not None:
        off = max(0, int(rx[0]) - 2)
        strip = binary[:, off:int(rx[1]) + 1].sum(axis=1).astype(np.float32) / 255.0
        t = _axis_lattice_strip(strip, line_count, rx[2])
        if t is not None:
            ry = t          
    if ry is None or rx is None:
        return []
    y0, y1, step_y, inl_y = ry
    x0, x1, step_x, inl_x = rx
    
    span_x = x1 - x0
    span_y = y1 - y0
    if min(span_x, span_y) <= 0 or min(span_x, span_y) / max(span_x, span_y) < 0.65:
        return []
    margin = int(round(max(step_x, step_y) * 0.8)) + 6
    x0f = int(max(0, (x0 - margin) / scale))
    y0f = int(max(0, (y0 - margin) / scale))
    x1f = int(min(width - 1, (x1 + margin) / scale))
    y1f = int(min(height - 1, (y1 + margin) / scale))
    if x1f - x0f < 60 or y1f - y0f < 60:
        return []
    return [(x0f, y0f, x1f - x0f + 1, y1f - y0f + 1)]

def _dedupe_rectangles(rectangles: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    result: list[tuple[int, int, int, int]] = []
    for rect in sorted(rectangles, key=lambda r: r[2] * r[3], reverse=True):
        x, y, w, h = rect
        keep = True
        for ox, oy, ow, oh in result:
            ix1, iy1 = max(x, ox), max(y, oy)
            ix2, iy2 = min(x + w, ox + ow), min(y + h, oy + oh)
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            union = w * h + ow * oh - inter
            if union and inter / union > 0.82:
                keep = False
                break
        if keep:
            result.append(rect)
    return result[:20]

def _candidate_rectangles(image_rgb: np.ndarray, line_count: int = 15) -> list[tuple[int, int, int, int]]:
    height, width = image_rgb.shape[:2]
    min_area = height * width * 0.012
    bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    scale = min(1.0, 1400.0 / max(height, width))
    if scale < 1:
        small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        small = gray

    block = max(15, int(round(min(small.shape[:2]) / 45)) | 1)
    binary = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 5
    )
    line_len = max(12, int(min(small.shape[:2]) / 65))
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((1, line_len), np.uint8))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((line_len, 1), np.uint8))
    grid = cv2.dilate(cv2.bitwise_or(horizontal, vertical), np.ones((5, 5), np.uint8), iterations=1)

    rectangles: list[tuple[int, int, int, int]] = []
    contours, _ = cv2.findContours(grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        sx, sy, sw, sh = cv2.boundingRect(contour)
        x, y, w, h = (int(round(v / scale)) for v in (sx, sy, sw, sh))
        if w * h < min_area or not 0.68 <= w / max(h, 1) <= 1.47:
            continue
        pad = int(round(max(w, h) * 0.07))
        rectangles.append((max(0, x - pad), max(0, y - pad), min(width - x + pad, w + 2 * pad), min(height - y + pad, h + 2 * pad)))

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    warm = cv2.inRange(hsv, np.array([4, 20, 45]), np.array([48, 255, 255]))
    kernel_size = max(9, int(min(height, width) / 90))
    warm = cv2.morphologyEx(warm, cv2.MORPH_CLOSE, np.ones((kernel_size, kernel_size), np.uint8))
    contours, _ = cv2.findContours(warm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        fill = cv2.contourArea(contour) / max(w * h, 1)
        if w * h >= min_area and fill > 0.55 and 0.68 <= w / max(h, 1) <= 1.47:
            rectangles.append((x, y, w, h))

    bright_warm = cv2.inRange(hsv, np.array([4, 20, 135]), np.array([48, 255, 255]))
    surface_kernel = max(5, int(min(height, width) / 180))
    bright_warm = cv2.morphologyEx(
        bright_warm,
        cv2.MORPH_CLOSE,
        np.ones((surface_kernel, surface_kernel), np.uint8),
    )
    bright_warm = cv2.morphologyEx(
        bright_warm, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)
    )
    contours, _ = cv2.findContours(bright_warm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        fill = cv2.contourArea(contour) / max(w * h, 1)
        if w * h >= min_area and fill > 0.72 and 0.68 <= w / max(h, 1) <= 1.47:
            rectangles.append((x, y, w, h))

    light_surf = cv2.inRange(hsv, np.array([10, 22, 200]), np.array([32, 100, 255]))
    ls_kernel = max(5, int(min(height, width) / 200))
    light_surf = cv2.morphologyEx(light_surf, cv2.MORPH_CLOSE, np.ones((ls_kernel, ls_kernel), np.uint8))
    contours, _ = cv2.findContours(light_surf, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        fill = cv2.contourArea(contour) / max(w * h, 1)
        if w * h >= min_area and fill > 0.70 and 0.68 <= w / max(h, 1) <= 1.47:
            rectangles.append((x, y, w, h))

    try:
        rectangles.extend(_lattice_rectangles(image_rgb, line_count))
    except Exception:
        pass                   

    return _dedupe_rectangles(rectangles)

def _axis_projection(gray: np.ndarray, axis: int) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (0, 0), sigmaX=max(2.0, min(gray.shape) / 120))
    dark_detail = np.maximum(blur.astype(np.float32) - gray.astype(np.float32), 0)
    
    if axis == 0:
        return np.mean(dark_detail, axis=0, dtype=np.float64)
    return np.mean(dark_detail, axis=1, dtype=np.float64)

def _snap_to_peaks(
    projection: np.ndarray, positions: np.ndarray, radius: int
) -> tuple[np.ndarray, np.ndarray] | tuple[None, None]:
    """把每个理论位置吸附到 ±radius 内的投影最大值处。"""
    adjusted: list[int] = []
    peaks: list[float] = []
    length = len(projection)
    for position in positions:
        center = int(round(float(position)))
        lo, hi = max(0, center - radius), min(length, center + radius + 1)
        if hi <= lo:
            return None, None
        local = projection[lo:hi]
        offset = int(np.argmax(local))
        
        m = offset
        pos = float(lo + m)
        if 0 < m < len(local) - 1:
            a, b, c = float(local[m - 1]), float(local[m]), float(local[m + 1])
            den = a - 2.0 * b + c
            if den < -1e-12:
                delta = 0.5 * (a - c) / den
                if -0.5 <= delta <= 0.5:
                    pos += delta
        adjusted.append(pos)
        peaks.append(float(local[offset]))
    return np.asarray(adjusted, dtype=np.float64), np.asarray(peaks, dtype=np.float64)

def _spacing_cv(positions: np.ndarray) -> float:
    spacings = np.diff(positions)
    mean = float(np.mean(spacings)) if len(spacings) else 0.0
    if mean <= 0:
        return 1e9
    return float(np.std(spacings) / mean)

def _reanchor_regular(
    projection: np.ndarray,
    positions: np.ndarray,
    radius: int,
    baseline: float,
    spread: float,
) -> np.ndarray:
    """★ 防「外框线把点阵拽偏一格」。

    棋盘四条**最外层边框线**并不在 15 路格线上，而是落在真格线外侧约
    0.87 格处（实测：1.0 倍率下列轴外框在 −0.86 / +0.82 格，行轴在 −0.86 格）。
    因为 ``_fit_axis`` 只奖励「峰值强度 + 吸附规整度」，而多带进来一条外框线
    几乎不影响 15 条线里 _median_ 的峰值强度，所以偶尔会选中
    「外框当第 0 行 + 真格线 1..14」这种整条偏移一格的解 —— 表现就是
    **盘面颜色全对、但每个子的行列整体差 1**（用户可见：局面小棋盘整盘错位）。

    真棋盘 15 条线是**严格等距**的（实测间距 CV≈0.004~0.006），而掺进外框线后
    间距立刻变得不齐（CV≈0.033，差 6 倍）。于是：在「原位 / 平移 −1 格 /
    平移 +1 格」三个候选里，取**间距最均匀**且峰值强度不塌的那个。
    """
    line_count = len(positions)
    if line_count < 3:
        return positions
    step = float((positions[-1] - positions[0]) / (line_count - 1))
    if step <= 0:
        return positions
    length = len(projection)
    candidates = []
    for k in (0.0, -1.0, 1.0):
        snapped, peaks = _snap_to_peaks(projection, positions + k * step, radius)
        if snapped is None:
            continue
        if snapped[0] < 0 or snapped[-1] > length - 1:
            continue
        if np.any(np.diff(snapped) <= 0):
            continue
        strength = float(np.median((peaks - baseline) / spread))
        candidates.append((strength, _spacing_cv(snapped), snapped))
    if not candidates:
        return positions
    best_strength = max(c[0] for c in candidates)
    
    viable = [c for c in candidates if c[0] >= 0.70 * best_strength] or candidates
    viable.sort(key=lambda c: c[1])
    return viable[0][2]

def _fit_axis(projection: np.ndarray, line_count: int) -> tuple[np.ndarray, float]:
    length = len(projection)
    if length < line_count * 3:
        raise DetectionError("候选区域太小，无法拟合棋盘网格")
    best_positions: np.ndarray | None = None
    best_score = -1.0
    radius = max(1, int(length / line_count / 7))
    baseline = float(np.percentile(projection, 55))
    spread = max(float(np.percentile(projection, 95) - baseline), 0.5)
    for start_fraction in np.linspace(0.015, 0.13, 10):
        for end_fraction in np.linspace(0.87, 0.985, 10):
            positions = np.linspace(start_fraction * (length - 1), end_fraction * (length - 1), line_count)
            spacing = float(positions[1] - positions[0])
            if spacing < 4:
                continue
            adjusted, peaks = _snap_to_peaks(projection, positions, radius)
            if adjusted is None or peaks is None:
                continue
            deviations = np.abs(np.asarray(adjusted, dtype=float) - positions)
            regularity = max(0.0, 1.0 - float(np.mean(deviations)) / max(radius + 0.5, 1))
            peak_strength = float(np.median((np.asarray(peaks) - baseline) / spread))
            score = 0.78 * peak_strength + 0.22 * regularity
            if score > best_score:
                best_score = score
                best_positions = np.asarray(adjusted, dtype=float)
    if best_positions is None:
        raise DetectionError("没有找到等距网格")
    best_positions = _reanchor_regular(projection, best_positions, radius, baseline, spread)
    return best_positions, float(np.clip(best_score, 0.0, 1.0))

def _axis_regularity(lines: np.ndarray) -> float:
    spacings = np.diff(lines)
    if len(spacings) == 0 or np.any(spacings <= 0):
        return 0.0
    mean_spacing = float(np.mean(spacings))
    if mean_spacing <= 0:
        return 0.0
    ideal = np.linspace(float(lines[0]), float(lines[-1]), len(lines))
    residual = float(np.sqrt(np.mean(np.square(lines - ideal))) / mean_spacing)
    spacing_cv = float(np.std(spacings) / mean_spacing)
    return float(np.clip(1.0 - max(residual / 0.20, spacing_cv / 0.28), 0.0, 1.0))

def _grid_metrics(
    x_lines: np.ndarray,
    y_lines: np.ndarray,
    candidate_width: int,
    candidate_height: int,
) -> tuple[float, float, float]:
    x_span = float(x_lines[-1] - x_lines[0])
    y_span = float(y_lines[-1] - y_lines[0])
    if x_span <= 0 or y_span <= 0:
        return 0.0, 0.0, 0.0
    grid_aspect = min(x_span / y_span, y_span / x_span)
    regularity = min(_axis_regularity(x_lines), _axis_regularity(y_lines))
    extent = min(
        x_span / max(candidate_width - 1, 1),
        y_span / max(candidate_height - 1, 1),
    )
    return (
        float(np.clip(grid_aspect, 0.0, 1.0)),
        float(np.clip(regularity, 0.0, 1.0)),
        float(np.clip(extent, 0.0, 1.0)),
    )

def _period_lock_axis(projection: np.ndarray, line_count: int) -> tuple[np.ndarray, float]:
    """Lock evenly-spaced line positions by maximizing projection energy.

    Unlike ``_fit_axis`` this does not assume near-square pixels: it searches a
    period and phase per axis, so it also recovers boards that are stretched
    (non-equal x/y spacing) in the screenshot.  Returns positions local to the
    projection plus a 0..1 score.
    """
    prof = projection - float(np.mean(projection))
    n = len(prof)
    expected = n / (line_count - 1)
    lo = max(6.0, expected * 0.72)
    hi = expected * 1.35
    best_score = -1.0
    best_pos = np.linspace(0, n - 1, line_count)
    for step in np.linspace(lo, hi, 260):
        k = int(round(step))
        if k < 6:
            continue
        
        proximity = float(np.exp(-((step - expected) / max(expected * 0.30, 1.0)) ** 2))
        for phase in range(0, k, 1):
            idx = np.round(np.arange(line_count) * step + phase).astype(int)
            if idx[0] < 0 or idx[-1] >= n:
                continue
            score = float(np.sum(prof[idx])) * (0.55 + 0.45 * proximity)
            if score > best_score:
                best_score = score
                best_pos = idx.astype(np.float64)
    span = max(best_pos[-1] - best_pos[0], 1.0)
    norm = best_score / max(span, 1.0)
    return best_pos, float(np.clip(norm / max(np.std(prof) + 1e-3, 1e-3), 0.0, 1.0))

def _locate_stretched(
    image_rgb: np.ndarray,
    rect: tuple[int, int, int, int],
    line_count: int,
) -> BoardGeometry:
    """Recover a board whose pixel grid is stretched (non-square cells) and
    whose rough region also contains a side panel.  Lock rows first (they are
    the most reliable signal), then lock columns with the step constrained
    around the row step so panel edges cannot form a sub/super-harmonic.
    """
    x1, y1, x2, y2 = rect
    gray = cv2.cvtColor(image_rgb[y1 : y2 + 1, x1 : x2 + 1], cv2.COLOR_RGB2GRAY)
    blur = cv2.GaussianBlur(gray, (0, 0), 5)
    dark = cv2.GaussianBlur((blur - gray).clip(0), (0, 0), 3)
    rowp = dark.mean(1)
    colp = dark.mean(0)

    y_pos, y_s = _period_lock_axis(rowp, line_count)
    
    y_base = float(np.percentile(rowp, 55))
    y_spread = max(float(np.percentile(rowp, 95) - y_base), 0.5)
    y_pos = _reanchor_regular(rowp, y_pos, max(1, int(len(rowp) / line_count / 7)),
                              y_base, y_spread)
    ystep = float((y_pos[-1] - y_pos[0]) / (line_count - 1))
    
    xp = colp - colp.mean()
    expected = ystep
    best_score = -1e9
    best_x = np.linspace(0, len(colp) - 1, line_count)
    lo, hi = expected * 0.62, expected * 1.18
    for step in np.linspace(lo, hi, 160):
        k = int(round(step))
        if k < 6:
            continue
        for phase in range(0, k, 1):
            idx = np.round(np.arange(line_count) * step + phase).astype(int)
            if idx[0] < 0 or idx[-1] >= len(xp):
                continue
            vals = xp[idx]
            
            score = float(np.median(vals))
            if score > best_score:
                best_score = score
                best_x = idx.astype(np.float64)

    x_base = float(np.percentile(colp, 55))
    x_spread = max(float(np.percentile(colp, 95) - x_base), 0.5)
    best_x = _reanchor_regular(colp, best_x, max(1, int(len(colp) / line_count / 7)),
                               x_base, x_spread)

    xs = best_x + x1
    ys = y_pos + y1
    confidence = float(np.clip(min(y_s, 0.6 + best_score / max(np.std(colp) + 1e-3, 1e-3) * 0.1), 0, 1))
    return BoardGeometry(xs, ys, confidence, "auto")

def geometry_from_rect(
    image_rgb: np.ndarray,
    rect: tuple[int, int, int, int],
    line_count: int,
    *,
    source: str = "manual",
    lock: bool = False,
) -> BoardGeometry:
    x1, y1, x2, y2 = rect
    x1, x2 = sorted((max(0, x1), min(image_rgb.shape[1] - 1, x2)))
    y1, y2 = sorted((max(0, y1), min(image_rgb.shape[0] - 1, y2)))
    if x2 - x1 < line_count * 4 or y2 - y1 < line_count * 4:
        raise DetectionError("框选区域过小")
    gray = cv2.cvtColor(image_rgb[y1 : y2 + 1, x1 : x2 + 1], cv2.COLOR_RGB2GRAY)
    if lock:
        xs, x_score = _period_lock_axis(_axis_projection(gray, 0), line_count)
        ys, y_score = _period_lock_axis(_axis_projection(gray, 1), line_count)
    else:
        xs, x_score = _fit_axis(_axis_projection(gray, 0), line_count)
        ys, y_score = _fit_axis(_axis_projection(gray, 1), line_count)
    candidate_width = x2 - x1 + 1
    candidate_height = y2 - y1 + 1
    rect_aspect = min(
        candidate_width / max(candidate_height, 1),
        candidate_height / max(candidate_width, 1),
    )
    grid_aspect, regularity, _ = _grid_metrics(
        xs, ys, candidate_width, candidate_height
    )
    confidence = float(
        np.clip(
            0.50 * min(x_score, y_score)
            + 0.25 * grid_aspect
            + 0.15 * rect_aspect
            + 0.10 * regularity,
            0,
            1,
        )
    )
    return BoardGeometry(xs + x1, ys + y1, confidence, source)

def locate_board(image_rgb: np.ndarray, line_count: int = 15) -> BoardGeometry:
    if line_count not in (15, 19):
        raise ValueError("目前仅支持 15 路或 19 路棋盘")
    candidates = _candidate_rectangles(image_rgb, line_count)
    if not candidates:
        raise DetectionError("屏幕中没有找到近似方形的棋盘网格")

    best: BoardGeometry | None = None
    best_score = -1.0

    def evaluate(geometry, x, y, w, h):
        nonlocal best, best_score
        grid_aspect, regularity, extent = _grid_metrics(
            geometry.x_lines - x, geometry.y_lines - y, w, h
        )
        if grid_aspect < 0.84 or regularity < 0.42:
            return
        score = 0.70 * geometry.confidence + 0.20 * regularity + 0.10 * extent
        if score > best_score:
            best_score = score
            best = replace(geometry, confidence=float(np.clip(score, 0, 1)))

    for x, y, w, h in candidates:
        try:
            geometry = geometry_from_rect(image_rgb, (x, y, x + w - 1, y + h - 1), line_count, source="auto")
        except DetectionError:
            continue
        evaluate(geometry, x, y, w, h)

    if best is None:
        
        ranked = sorted(candidates, key=lambda c: c[2] * c[3], reverse=True)
        for x, y, w, h in ranked:
            try:
                geometry = _locate_stretched(
                    image_rgb, (x, y, x + w - 1, y + h - 1), line_count,
                )
            except (DetectionError, ValueError, IndexError):
                continue
            grid_aspect, regularity, extent = _grid_metrics(
                geometry.x_lines - x, geometry.y_lines - y, w, h
            )
            if regularity < 0.55:
                continue
            score = 0.60 * geometry.confidence + 0.25 * regularity + 0.15 * extent
            if score > best_score:
                best_score = score
                best = replace(geometry, confidence=float(np.clip(score, 0, 1)))

    if best is None or best_score < 0.62:
        raise DetectionError("发现了候选区域，但网格间距不稳定")
    return best

def with_screen_origin(geometry: BoardGeometry, origin: tuple[int, int]) -> BoardGeometry:
    return replace(geometry, screen_left=origin[0], screen_top=origin[1])

def _axis_liveness(
    gray: np.ndarray,
    lines: np.ndarray,
    start: int,
    end: int,
    spacing: float,
    *,
    vertical: bool,
) -> float:
    """Measure whether a set of locked, equally spaced lines is still visible.

    A board can change screens without changing the captured window dimensions.
    In that case the old coordinates must not be trusted just because every
    stone patch looks like an empty, high-confidence patch.  We compare each
    expected line with flanks half a cell away and permit only a tiny capture
    jitter when choosing the strongest nearby pixel column/row.
    """

    if len(lines) < 5 or spacing < 4 or start > end:
        return 0.0
    height, width = gray.shape
    half = max(0, min(1, int(round(spacing * 0.035))))
    flank_offset = max(8, int(round(spacing * 0.42)))
    search_radius = max(1, min(6, int(round(spacing * 0.16))))
    contrasts: list[float] = []
    offsets: list[int] = []

    for line in lines:
        expected = int(round(float(line)))
        best_contrast = -1.0
        best_offset: int | None = None
        for offset in range(-search_radius, search_radius + 1):
            point = expected + offset
            if vertical:
                if (
                    point - half < 0
                    or point + half >= width
                    or point - flank_offset - half < 0
                    or point + flank_offset + half >= width
                ):
                    continue
                core = gray[start : end + 1, point - half : point + half + 1]
                left = gray[start : end + 1, point - flank_offset - half : point - flank_offset + half + 1]
                right = gray[start : end + 1, point + flank_offset - half : point + flank_offset + half + 1]
            else:
                if (
                    point - half < 0
                    or point + half >= height
                    or point - flank_offset - half < 0
                    or point + flank_offset + half >= height
                ):
                    continue
                core = gray[point - half : point + half + 1, start : end + 1]
                left = gray[point - flank_offset - half : point - flank_offset + half + 1, start : end + 1]
                right = gray[point + flank_offset - half : point + flank_offset + half + 1, start : end + 1]
            flank = np.concatenate((left.reshape(-1), right.reshape(-1)))
            contrast = abs(float(np.median(flank)) - float(np.median(core)))
            
            if contrast > best_contrast + 1e-6 or (
                abs(contrast - best_contrast) <= 1e-6
                and (best_offset is None or abs(offset) < abs(best_offset))
            ):
                best_contrast = contrast
                best_offset = offset
        if best_offset is not None:
            contrasts.append(best_contrast)
            offsets.append(best_offset)

    if len(contrasts) < max(5, int(round(len(lines) * 0.8))):
        return 0.0
    contrast_array = np.asarray(contrasts, dtype=np.float32)
    
    offset_values = offsets[1:-1] if len(offsets) > 4 else offsets
    offset_array = np.abs(np.asarray(offset_values, dtype=np.float32))
    
    strength = float(np.clip((np.median(contrast_array) - 8.0) / 24.0, 0.0, 1.0))
    hit_ratio = float(np.mean(contrast_array >= 12.0))
    alignment = float(
        np.clip(
            1.0
            - max(
                float(np.median(offset_array)) / 4.0,
                float(np.percentile(offset_array, 90)) / 6.0,
            ),
            0.0,
            1.0,
        )
    )
    return float(np.clip((0.70 * strength + 0.30 * hit_ratio) * alignment, 0.0, 1.0))

def grid_liveness(image_rgb: np.ndarray, geometry: BoardGeometry) -> float:
    """Return a 0..1 score indicating whether ``geometry`` fits this frame.

    This is intentionally separate from :func:`read_stones`: an empty patch
    on a menu or a dialog can have perfect stone confidence, but it is not a
    live chessboard.  Callers that may click should require this score in
    addition to stone confidence.
    """

    image = np.asarray(image_rgb)
    if image.ndim != 3 or image.shape[2] != 3 or image.size == 0:
        return 0.0
    try:
        x_lines = np.asarray(geometry.x_lines, dtype=np.float32)
        y_lines = np.asarray(geometry.y_lines, dtype=np.float32)
        spacing = float(geometry.spacing)
    except (AttributeError, TypeError, ValueError):
        return 0.0
    if len(x_lines) != len(y_lines) or len(x_lines) < 5 or not np.isfinite(spacing):
        return 0.0
    height, width = image.shape[:2]
    x_start, x_end = int(round(float(x_lines[0]))), int(round(float(x_lines[-1])))
    y_start, y_end = int(round(float(y_lines[0]))), int(round(float(y_lines[-1])))
    if not (0 <= x_start < x_end < width and 0 <= y_start < y_end < height):
        return 0.0
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    x_score = _axis_liveness(
        gray,
        x_lines,
        y_start,
        y_end,
        spacing,
        vertical=True,
    )
    y_score = _axis_liveness(
        gray,
        y_lines,
        x_start,
        x_end,
        spacing,
        vertical=False,
    )
    return float(min(x_score, y_score))

def read_stones(image_rgb: np.ndarray, geometry: BoardGeometry, bg_level=None) -> tuple[np.ndarray, np.ndarray]:
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    board = np.full((geometry.size, geometry.size), EMPTY, dtype=np.int8)
    confidence = np.zeros_like(board, dtype=np.float32)
    
    bright_thr = 215.0
    if bg_level is not None:
        bright_thr = max(215.0, float(bg_level) + 12.0)
    radius = max(3, int(round(geometry.spacing * 0.30)))
    outer_radius = max(radius + 2, int(round(geometry.spacing * 0.47)))

    yy, xx = np.ogrid[-outer_radius : outer_radius + 1, -outer_radius : outer_radius + 1]
    distance = np.sqrt(xx * xx + yy * yy)
    inner_mask = distance <= radius
    ring_mask = (distance >= radius * 1.16) & (distance <= outer_radius)

    for row, yf in enumerate(geometry.y_lines):
        for col, xf in enumerate(geometry.x_lines):
            x, y = int(round(float(xf))), int(round(float(yf)))
            x1, x2 = x - outer_radius, x + outer_radius + 1
            y1, y2 = y - outer_radius, y + outer_radius + 1
            
            cx1, cx2 = max(0, x1), min(gray.shape[1], x2)
            cy1, cy2 = max(0, y1), min(gray.shape[0], y2)
            if cx1 >= cx2 or cy1 >= cy2:
                continue
            patch_gray = gray[cy1:cy2, cx1:cx2]
            patch_hsv = hsv[cy1:cy2, cx1:cx2]
            sub_inner = inner_mask[cy1 - y1 : cy2 - y1, cx1 - x1 : cx2 - x1]
            sub_ring = ring_mask[cy1 - y1 : cy2 - y1, cx1 - x1 : cx2 - x1]
            inner = patch_gray[sub_inner].astype(np.float32)
            ring = patch_gray[sub_ring].astype(np.float32)
            
            inner_mean, ring_mean = float(np.median(inner)), float(np.mean(ring))
            dark_ratio = float(np.mean(inner < 92))
            bright_neutral = (patch_gray > bright_thr) & (patch_hsv[:, :, 1] < 70)
            white_ratio = float(np.mean(bright_neutral[sub_inner]))
            red_marker = (
                ((patch_hsv[:, :, 0] <= 8) | (patch_hsv[:, :, 0] >= 170))
                & (patch_hsv[:, :, 1] > 100)
                & (patch_hsv[:, :, 2] > 105)
            )
            red_marker_ratio = float(np.mean(red_marker[sub_inner]))

            black_strength = max((ring_mean - inner_mean - 25) / 75, (dark_ratio - 0.26) / 0.58)
            white_strength = max((inner_mean - ring_mean - 18) / 62, (white_ratio - 0.36) / 0.58)
            if inner_mean - ring_mean >= 20 and white_ratio >= 0.45 and dark_ratio < 0.12:
                plain_white = 0.58 + min(0.38, (inner_mean - ring_mean - 20) / 55)
                white_strength = max(white_strength, plain_white)
            
            if (
                red_marker_ratio >= 0.075
                and inner_mean - ring_mean >= 5
                and white_ratio >= 0.22
                and dark_ratio < 0.12
            ):
                marked_white = 0.54 + min(0.40, (red_marker_ratio - 0.075) * 2.5)
                white_strength = max(white_strength, marked_white)
            if black_strength >= 0.43 and black_strength > white_strength + 0.08:
                board[row, col] = BLACK
                confidence[row, col] = float(np.clip(black_strength, 0, 1))
            elif white_strength >= 0.43 and white_strength > black_strength + 0.08:
                board[row, col] = WHITE
                confidence[row, col] = float(np.clip(white_strength, 0, 1))
            else:
                confidence[row, col] = float(np.clip(1 - max(black_strength, white_strength), 0, 1))
    return board, confidence
