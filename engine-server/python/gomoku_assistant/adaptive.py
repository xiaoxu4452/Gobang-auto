# Assistant module - adaptive.

"""自适应棋盘读子核心（OpenCV 官方范式）
=====================================

**为什么重做**：旧读子逻辑靠「绝对亮度阈值」判色（``gray > 215 → 白子``）。这类阈值隐含
一个前提——**棋盘底色必须明显暗于白子**。一旦遇到亮底棋盘（浅木色/米色，如 #f2ead8
亮度 234），阈值被底色本身击穿：每个空交点都满足「够亮 + 低饱和」，全被判成白子。
实测某站点 225 个交点读出 224 个假白子 → 面板报「对手已五子连珠·我方落败」。

**新逻辑**（全部取 OpenCV 官方文档推荐手段，且不含任何绝对亮度常量）：

1. **局部背景建模（中值滤波）**
   ``cv2.medianBlur(gray, k)``，核尺寸 ≈ 1.8 倍格距，远大于棋子直径：棋子与细网格线都被
   抹平成背景，得到「绝对亮度场」。``diff = gray - bg`` 于是只保留“相对局部背景的偏离量”，
   棋盘底色深浅、木纹、渐变、阴影一并抵消。
   （OpenCV smoothing 教程的中值滤波；亦是“中值滤波做背景估计”的经典用法。）

2. **鲁棒统计阈值（不用绝对亮度常量）**
   对 ``diff`` 取中位数 + MAD（中位绝对偏差）估计噪声 σ，阈值 ``thr = max(基础对比度, k·σ)``。
   判据变成纯**对比度**判据（“比局部背景亮/暗多少个灰阶”），亮底、暗底、木纹底一视同仁。

3. **形状验证（OpenCV 连通域 / 轮廓官方手段）**
   候选点做 ``|diff| > thr`` 二值化 → ``cv2.connectedComponentsWithStats`` → 取离交点最近、
   面积落在「棋子尺度」区间的连通域 → 用 ``cv2.arcLength`` / ``cv2.contourArea`` 算圆度
   4πA/P²（contour features 教程）。面积 / 圆度 / 质心任一不合格即否决——这一步把
   「十字禁手标记、坐标文字、星位点、粗边框、开局限制蓝框」等装饰全部挡在读子之外
   （旧逻辑正是被这些非棋子图形带偏的）。

4. **描边线索兜底（近白底棋盘）**
   若底色接近纯白、白子与底色几乎同亮（填充对比度 ≈ 0），改用“空心圆”线索：
   内盘平坦 + 半径 ≈ 0.44 格处存在深色描边环 → 判为白子（多数站点白子都带描边）。

5. **棋理不变量自诊断**
   真实对局恒有 |黑-白| ≤ 1，且落子数不会异常膨胀。越界即 ``suspect=True`` 回传前端，
   前端据此丢弃本次识别、回退其它识别路径——**识别逻辑要能知道自己读错了**，
   而不是把垃圾结果当真理（这正是本次故障的放大器）。
"""

from __future__ import annotations

import numpy as np
import cv2

from .engine import BLACK, EMPTY, WHITE

BASE_CONTRAST = 10.0   
MAD_K = 4.0            
MIN_CIRCULARITY = 0.55  

HULL_CIRC_MIN = 0.80
SCORE_MIN_RATIO = 0.25  
SCORE_MAX_RATIO = 3.2   

CORE_R = 0.26           
RING_R0 = 0.34          
RING_R1 = 0.50          
RING_SECTORS = 24       
RING_COVER_MIN = 0.70   
RING_ARC_MIN = 0.50     
RING_FILL_MIN = 0.10    

OUT_R0 = 0.50
OUT_R1 = 0.555

CELL_CONTRAST_MIN = 14.0   
CELL_THR_RATIO = 0.45      
CELL_BG_R = 0.12           
CELL_BG_OFF = 0.50         
CELL_FILL_REL = 0.25       
CELL_FILL_MIN = 0.60       

CELL_FILL_MAIN_MIN = 0.55  

def _odd(n: float, lo: int = 9, hi: int = 151) -> int:
    v = int(round(n))
    if v % 2 == 0:
        v += 1
    return max(lo, min(hi, v))

def _global_mode(gray: np.ndarray) -> int:
    """整幅（棋盘区域）灰度直方图众数 = 棋盘底色。先做 5 点滑动平均抑制噪声尖峰。"""
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    hist = np.convolve(hist, np.ones(5) / 5.0, mode="same")
    return int(np.argmax(hist))

def estimate_background(gray: np.ndarray, spacing: float):
    """局部背景亮度场（对「密集棋簇」与「渐变/纹理」都免疫）。

    做法（OpenCV 官方的 normalized box filter 反归一化用法）：
      1. 直方图众数得到全局底色 bg0，据此把「非背景像素」（棋子、网格线、标记）
         从背景估计中**剔除**——这一步是关键：单纯的大核中值滤波在密集棋簇里
         窗口内过半是棋子，中位数会退化成棋子色，导致棋簇中心的棋子“凭空消失”。
      2. 只在背景像素上做局部均值：``Σ(gray·mask) / Σ(mask)``（两次 boxFilter）。
         窗口取 ~4 倍格距，足够跨过棋簇；同时又能跟随底色的低频渐变/阴影。
      3. 某处背景像素太少（<5 个）→ 退回全局众数 bg0。

    返回 (背景亮度场 float32, 全局众数, 背景噪声 σ)。
    """
    g = gray.astype(np.float32)
    bg0 = _global_mode(gray)
    
    sigma0 = _noise_sigma(gray.astype(np.int16))
    fg = (np.abs(g - float(bg0)) > max(10.0, MAD_K * sigma0)).astype(np.float32)
    bg_mask = 1.0 - fg
    k = _odd(spacing * 4.0, 9, 301)
    wsum = cv2.boxFilter(bg_mask, -1, (k, k), normalize=False)
    vsum = cv2.boxFilter(g * bg_mask, -1, (k, k), normalize=False)
    field = vsum / np.maximum(wsum, 1.0)
    field = np.where(wsum < 5.0, float(bg0), field)
    
    bp = g[bg_mask > 0.5]
    if bp.size > 100:
        sigma_bg = 1.4826 * float(np.median(np.abs(bp - float(np.median(bp)))))
    else:
        sigma_bg = 0.0
    return field.astype(np.float32), bg0, sigma_bg

def _noise_sigma(diff: np.ndarray) -> float:
    """鲁棒噪声估计：σ ≈ 1.4826 × MAD（中位绝对偏差），不受少量棋子像素影响。"""
    med = float(np.median(diff))
    mad = float(np.median(np.abs(diff - med)))
    return 1.4826 * mad

def plateau_like(out_v: np.ndarray, ref: float) -> bool:
    """「平斑块」判据（数组版）：见 ``plateau_like_med``。"""
    if out_v.size == 0:
        return False
    return plateau_like_med(float(np.median(out_v)), ref)

def plateau_like_med(out_med: float, ref: float) -> bool:
    """「平斑块」判据：棋子外沿之外的环带仍是**同极性**的显著偏离 → 不是棋子。

    ref = 交点内盘的中位数（棋子主体对比的代理）。真棋子之外这一环带要么是背景
    （med≈0），要么是**反极性**的落影（白子下的阴影是暗的）；只有水印/渐变这类
    大面积平滑叠加才会带着与主体同号的偏离越过环带（疫苗自测 dark_blue+水印
    读出 22 颗假白子，就是这一条拦下的）。
    """
    thr = max(10.0, 0.35 * abs(float(ref)))
    if ref >= 0:
        return out_med > thr
    return out_med < -thr

def quads_plateau_vals(quad_meds, ref: float) -> bool:
    """「平斑块」分象限判据（比中位数版更灵敏）。

    水印/图形的**边缘曲线**恰好穿过外环带时，环带中位数会被稀释到 ≈0、绕过中位数版；
    但分象限看立刻露馅 —— 斑块延伸方向的那几个象限仍是同极性显著偏离，而真棋子
    四个象限的外带全该是背景（环带 0.50~0.555 格距碰不到邻子，邻子最近到 0.56）。
    边角格只考察朝盘内的象限（与 cell_bg_union 同思路）。
    """
    thr = max(12.0, 0.35 * abs(float(ref)))
    pos = ref >= 0
    for v in quad_meds:
        if pos and v > thr:
            return True
        if not pos and v < -thr:
            return True
    return False

def quads_plateau(quads_v, ref: float) -> bool:
    """「平斑块」分象限判据（掩膜数组版）：见 ``quads_plateau_vals``。"""
    return quads_plateau_vals([float(np.median(q)) for q in quads_v if q.size], ref)

def _boundary_edge(patch: np.ndarray, in_m: np.ndarray, out_m: np.ndarray) -> float:
    """棋子边界处的环形边缘强度（平斑块闸门的复核证据，2026-09-19 屏江棋院）。

    平斑块闸门有个隐藏前提：「外环带对真棋子必然回到背景」。但屏江棋院这类站点
    把棋子画得**极大**（直径≈格距、边缘几乎相触），邻子的身体/光晕会探进 0.50~
    0.555 格距的环带 —— 整圈环带同极性发亮，把 10 颗真白子全否决了。
    真正区分二者的证据：**真棋子在自身边界半径（~0.44 格距）处一定有环形边缘**
    （子与外侧 whatever 的分界），而水印/渐变平斑块内部光滑、跨过边界半径依然
    平滑（现场实测：簇内真白子 edge=29~56，空点/水印≈0~4）。
    返回 |内环(0.30s) 中位数 − 外环(0.55s) 中位数|；环带平斑块但此值大 → 放行。
    """
    if not in_m.any() or not out_m.any():
        return 0.0
    return abs(float(np.median(patch[in_m])) - float(np.median(patch[out_m])))

def plateau_gate_veto(out_plateau: bool, ref: float, edge: float) -> bool:
    """平斑块闸门最终裁决：环带平斑块 **且** 边界无环形边缘 → 否决。

    豁免线 26 的来历（现场实测分布）：需要救的真棋子（屏江棋院簇内白子，
    环带亮来自邻子身体/自身光晕）edge=29~56；要拦的深盘水印假白子
    （字母笔画边缘恰好穿过内外环）edge=14~24。真黑子相邻时环带分象限
    中位数被棋盘底色稀释、平斑块本就不触发，不受此线影响。
    """
    if not out_plateau:
        return False
    return edge < max(26.0, 0.12 * abs(float(ref)))

def _circularity(contour) -> float:
    area = float(cv2.contourArea(contour))
    per = float(cv2.arcLength(contour, True))
    if area <= 0 or per <= 0:
        return 0.0
    return float(4.0 * np.pi * area / (per * per))

def _radial_maps(half: int, spacing: float, sectors: int = RING_SECTORS):
    """以交点为中心的「内盘 / 描边环带 / 环带角向扇区」索引图（窗口 (2*half+1)²）。

    用于区分三种形态：实心暗子（内盘显著暗）、实心亮子（内盘显著亮）、
    空心描边子（内盘≈底色、环带有闭合强对比）。角向扇区用于把**闭合圆环**
    与**网格线十字**区分开——后者只在 4 个方向上有对比像素。
    """
    yy, xx = np.mgrid[-half:half + 1, -half:half + 1]
    dist = np.hypot(xx.astype(np.float32), yy.astype(np.float32))
    core_m = dist <= CORE_R * spacing
    ring_m = (dist >= RING_R0 * spacing) & (dist <= RING_R1 * spacing)
    ang = (np.arctan2(yy.astype(np.float32), xx.astype(np.float32)) + np.pi) / (2.0 * np.pi)
    sec = np.clip(np.floor(ang * sectors).astype(np.int32), 0, sectors - 1)
    ring_sec = np.where(ring_m, sec, -1).reshape(-1)   
    return core_m, ring_m, ring_sec.reshape(2 * half + 1, 2 * half + 1)

def _cell_bg_masks(half: int, spacing: float):
    """格子四角采样掩膜（与 _radial_maps 同一窗口坐标系）。

    四个圆心在 (±0.5d, ±0.5d)、半径 0.12d 的小盘：距最近的网格线 0.5d、距最近的邻子
    中心 0.71d —— 只要棋子半径 ≤0.5d，就**几何上不可能**与棋子重叠，取到的一定是干净底色。
    返回 {(sx, sy): mask}，sx/sy ∈ {-1, +1}；棋盘边上的交叉点只用落在盘内的角，
    否则会采到盘外木框 / 坐标文字，反而把该格的局部底色带偏。
    """
    yy, xx = np.mgrid[-half:half + 1, -half:half + 1].astype(np.float32)
    out = {}
    r = CELL_BG_R * spacing
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            cx, cy = sx * CELL_BG_OFF * spacing, sy * CELL_BG_OFF * spacing
            out[(int(sx), int(sy))] = (np.hypot(xx - cx, yy - cy) <= r)
    return out

def cell_bg_union(cell_bg, row: int, col: int, n: int):
    """返回某格用来估「局部底色」的角掩膜并集。

    一般格：只用落在盘内的四只角（几何上不会压到任何子）。
    **边界格**：把朝盘外的那两只角也并进来 —— 越过棋盘外沿的方向没有邻格，
    但角掩膜是纯几何的，照样能用。

    为什么边界格必须并盘外的角：棋盘木底自带「边缘暗角」，距交点 0.5 格（盘内角）
    与 1 格（再往里的角）之间就有 ~14 灰阶的**单调梯度**，正好顶到 ``CELL_CONTRAST_MIN``
    → 四个角点 (0,0)/(0,14)/(14,0)/(14,14) 被打成「整块暗区」当黑子
    （现场：局面小棋盘左上角凭空多出一颗黑子）。并进盘外的角后梯度两侧相消；
    真棋子是**局部极值**（内、外都是底色），两个方向对比同号同量级，不受影响。
    """
    sx_list = [v for v in (-1, 1) if 0 <= col + v < n]
    sy_list = [v for v in (-1, 1) if 0 <= row + v < n]
    bgm = cell_bg[(sx_list[0], sy_list[0])]
    for sx in sx_list:
        for sy in sy_list:
            if (sx, sy) != (sx_list[0], sy_list[0]):
                bgm = bgm | cell_bg[(sx, sy)]
    if len(sx_list) < 2 or len(sy_list) < 2:
        for sx in (-1, 1):
            for sy in (-1, 1):
                if 0 <= col + sx < n and 0 <= row + sy < n:
                    continue
                bgm = bgm | cell_bg[(sx, sy)]
    return bgm

def decide_color(patch: np.ndarray, core_m, ring_m, ring_sec, thr: float,
                 sectors: int = RING_SECTORS):
    """按径向证据判定交点处的棋子颜色：返回 (BLACK/WHITE/EMPTY, 置信度)。

    ⚠️ **存在性与颜色必须一起判**：粗网格线棋盘上，空交叉点的内盘本就被线十字占掉一半
    （实测 core 暗占比 0.5~0.63），所以「内盘暗」只说明*颜色*，不能说明*有子*。
    有无棋子一律以「环带角向是否闭合」为准：实心子填满环带（hit≈1.0）、空心描边子
    占环带七成、空点只有网格线十字的 4 个方向（hit≈0.2、连续弧 <0.1 圈）。

    1. 环带不闭合 → 空点（挡住网格线/星位/十字/坐标等装饰）。
    2. 环带闭合 → 有子：内盘显著暗 → 黑；内盘显著亮 → 白；
       内盘与底色不可分辨 → 由环的极性定色：深环 → 白子（浅底白子的通用画法），
       亮环 → 黑子（深色主题上「黑子用浅色描边表示」的对称画法）。
    """
    ring = patch[ring_m]
    if ring.size == 0:
        return EMPTY, 0.0
    hit = np.abs(ring) > thr
    if float(hit.mean()) < RING_FILL_MIN:
        return EMPTY, 0.0

    rs = ring_sec[ring_m].reshape(-1)      
    hf = hit.reshape(-1)
    rv = ring.reshape(-1)
    sel = (rs >= 0) & hf
    if not sel.any():
        return EMPTY, 0.0
    valid = np.zeros(sectors, dtype=bool)
    polar = np.zeros(sectors, dtype=np.float32)
    for s in range(sectors):
        m = sel & (rs == s)
        cnt = int(m.sum())
        if cnt:
            
            tot = int((rs == s).sum())
            if tot and cnt / tot >= 0.25:
                valid[s] = True
                polar[s] = float(np.median(rv[m]))
    if not valid.any():
        return EMPTY, 0.0
    
    best = cur = 0
    for s in range(sectors * 2):
        if valid[s % sectors]:
            cur += 1
            best = max(best, min(cur, sectors))
        else:
            cur = 0
    arc = best / float(sectors)
    cover = float(valid.sum()) / float(sectors)
    if arc < RING_ARC_MIN and cover < RING_COVER_MIN:
        return EMPTY, 0.0              

    core = patch[core_m]
    if core.size:
        if float(np.mean(core < -thr)) >= 0.5:
            return BLACK, 0.85         
        if float(np.mean(core > thr)) >= 0.5:
            return WHITE, 0.85         
    
    pos = float(np.sum(polar[valid] > 0))
    neg = float(np.sum(polar[valid] < 0))
    if pos == neg:
        return EMPTY, 0.0
    med = float(np.median(polar[valid]))
    if med == 0.0:
        med = 1.0 if pos > neg else -1.0
    return (WHITE if med < 0 else BLACK), 0.55

def strip_border_artifacts(board: np.ndarray, conf=None, min_ratio: float = 0.80) -> int:
    """剔除「贴着棋盘外边界、整行/整列同色」的伪棋子，返回剔除个数。

    为什么可以这么判：五子棋**连 5 即终局**，任何合法局面都不可能出现 12 个以上同色连子。
    真实屏幕上出现这种「最外一行（15 个交叉点）全同色」，只可能是
    **棋盘外框 / 窗口边框被读成了棋子** —— 桌面端扫屏时实测到两种形态：
      · 网格正确：外边界那一行被读成 15 个白子（blob 命中）；
      · 网格多抓了一条边（窗口标题栏下沿被当成棋盘第一行）：
        被读成 15 个黑子（描边兜底命中）。

    两者都会让 |黑-白| 失衡 → ``invariants`` 判 ``suspect=True`` → 宿主**丢弃整帧**
    → 面板永远显示「未检测到棋盘」（用户报的「发布版桌面端识别不了」就是这个）。

    只在四条外边界行/列上做：外框必然落在边界，**完全不碰内部**，
    因此真实棋形（含终局的五连）绝不会被误删；整盘同色这类误读也会因为
    内部仍失衡而继续被判 suspect（``recognize_selftest`` 有对应断言）。
    """
    n = int(board.shape[0])
    if n < 2:
        return 0
    min_run = max(8, int(round(n * min_ratio)))
    removed = 0

    def clean_line(cells):
        nonlocal removed
        i = 0
        while i < len(cells):
            v = board[cells[i]]
            j = i
            while j + 1 < len(cells) and board[cells[j + 1]] == v:
                j += 1
            if v != EMPTY and (j - i + 1) >= min_run:
                for k in range(i, j + 1):
                    r, c = cells[k]
                    board[r, c] = EMPTY
                    if conf is not None:
                        conf[r, c] = 0.0
                    removed += 1
            i = j + 1

    for r in (0, n - 1):
        clean_line([(r, c) for c in range(n)])
    for c in (0, n - 1):
        clean_line([(r, c) for r in range(n)])
    return removed

def invariants(board: np.ndarray) -> dict:
    """棋理不变量自诊断：|黑-白| ≤ 2、且落子占比不异常膨胀。"""
    nb = int((board == BLACK).sum())
    nw = int((board == WHITE).sum())
    total = nb + nw
    n = int(board.shape[0])
    balanced = abs(nb - nw) <= 2
    
    not_swamped = total <= 0.80 * n * n
    return {
        "black": nb,
        "white": nw,
        "total": total,
        "balanced": bool(balanced),
        "not_swamped": bool(not_swamped),
        "suspect": bool((total >= 6 and not balanced) or not not_swamped),
    }

def read_stones_adaptive(image_rgb: np.ndarray, geometry) -> tuple[np.ndarray, np.ndarray, dict]:
    """自适应读子：返回 (board, confidence, diag)。

    board: int8 矩阵，0=空 / 1=黑 / 2=白（面板约定）
    confidence: 与 board 同形的 0..1 置信度
    diag: 诊断信息（阈值、噪声、命中点数量、不变量检查结果）
    """
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    n = int(geometry.size)
    board = np.full((n, n), EMPTY, dtype=np.int8)
    conf = np.zeros((n, n), dtype=np.float32)
    spacing = float(geometry.spacing)
    h, w = gray.shape

    bg, _bg0, sigma = estimate_background(gray, spacing)
    diff = gray.astype(np.int16) - bg.astype(np.int16)
    
    thr = float(max(BASE_CONTRAST, MAD_K * sigma))

    stone_r = spacing * 0.44
    stone_area = float(np.pi * stone_r * stone_r)
    min_area = stone_area * SCORE_MIN_RATIO
    max_area = stone_area * SCORE_MAX_RATIO
    half = int(round(spacing * 0.62))
    
    pad = half
    diff = cv2.copyMakeBorder(diff, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    core_m, ring_m, ring_sec = _radial_maps(half, spacing)
    cell_bg = _cell_bg_masks(half, spacing)
    
    _yy, _xx = np.mgrid[-half:half + 1, -half:half + 1].astype(np.float32)
    out_m = (np.hypot(_xx, _yy) >= OUT_R0 * spacing) & (np.hypot(_xx, _yy) <= OUT_R1 * spacing)
    quad_ms = ((_yy > 0) & (_xx > 0), (_yy > 0) & (_xx < 0),
               (_yy < 0) & (_xx > 0), (_yy < 0) & (_xx < 0))
    
    _rr = np.hypot(_xx, _yy)
    edge_in_m = (_rr >= spacing * 0.27) & (_rr <= spacing * 0.33)
    edge_out_m = (_rr >= spacing * 0.495) & (_rr <= spacing * 0.605)

    def out_mask_for(row: int, col: int):
        om = out_m
        if row == 0:
            om = om & (_yy > 0)
        elif row == n - 1:
            om = om & (_yy < 0)
        if col == 0:
            om = om & (_xx > 0)
        elif col == n - 1:
            om = om & (_xx < 0)
        return om

    def out_quads(row: int, col: int):
        """外环带的四个象限掩膜；边角格只保留朝盘内的象限。"""
        rows_ok = (1, 1, 0, 0) if row == 0 else ((0, 0, 1, 1) if row == n - 1 else (1, 1, 1, 1))
        cols_ok = (1, 0, 1, 0) if col == 0 else ((0, 1, 0, 1) if col == n - 1 else (1, 1, 1, 1))
        return [out_m & quad_ms[k] for k in range(4) if rows_ok[k] and cols_ok[k]]

    cell_stat = np.zeros((n, n), dtype=np.float32)   
    cell_fill = np.zeros((n, n), dtype=np.float32)   
    cell_out = np.zeros((n, n), dtype=np.float32)    
    cell_outq = np.zeros((n, n, 4), dtype=np.float32)  
    cell_outq[:] = 9999.0
    cell_edge = np.zeros((n, n), dtype=np.float32)   

    hits = 0
    cell_hits = 0

    import os as _os
    _dump_fp = None
    if _os.environ.get('GB_ADAPTIVE_DUMP'):
        _dump_fp = open(_os.environ['GB_ADAPTIVE_DUMP'], 'a', encoding='utf-8')

    def _dump_cell(row, col, lc, fill, clipped, tag):
        if _dump_fp is not None:
            _dump_fp.write('n=%d r=%d c=%d lc=%.2f fill=%.3f clip=%d tag=%s\n'
                           % (n, row, col, lc, fill, 1 if clipped else 0, tag))

    for row, yf in enumerate(geometry.y_lines):
        for col, xf in enumerate(geometry.x_lines):
            x, y = int(round(float(xf))), int(round(float(yf)))
            if not (0 <= x < w and 0 <= y < h):
                continue
            x, y = x + pad, y + pad
            patch = diff[y - half:y + half + 1, x - half:x + half + 1]
            
            _gr = np.arange(-half, half + 1)
            _iy = (y - pad) + _gr[:, None]
            _ix = (x - pad) + _gr[None, :]
            valid_m = (_iy >= 0) & (_iy < h) & (_ix >= 0) & (_ix < w)
            
            core_valid = patch[core_m & valid_m]
            core_v = core_valid
            
            bgm = cell_bg_union(cell_bg, row, col, n)
            bg_v = patch[bgm & valid_m]
            thr_cell = thr
            local_c = 0.0
            if core_v.size and bg_v.size:
                local_c = float(np.median(core_v) - np.median(bg_v))
                
                t_fill = max(BASE_CONTRAST * 0.5, abs(local_c) * CELL_FILL_REL)
                if local_c < 0:
                    cell_fill[row, col] = float(np.mean(core_valid < -t_fill))
                else:
                    cell_fill[row, col] = float(np.mean(core_valid > t_fill))
                if abs(local_c) >= CELL_CONTRAST_MIN:
                    thr_cell = float(max(BASE_CONTRAST,
                                         min(thr, abs(local_c) * CELL_THR_RATIO)))
                    cell_hits += 1
            cell_stat[row, col] = local_c
            om = out_mask_for(row, col)
            ov = patch[om]
            cell_out[row, col] = float(np.median(ov)) if ov.size else 0.0
            for k, qm in enumerate(out_quads(row, col)):
                if k >= 4:
                    break
                qv = patch[qm]
                if qv.size:
                    cell_outq[row, col, k] = float(np.median(qv))
            cell_edge[row, col] = _boundary_edge(patch, edge_in_m, edge_out_m)
            mask = (np.abs(patch) > thr_cell).astype(np.uint8)
            if int(mask.sum()) < min_area * 0.6:
                continue
            
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            cnt_n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
            pick, best = -1, -1e18
            for i in range(1, cnt_n):
                area = float(stats[i, cv2.CC_STAT_AREA])
                if area < min_area or area > max_area:
                    continue
                dx = float(cents[i][0]) - half
                dy = float(cents[i][1]) - half
                dist = float(np.hypot(dx, dy))
                if dist > spacing * 0.30:      
                    continue
                score = area - dist * 6.0
                if score > best:
                    best, pick = score, i
            if pick < 0:
                continue
            comp = (labels == pick).astype(np.uint8)
            conts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not conts:
                continue
            big = max(conts, key=cv2.contourArea)
            
            if float(cell_fill[row, col]) < CELL_FILL_MAIN_MIN:
                disc_m = _rr <= spacing * 0.44
                disc_valid = int((valid_m & disc_m).sum())
                clipped = disc_valid < int(disc_m.sum() * 0.98)
                if not (clipped and abs(local_c) >= CELL_CONTRAST_MIN):
                    _dump_cell(row, col, local_c, float(cell_fill[row, col]), clipped, 'main_gate')
                    continue
            circ = _circularity(big)
            if circ < MIN_CIRCULARITY:
                
                hp = cv2.convexHull(big)
                hcirc = _circularity(hp)
                harea = float(cv2.contourArea(hp))
                if hcirc < HULL_CIRC_MIN or harea > max_area:
                    continue               
                circ = hcirc
                comp = np.zeros_like(comp)
                cv2.drawContours(comp, [hp], -1, 1, -1)
            
            if plateau_gate_veto(
                plateau_like(ov, local_c) or quads_plateau(
                    [patch[qm] for qm in out_quads(row, col)], local_c),
                local_c, _boundary_edge(patch, edge_in_m, edge_out_m),
            ):
                continue
            color, cconf = decide_color(patch, core_m, ring_m, ring_sec, thr_cell)
            if color == EMPTY:
                
                vals = patch[comp.astype(bool)]
                med = float(np.median(vals))
                if abs(med) < thr_cell * 0.75:
                    continue
                color = WHITE if med > 0 else BLACK
                cconf = float(min(1.0, 0.6 * min(1.0, abs(med) / (thr_cell * 3.0)) + 0.4 * circ))
                if color == BLACK:
                    
                    core_v = patch[core_m]
                    if core_v.size and float(np.mean(core_v < -thr_cell)) < 0.2 and \
                       float(np.mean(core_v > thr_cell)) < 0.2:
                        color = WHITE
                        cconf = 0.5
            board[row, col] = color
            conf[row, col] = float(min(1.0, cconf))
            hits += 1

    cell_rescued = 0
    for row in range(n):
        for col in range(n):
            if board[row, col] != EMPTY:
                continue
            lc = float(cell_stat[row, col])
            if abs(lc) < CELL_CONTRAST_MIN or float(cell_fill[row, col]) < CELL_FILL_MIN:
                continue
            
            if plateau_gate_veto(
                plateau_like_med(float(cell_out[row, col]), lc) or quads_plateau_vals(
                    [float(v) for v in cell_outq[row, col] if v < 9000.0], lc),
                lc, float(cell_edge[row, col]),
            ):
                continue
            board[row, col] = BLACK if lc < 0 else WHITE
            conf[row, col] = 0.6
            cell_rescued += 1

    outline_hits = 0
    if (board == EMPTY).any():
        yy, xx = np.mgrid[-half:half + 1, -half:half + 1]
        dist_map = np.hypot(xx, yy)
        inner_m = dist_map <= spacing * 0.26
        out_ring_m = (dist_map >= spacing * 0.36) & (dist_map <= spacing * 0.52)
        for row, yf in enumerate(geometry.y_lines):
            for col, xf in enumerate(geometry.x_lines):
                if board[row, col] != EMPTY:
                    continue
                x, y = int(round(float(xf))), int(round(float(yf)))
                if not (0 <= x < w and 0 <= y < h):
                    continue
                x, y = x + pad, y + pad
                patch = diff[y - half:y + half + 1, x - half:x + half + 1]
                if patch.shape != inner_m.shape:
                    continue
                if patch.shape != core_m.shape:
                    continue
                
                if plateau_gate_veto(
                    plateau_like(patch[out_mask_for(row, col)],
                                 float(np.median(patch[core_m])) if patch[core_m].size else 0.0)
                    or quads_plateau([patch[qm] for qm in out_quads(row, col)],
                                     float(np.median(patch[core_m])) if patch[core_m].size else 0.0),
                    float(np.median(patch[core_m])) if patch[core_m].size else 0.0,
                    _boundary_edge(patch, edge_in_m, edge_out_m),
                ):
                    continue
                
                color, cconf = decide_color(patch, core_m, ring_m, ring_sec, thr)
                if color != EMPTY:
                    board[row, col] = color
                    conf[row, col] = float(min(0.5, cconf))
                    outline_hits += 1
                    continue
                
                inner = patch[inner_m]
                ring = patch[out_ring_m]
                if inner.size == 0 or ring.size == 0:
                    continue
                
                if float(np.percentile(np.abs(inner), 90)) >= thr:
                    continue
                dark = float(np.mean(ring < -thr))
                bright = float(np.mean(ring > thr))
                if dark >= 0.45 and bright < 0.15:
                    board[row, col] = WHITE        
                    conf[row, col] = 0.45
                    outline_hits += 1
                elif bright >= 0.45 and dark < 0.15:
                    board[row, col] = BLACK        
                    conf[row, col] = 0.45
                    outline_hits += 1

    removed = strip_border_artifacts(board, conf)
    diag = {
        "method": "adaptive",
        "threshold": round(thr, 2),
        "noise_sigma": round(sigma, 2),
        "cell_contrast_hits": cell_hits,
        "cell_rescued": cell_rescued,
        "blob_hits": hits,
        "outline_hits": outline_hits,
        "border_artifacts": removed,
    }
    diag.update(invariants(board))
    if _dump_fp is not None:
        for _r in range(n):
            for _c in range(n):
                if board[_r, _c] != EMPTY:
                    _dump_fp.write('n=%d r=%d c=%d SET=%d lc=%.2f fill=%.3f\n'
                                   % (n, _r, _c, board[_r, _c],
                                      float(cell_stat[_r, _c]), float(cell_fill[_r, _c])))
        _dump_fp.close()
    return board, conf, diag

def auto_canny(gray: np.ndarray, sigma: float = 0.33) -> np.ndarray:
    """OpenCV 官方推荐的自动 Canny 阈值（基于灰度中位数）。"""
    v = float(np.median(gray))
    lo = int(max(0, (1.0 - sigma) * v))
    hi = int(min(255, (1.0 + sigma) * v))
    return cv2.Canny(gray, lo, hi, apertureSize=3)

def _fit_lattice(positions, count: int):
    """把检测到的线位置拟合成「等距 count 线」模型 o + k·d。

    步骤（RANSAC 思路，避免 ICP 从错误初值陷局部最优——实测深色主题下
    朴素 ICP 会停在「步距 76、原点偏 30px」的假网格上）：
      1. 合并同一条线的多条 Canny 边缘（容差 = 检测跨度的 1%）；
      2. 候选格距 = 相邻间隔的众数，并考虑其 1/2、1/3（可能有整条线漏检）；
      3. 以「最多模型线能落在检测线上」为目标选原点（内点计数），再做最小二乘 + ICP 精修。

    返回 (offset, spacing, normalized_residual) 或 None；残差以格距为单位。
    """
    p = np.sort(np.asarray(positions, dtype=float))
    if p.size < 4:
        return None
    span = float(p[-1] - p[0])
    if span < 10.0:
        return None
    tol = max(2.0, span * 0.01)
    merged = [float(p[0])]
    for v in p[1:]:
        if float(v) - merged[-1] <= tol:
            merged[-1] = (merged[-1] + float(v)) / 2.0
        else:
            merged.append(float(v))
    m = np.asarray(merged, dtype=float)
    if m.size < max(4, int(count * 0.5)):
        return None
    gaps = np.round(np.diff(m)).astype(int)
    gaps = gaps[gaps >= 3]
    if gaps.size == 0:
        return None
    vals, cnts = np.unique(gaps, return_counts=True)
    base = float(vals[int(np.argmax(cnts))])

    best = None
    for o0 in m:
        k = np.round((m - float(o0)) / base)
        if np.unique(k).size < m.size * 0.8:
            continue
        slope, intercept = np.polyfit(k, m, 1)
        if slope <= 1.0:
            continue
        resid = float(np.mean(np.abs(m - (intercept + slope * k)))) / slope
        if best is None or resid < best[0]:
            best = (resid, float(intercept), float(slope))
    if best is None:
        return None
    _, o, d = best

    for _ in range(4):
        model = o + d * np.arange(count)
        dist = np.abs(m[None, :] - model[:, None]).min(axis=1)
        sel = dist < d * 0.3
        if int(sel.sum()) < count * 0.5:
            return None
        idx = np.abs(m[None, :] - model[:, None]).argmin(axis=1)[sel]
        if np.unique(idx).size < int(sel.sum()) * 0.8:
            return None
        claimed = m[idx]
        slope, intercept = np.polyfit(np.arange(count)[sel], claimed, 1)
        if abs(slope - d) < 1e-3 and abs(intercept - o) < 1e-3:
            o, d = float(intercept), float(slope)
            break
        o, d = float(intercept), float(slope)
    if d <= 1.0:
        return None
    model = o + d * np.arange(count)
    resid = float(np.mean(np.abs(m[np.abs(m[None, :] - model[:, None]).argmin(axis=1)] - model))) / d
    return o, d, resid

def _line_evidence(gray: np.ndarray, pos: int, axis: int, d: float, W: int, H: int) -> float:
    """候选线上的「线感」强度 = |线上中位数 − 两侧背景中位数|（极性无关）。

    用中位数而非均值：网格线只有 1~2px，初定位常有 ±2px 误差，且线会被棋子/装饰遮挡，
    中位数只反映该位置的主体颜色，对穿过的棋子完全免疫。
    """
    off = max(4, int(d * 0.3))
    if axis == 0:
        if pos - off < 0 or pos + off >= W:
            return 0.0
        on = float(np.median(gray[:, pos]))
        bg = (float(np.median(gray[:, pos - off])) + float(np.median(gray[:, pos + off]))) / 2.0
    else:
        if pos - off < 0 or pos + off >= H:
            return 0.0
        on = float(np.median(gray[pos, :]))
        bg = (float(np.median(gray[pos - off, :])) + float(np.median(gray[pos + off, :]))) / 2.0
    return abs(on - bg)

def _snap_lattice(gray, o: float, d: float, count: int, axis: int, W: int, H: int) -> float:
    """确定等距格的整体对齐（原点）。

    **关键**：等距格整体平移整数倍格距后，拟合残差完全相同 —— 拟合出的原点只是这条
    「等价格」上的任意一点（实测会落在棋盘中间某条线上），所以必须在**整个画布范围**
    枚举所有能完整落进画布的对齐，而不能只在初值附近 ±1 格搜索（那样会整体错好几格，
    整盘棋子串行错位）。判别顺序：
      1. 像素级线感证据（外侧线到底存不存在）——并列时它无法判别（被棋子/装饰遮住的线两头都弱）；
      2. **网格居中**：canvas 手绘棋盘几乎都把网格在画布里居中（cell=w/(N+1.2)、
         margin=1.1·cell 是通用画法），据此在并列候选里唯一定位。
    """
    span = float(W if axis == 0 else H)
    center = span / 2.0
    total = (count - 1) * d
    if d <= 1.0:
        return o
    cands = []
    t_lo = int(np.floor((-2.0 - o) / d))
    t_hi = int(np.ceil((span + 2.0 - total - o) / d))
    for t in range(t_lo, t_hi + 1):
        oo = o + t * d
        arr = oo + d * np.arange(count)
        if arr[0] < -2 or arr[-1] > span + 2:
            continue
        strong = sum(1 for v in arr if _line_evidence(gray, int(round(v)), axis, d, W, H) > 6.0)
        drift = abs((arr[0] + arr[-1]) / 2.0 - center)
        cands.append((strong, -drift, oo))
    if not cands:
        return o, 0
    best_strong = max(c[0] for c in cands)
    tied = [c for c in cands if c[0] >= best_strong]
    tied.sort(key=lambda c: c[1], reverse=True)      
    return tied[0][2], best_strong

def locate_grid_hough(gray: np.ndarray, line_count: int = 15):
    """Hough 网格定位兜底：投影法置信度低/失败时启用。返回 (xs, ys, residual) 或 None。"""
    edges = auto_canny(gray)
    h, w = gray.shape
    min_len = min(h, w) * 0.35
    segs = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=60,
        minLineLength=int(min_len), maxLineGap=int(min_len * 0.04),
    )
    if segs is None:
        return None
    vx, hy = [], []
    for s in np.asarray(segs, dtype=np.float64).reshape(-1, 4):
        x1, y1, x2, y2 = (float(v) for v in s)
        ang = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        if ang < 6.0:
            hy.append((y1 + y2) / 2.0)
        elif abs(ang - 90.0) < 6.0:
            vx.append((x1 + x2) / 2.0)
    fx = _fit_lattice(vx, line_count)
    fy = _fit_lattice(hy, line_count)
    if not fx or not fy:
        return None
    ox, strong_x = _snap_lattice(gray, fx[0], fx[1], line_count, 0, w, h)
    oy, strong_y = _snap_lattice(gray, fy[0], fy[1], line_count, 1, w, h)
    
    if min(strong_x, strong_y) < line_count * 0.5:
        return None
    xs = ox + fx[1] * np.arange(line_count)
    ys = oy + fy[1] * np.arange(line_count)
    if xs[0] < -2 or ys[0] < -2 or xs[-1] > w + 2 or ys[-1] > h + 2:
        return None

    def _score(positions, arr, d):
        p = np.asarray(positions, dtype=float)
        if p.size == 0 or d <= 1.0:
            return 1.0, 0.0
        dist = np.abs(p[None, :] - arr[:, None]).min(axis=1)
        hit = dist < d * 0.3
        ratio = float(np.mean(hit))
        resid = float(np.mean(dist[hit])) / d if hit.any() else 1.0
        return resid, ratio

    rx, mx = _score(vx, xs, fx[1])
    ry, my = _score(hy, ys, fy[1])
    if (mx + my) / 2.0 < 0.5:
        return None
    return xs, ys, (rx + ry) / 2.0
