// gbscreen.cpp —— screen_board.py 的 C++ 移植（整屏找盘 + 抓屏）
// =====================================================================
// 与网页注入路线的区别：这里没有 DOM，输入是**整屏截图**，棋盘只是屏幕上一小块。
// 因此第一步必须是「在整屏里把棋盘找出来」，之后复用自适应读子。
//
// 抓屏从 PIL.ImageGrab 换成 GDI BitBlt（多显示器虚拟屏 + DPI 感知），
// 语义完全对齐：返回 (RGB, 虚拟屏原点偏移)。
#include "gbvision.h"

#include <windows.h>
#include <shellscalingapi.h>
#include <cmath>
#include <limits>

namespace gb {

namespace {

inline int iRound(double v) { return (int)std::nearbyint(v); }
inline double npRound(double v) { return std::nearbyint(v); }

int screenOx = 0, screenOy = 0;

// ---------------------------------------------------------------- 抓屏

BOOL CALLBACK enumMonitorProc(HMONITOR, HDC, LPRECT, LPARAM) { return TRUE; }

}  // namespace

/**
 * 让抓屏与窗口坐标都用**物理像素**（否则系统缩放 125%/150% 时坐标会错位）。
 * 覆盖层窗口同样设置 DPI awareness，两侧必须一致，否则框会偏移。
 */
void setDpiAware() {
    static bool done = false;
    if (done) return;
    done = true;
    typedef BOOL(WINAPI * SetCtxFn)(DPI_AWARENESS_CONTEXT);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (user32) {
        auto fn = (SetCtxFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
        if (fn && fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return;
        typedef BOOL(WINAPI * SetAwareFn)();
        auto fn2 = (SetAwareFn)GetProcAddress(user32, "SetProcessDPIAware");
        if (fn2 && fn2()) return;
    }
    typedef HRESULT(WINAPI * SetShcoreFn)(int);
    HMODULE shcore = LoadLibraryW(L"shcore.dll");
    if (shcore) {
        auto fn = (SetShcoreFn)GetProcAddress(shcore, "SetProcessDpiAwareness");
        if (fn) fn(2);   // PROCESS_PER_MONITOR_DPI_AWARE
    }
}

bool captureScreen(cv::Mat& rgb, int& ox, int& oy) {
    setDpiAware();
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vw <= 0 || vh <= 0) return false;

    HDC screen = GetDC(NULL);
    if (!screen) return false;
    HDC mem = CreateCompatibleDC(screen);
    HBITMAP bmp = CreateCompatibleBitmap(screen, vw, vh);
    if (!mem || !bmp) {
        if (bmp) DeleteObject(bmp);
        if (mem) DeleteDC(mem);
        ReleaseDC(NULL, screen);
        return false;
    }
    HGDIOBJ old = SelectObject(mem, bmp);
    // CAPTUREBLT：把分层窗口（我们自己的覆盖层）也拍进来 —— 与 PIL 行为一致，
    // 覆盖层自己的窗口靠 exclude 抹掉，而不是指望系统不拍。
    BOOL ok = BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, SRCCOPY | CAPTUREBLT);

    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = vw;
    bi.bmiHeader.biHeight = -vh;          // 负 = top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    cv::Mat bgra(vh, vw, CV_8UC4);
    int got = 0;
    if (ok) got = GetDIBits(mem, bmp, 0, (UINT)vh, bgra.data, &bi, DIB_RGB_COLORS);

    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    if (!ok || got == 0) return false;

    rgb.create(vh, vw, CV_8UC3);
    for (int r = 0; r < vh; ++r) {
        const uint8_t* sp = bgra.ptr<uint8_t>(r);
        uint8_t* dp = rgb.ptr<uint8_t>(r);
        for (int c = 0; c < vw; ++c) {
            dp[c * 3 + 0] = sp[c * 4 + 2];   // R
            dp[c * 3 + 1] = sp[c * 4 + 1];   // G
            dp[c * 3 + 2] = sp[c * 4 + 0];   // B
        }
    }
    ox = vx;
    oy = vy;
    screenOx = vx;
    screenOy = vy;
    return true;
}

// =====================================================================
// 找盘
// =====================================================================

namespace {

struct Cluster { double mean; double len; double lo; double hi; };

std::vector<Cluster> clusterSegments(const std::vector<double>& vals, double tol) {
    std::vector<Cluster> out;
    if (vals.empty()) return out;
    std::vector<double> v = vals;
    std::sort(v.begin(), v.end());
    std::vector<double> cur{v[0]};
    for (size_t i = 1; i < v.size(); ++i) {
        if (v[i] - cur.back() <= tol) cur.push_back(v[i]);
        else {
            out.push_back({mean(cur), 0.0, 0.0, 0.0});
            cur.assign(1, v[i]);
        }
    }
    out.push_back({mean(cur), 0.0, 0.0, 0.0});
    return out;
}

/** 聚簇时保留每簇的**线段总长度**，以及该簇在另一轴上的覆盖区间 [lo,hi] */
std::vector<Cluster> weightedClusters(std::vector<double> vals, std::vector<double> lens,
                                      std::vector<std::pair<double, double>> exts, double tol) {
    std::vector<Cluster> out;
    if (vals.empty()) return out;
    std::vector<int> order = argsort(vals);
    std::vector<double> curV{vals[order[0]]}, curL{lens[order[0]]};
    std::vector<std::pair<double, double>> curE{exts[order[0]]};
    for (size_t k = 1; k < order.size(); ++k) {
        int i = order[k];
        if (vals[i] - curV.back() <= tol) {
            curV.push_back(vals[i]);
            curL.push_back(lens[i]);
            curE.push_back(exts[i]);
        } else {
            double lo = curE[0].first, hi = curE[0].second, lenSum = 0;
            for (auto& e : curE) { lo = std::min(lo, e.first); hi = std::max(hi, e.second); }
            for (double l : curL) lenSum += l;
            out.push_back({mean(curV), lenSum, lo, hi});
            curV.assign(1, vals[i]);
            curL.assign(1, lens[i]);
            curE.assign(1, exts[i]);
        }
    }
    {
        double lo = curE[0].first, hi = curE[0].second, lenSum = 0;
        for (auto& e : curE) { lo = std::min(lo, e.first); hi = std::max(hi, e.second); }
        for (double l : curL) lenSum += l;
        out.push_back({mean(curV), lenSum, lo, hi});
    }
    return out;
}

/**
 * 屏幕内容的自适应 Canny：阈值由**梯度幅值的 Otsu 二值化**决定。
 * 两个坑都踩过：
 *   · 沿用灰度中位数 → 中位数就是底色（浅底棋盘 ~234），下阈值被抬到 160，
 *     棋盘线对比度仅几十灰阶 → 边缘全被吞掉；
 *   · 改用梯度幅值的固定分位 → 屏幕大面是平坦底色，88 分位仍落在平坦区（≈0），
 *     阈值 <8 → **一条边都没有**。
 */
cv::Mat cannyScreen(const cv::Mat& gray, double ratio = 0.40) {
    cv::Mat g, gx, gy;
    cv::GaussianBlur(gray, g, cv::Size(3, 3), 0);
    cv::Sobel(g, gx, CV_32F, 1, 0, 3);
    cv::Sobel(g, gy, CV_32F, 0, 1, 3);
    cv::Mat mag;
    cv::add(cv::abs(gx), cv::abs(gy), mag);
    std::vector<double> all;
    all.reserve((size_t)mag.rows * mag.cols);
    for (int r = 0; r < mag.rows; ++r) {
        const float* p = mag.ptr<float>(r);
        for (int c = 0; c < mag.cols; ++c) all.push_back((double)p[c]);
    }
    double mx = percentile(std::move(all), 99.5);
    if (mx <= 1e-6) return cv::Mat::zeros(gray.size(), CV_8U);

    cv::Mat m8(mag.rows, mag.cols, CV_8U);
    for (int r = 0; r < mag.rows; ++r) {
        const float* sp = mag.ptr<float>(r);
        uint8_t* dp = m8.ptr<uint8_t>(r);
        for (int c = 0; c < mag.cols; ++c) {
            double v = (double)sp[c] / mx * 255.0;
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            dp[c] = (uint8_t)v;          // astype(uint8) = 截断
        }
    }
    double t = cv::threshold(m8, m8, 0, 255, cv::THRESH_BINARY + cv::THRESH_OTSU);
    double hi = t / 255.0 * mx;
    if (hi < 4.0) hi = std::max(8.0, mx * 0.35);
    double lo = std::max(4.0, hi * ratio);
    cv::Mat edges;
    cv::Canny(gray, edges, lo, hi);
    return edges;
}

void collectLines(const cv::Mat& gray, double minLen, std::vector<Cluster>& hOut,
                  std::vector<Cluster>& vOut, int maxGap = 6, int thresh = 80) {
    hOut.clear();
    vOut.clear();
    cv::Mat edges = cannyScreen(gray);
    std::vector<cv::Vec4i> lines;
    cv::HoughLinesP(edges, lines, 1.0, CV_PI / 180.0, thresh, (int)minLen, maxGap);
    if (lines.empty()) return;
    std::vector<double> hV, vV, hL, vL;
    std::vector<std::pair<double, double>> hE, vE;
    for (const cv::Vec4i& s : lines) {
        double x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
        double dx = std::abs(x2 - x1), dy = std::abs(y2 - y1);
        double ln = std::hypot(dx, dy);
        if (dx >= dy) {
            hV.push_back((y1 + y2) / 2.0);
            hL.push_back(ln);
            hE.push_back({std::min(x1, x2), std::max(x1, x2)});
        } else {
            vV.push_back((x1 + x2) / 2.0);
            vL.push_back(ln);
            vE.push_back({std::min(y1, y2), std::max(y1, y2)});
        }
    }
    hOut = weightedClusters(hV, hL, hE, 3.0);
    vOut = weightedClusters(vV, vL, vE, 3.0);
}

struct Family {
    std::vector<double> pos;
    double len = 0;
    double step = 0;
    double score = 0;
    double lo = 0;
    double hi = 0;
};

/**
 * 在一维线簇里找「近似等间距」的若干线族（按得分取前 topk）。
 * ⚠️ 必须返回**多个候选**而不是只留最优：网页上的文字行也是等间距平行线。
 */
std::vector<Family> arithmeticCandidates(const std::vector<Cluster>& clusters,
                                         int minCount, double maxStep) {
    std::vector<Family> cands;
    if ((int)clusters.size() < minCount) return cands;
    // 只保留较长的簇；门槛必须相对**最长线**取（0.15），不能用「分位×0.5」
    std::vector<double> lens;
    for (auto& c : clusters) lens.push_back(c.len);
    double maxLen = lens.empty() ? 0 : *std::max_element(lens.begin(), lens.end());
    double thrLen = maxLen * 0.15;
    std::vector<Cluster> cand;
    for (auto& c : clusters) if (c.len >= thrLen) cand.push_back(c);
    if ((int)cand.size() < minCount) cand = clusters;

    int n = (int)cand.size();
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n && j < i + 40; ++j) {
            double d = (cand[j].mean - cand[i].mean) / double(j - i);
            if (d < 8.0 || d > maxStep) continue;
            double tol = std::max(2.5, d * 0.06);
            std::vector<double> seq{cand[i].mean, cand[j].mean};
            std::vector<double> tot{cand[i].len, cand[j].len};
            std::vector<Cluster> idx{cand[i], cand[j]};
            double expect = cand[j].mean + d;
            int k = j + 1;
            while (k < n) {
                double df = cand[k].mean - expect;
                if (std::abs(df) <= tol) {
                    seq.push_back(cand[k].mean);
                    tot.push_back(cand[k].len);
                    idx.push_back(cand[k]);
                    expect = cand[k].mean + d;
                } else if (df > tol) {
                    // 可能整段缺失（被棋子/窗口遮挡）：允许跳过 m 格后再接上。
                    // ⚠️ 若这里直接 break，棋盘上只要有一条线没检出来，族就凑不齐。
                    int m = iRound(df / d);
                    if (m >= 1 && std::abs(cand[k].mean - (expect + m * d)) <= tol) {
                        seq.push_back(cand[k].mean);
                        tot.push_back(cand[k].len);
                        idx.push_back(cand[k]);
                        expect = cand[k].mean + d;
                    } else break;
                }
                k++;
            }
            if ((int)seq.size() >= minCount) {
                double ls = 0, los = 1e300, his = -1e300;
                for (double t : tot) ls += t;
                for (auto& c : idx) { los = std::min(los, c.lo); his = std::max(his, c.hi); }
                Family f;
                f.pos = seq;
                f.len = ls / (double)tot.size();
                f.step = d;
                f.score = (double)seq.size() * (ls / (double)tot.size());
                f.lo = los;
                f.hi = his;
                cands.push_back(f);
            }
        }
    }
    std::stable_sort(cands.begin(), cands.end(),
                     [](const Family& a, const Family& b) { return a.score > b.score; });
    return cands;
}

std::vector<Family> findArithmeticFamilies(const std::vector<Cluster>& clusters,
                                           int minCount = 8, double maxStep = 260.0,
                                           int topk = 6) {
    std::vector<Family> fams = arithmeticCandidates(clusters, minCount, maxStep);
    std::vector<Family> out;
    for (auto& f : fams) {
        bool dup = false;
        for (auto& g : out) {
            // 不同公差可能圈出高度重叠的同一批线（如 d=74 与 d=148 的两倍关系）
            std::vector<double> a, b;
            for (double v : f.pos) a.push_back(npRound(v * 10.0) / 10.0);
            for (double v : g.pos) b.push_back(npRound(v * 10.0) / 10.0);
            std::sort(a.begin(), a.end());
            std::sort(b.begin(), b.end());
            std::vector<double> inter;
            std::set_intersection(a.begin(), a.end(), b.begin(), b.end(),
                                  std::back_inserter(inter));
            size_t mn = std::min(a.size(), b.size());
            if (!mn && inter.empty()) { dup = true; break; }
            if ((double)inter.size() >= 0.7 * (double)mn) { dup = true; break; }
        }
        if (!dup) out.push_back(f);
        if ((int)out.size() >= topk) break;
    }
    return out;
}

/** 把线族按每 m 个取一个（等价于格距 ×m）—— 文字行混进棋盘线族时的救命招 */
bool subsampleFamily(const Family& fam, int m, Family& out) {
    if (m <= 1) { out = fam; return true; }
    Family f;
    for (size_t i = 0; i < fam.pos.size(); i += m) f.pos.push_back(fam.pos[i]);
    if (f.pos.size() < 6) return false;
    f.step = fam.step * m;
    f.len = fam.len;
    f.lo = fam.lo;
    f.hi = fam.hi;
    out = f;
    return true;
}

struct BoardCand {
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    double step = 0;
    std::vector<double> vx, hy;
    double score = 0;
    int size = 0;
    double scale = 1.0;
};

bool pairOnce(const Family& hy, const Family& vx, int gw, int gh, double sc,
              BoardCand& out) {
    double dx = vx.step, dy = hy.step;
    if (dx <= 0 || dy <= 0) return false;
    if (std::abs(dx - dy) / std::max(dx, dy) > 0.12) return false;   // 格必须是正方形
    double x0 = *std::min_element(vx.pos.begin(), vx.pos.end());
    double x1 = *std::max_element(vx.pos.begin(), vx.pos.end());
    double y0 = *std::min_element(hy.pos.begin(), hy.pos.end());
    double y1 = *std::max_element(hy.pos.begin(), hy.pos.end());
    // 交叉验证：竖线要穿过横线的分布区间，横线也要穿过竖线的分布区间
    if (hy.hi > hy.lo && vx.hi > vx.lo) {
        double interX = std::min(x1, hy.hi) - std::max(x0, hy.lo);
        double interY = std::min(y1, vx.hi) - std::max(y0, vx.lo);
        if (interX < 0.35 * std::min(x1 - x0, hy.hi - hy.lo)) return false;
        if (interY < 0.35 * std::min(y1 - y0, vx.hi - vx.lo)) return false;
    }
    double area = std::max(1.0, (x1 - x0) * (y1 - y0));
    if (area < 0.008 * gw * gh || area > 0.98 * gw * gh) return false;
    double gshort = std::min(gw, gh);
    int n = (int)vx.pos.size() + (int)hy.pos.size();
    double relLen = (vx.len + hy.len) * 0.5 / std::max(1.0, gshort);
    out.x0 = x0 / sc; out.y0 = y0 / sc; out.x1 = x1 / sc; out.y1 = y1 / sc;
    out.step = (dx + dy) * 0.5 / sc;
    out.vx.resize(vx.pos.size());
    for (size_t i = 0; i < vx.pos.size(); ++i) out.vx[i] = vx.pos[i] / sc;
    out.hy.resize(hy.pos.size());
    for (size_t i = 0; i < hy.pos.size(); ++i) out.hy[i] = hy.pos[i] / sc;
    out.score = n * 100.0 + relLen * 60.0;
    out.size = iRound(std::max(vx.pos.size(), hy.pos.size()));
    out.scale = sc;
    return true;
}

bool pairFamilies(const Family& hy, const Family& vx, int gw, int gh, double sc,
                  BoardCand& best) {
    double dx0 = vx.step, dy0 = hy.step;
    if (dx0 <= 0 || dy0 <= 0) return false;
    double ratio = dx0 / dy0;
    bool have = false;
    for (int who = 0; who < 3; ++who) {
        Family hy2 = hy, vx2 = vx;
        if (who == 1) {   // 水平族间距偏小 → 抽稀
            int m = dy0 > dx0 ? iRound(dy0 / dx0) : iRound(ratio);
            if (!(m >= 2 && m <= 4)) continue;
            if (!subsampleFamily(hy, m, hy2)) continue;
        } else if (who == 2) {
            int m = dx0 > dy0 ? iRound(dx0 / dy0) : iRound(1.0 / ratio);
            if (!(m >= 2 && m <= 4)) continue;
            if (!subsampleFamily(vx, m, vx2)) continue;
        }
        BoardCand c;
        if (pairOnce(hy2, vx2, gw, gh, sc, c))
            if (!have || c.score > best.score) { best = c; have = true; }
    }
    return have;
}

double rectOverlapRatio(const BoardCand& a, const BoardCand& b) {
    double ix = std::min(a.x1, b.x1) - std::max(a.x0, b.x0);
    double iy = std::min(a.y1, b.y1) - std::max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) return 0.0;
    double inter = ix * iy;
    double smaller = std::min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    return smaller > 1e-6 ? inter / smaller : 0.0;
}

/** 数一数候选里到底有几个**互相不重叠**的棋盘 */
int countDistinctBoards(const std::vector<BoardCand>& tops, double scoreRatio = 0.55,
                        double overlap = 0.5) {
    if (tops.empty()) return 0;
    double bestScore = tops[0].score != 0 ? tops[0].score : 1.0;
    std::vector<BoardCand> picked;
    for (auto& c : tops) {
        if (c.score < bestScore * scoreRatio) continue;
        bool dup = false;
        for (auto& p : picked) if (rectOverlapRatio(c, p) >= overlap) { dup = true; break; }
        if (!dup) picked.push_back(c);
    }
    return (int)picked.size();
}

/**
 * 在整幅（屏幕）图里找棋盘。
 * **分辨率/尺寸无关**（2K/3K/4K、16:9/4:3、小窗口/全屏同一套）：
 * 一切阈值都取相对量；多尺度搜索（1.0/0.6）；多档最小线长（短边 ×5%/×10%）；
 * 横竖族必须真实交叉（网页文字行也是等距平行线）。
 */
std::vector<BoardCand> findBoardRects(const cv::Mat& gray, int lineCount,
                                      int minLines = 8, int topn = 1,
                                      const std::vector<double>& scales = {1.0, 0.6},
                                      const std::vector<double>& lenRatios = {0.05, 0.10}) {
    int H = gray.rows, W = gray.cols;
    std::vector<BoardCand> cands;
    for (double sc : scales) {
        cv::Mat g;
        if (sc == 1.0) g = gray;
        else {
            int nw = std::max(64, (int)(W * sc)), nh = std::max(64, (int)(H * sc));
            cv::resize(gray, g, cv::Size(nw, nh), 0, 0, cv::INTER_AREA);
        }
        int gw = g.cols, gh = g.rows;
        double gshort = (double)std::min(gw, gh);
        double maxStep = gshort * 0.25;
        for (double lr : lenRatios) {
            double minLen = std::max(20.0, gshort * lr);
            std::vector<Cluster> hc, vc;
            collectLines(g, minLen, hc, vc);
            if (hc.empty() || vc.empty()) continue;
            std::vector<Family> hFams = findArithmeticFamilies(hc, minLines, maxStep);
            std::vector<Family> vFams = findArithmeticFamilies(vc, minLines, maxStep);
            for (auto& hy : hFams)
                for (auto& vx : vFams) {
                    BoardCand c;
                    if (pairFamilies(hy, vx, gw, gh, sc, c)) cands.push_back(c);
                }
        }
    }
    if (cands.empty()) return {};
    std::stable_sort(cands.begin(), cands.end(),
                     [](const BoardCand& a, const BoardCand& b) { return a.score > b.score; });
    int take = std::max(1, topn);
    if ((int)cands.size() > take) cands.resize(take);
    return cands;
}

struct RefineResult {
    bool ok = false;
    std::vector<double> xLines, yLines;
    double spacing = 0;
    std::string source;
    int ox = 0, oy = 0;
};

/**
 * 「锚点外推」找回完整盘面窗口（2026-09-27）
 *
 * ★ 病例（用户报：「子数多的时候识别失败」）：一张 15×15 密子截图，粗定位只锁到
 *   竖族 13/15、横族 8/15 —— 密子把连续网线打断，`arithmeticCandidates` 凑不齐族。
 *   于是 x 方向铺满全宽（996px）而 y 方向只有半截（498px），refineGrid 裁出一个
 *   1209×711 的扁长条，`locateBoard` 的方形门（0.68 ≤ w/h ≤ 1.47）把它挡在门外
 *   → candidates=0 → no-grid。**两种获取员的根系完好**，只是窗口不对。
 *
 * 这里不再追问「窗口为什么不够方」，而是直接回答「棋盘到底在哪」：
 *   已经锁定的那几条线是真货（入口 `pairOnce` 已做过横竖交叉验证），
 *   配上步长 step 与路数 want，把缺的 (want - m) 条按 a:b 分给两端补齐，
 *   每种分法都给出一个「盘面Edge→Edge」的完整窗口。
 */
static void fullBoardSpans(const std::vector<double>& lines, int want, double step,
                           std::vector<std::pair<double, double>>& out) {
    out.clear();
    if (lines.empty() || want < 3 || step <= 0) return;
    std::vector<double> p = lines;
    std::sort(p.begin(), p.end());
    int m = (int)p.size();
    int miss = want - m;
    if (miss <= 0) {
        // 族比盘面还长（family 串进了盘外的平行线）：取任意连续 want 条作为盘面
        for (int k = 0; k + want <= m; ++k) out.emplace_back(p[k], p[k + want - 1]);
        return;
    }
    for (int a = 0; a <= miss; ++a) out.emplace_back(p.front() - a * step, p.back() + (miss - a) * step);
}

/** 1 − 间距变异系数：越接近 1 说明这组线越等距 */
static double evenness(const std::vector<double>& v) {
    std::vector<double> d = diff(v);
    if (d.empty()) return 0.0;
    double m = mean(d);
    if (m <= 0) return 0.0;
    return std::min(1.0, std::max(0.0, 1.0 - stddev(d) / m));
}

/** 精定位结果与粗定位那几条线的重合度 —— 防止外推窗口回答了「另一个棋盘」 */
static double coarseAgree(const std::vector<double>& fitted,
                          const std::vector<double>& coarse, double step) {
    if (coarse.empty() || fitted.empty()) return 0.0;
    double tol = std::max(6.0, step * 0.35);
    int hit = 0;
    for (double c : coarse) {
        double best = 1e300;
        for (double f : fitted) best = std::min(best, std::abs(f - c));
        if (best <= tol) hit++;
    }
    return (double)hit / (double)coarse.size();
}

/** 把粗定位的候选区域裁出来，用既有逻辑精确定位 size×size 的网格线 */
RefineResult refineGrid(const cv::Mat& rgb, const BoardCand& cand, int size) {
    RefineResult out;
    int H = rgb.rows, W = rgb.cols;
    double step = cand.step;
    double pad = step * 1.5;
    int ax0 = std::max(0, (int)(cand.x0 - pad));
    int ay0 = std::max(0, (int)(cand.y0 - pad));
    int ax1 = std::min(W, (int)(cand.x1 + pad));
    int ay1 = std::min(H, (int)(cand.y1 + pad));
    if (ax1 <= ax0 || ay1 <= ay0) return out;
    cv::Mat crop = rgb(cv::Rect(ax0, ay0, ax1 - ax0, ay1 - ay0));
    cv::Mat g;
    cv::cvtColor(crop, g, cv::COLOR_RGB2GRAY);

    std::vector<double> xs, ys;
    bool have = false;
    double spacing = step;
    std::string source = "?";
    const bool trace = getenv("GB_VISION_TRACE") != nullptr;
    if (trace) {
        fprintf(stderr, "[trace] refineGrid cand vx=%d hy=%d size=%d step=%.3f "
                        "x0=%.1f x1=%.1f y0=%.1f y1=%.1f cropwin=(%d,%d)-(%d,%d)\n",
                (int)cand.vx.size(), (int)cand.hy.size(), cand.size, step,
                cand.x0, cand.x1, cand.y0, cand.y1, ax0, ay0, ax1, ay1);
    }
    // ① 既有投影法（找暗线，适合浅底棋盘）
    try {
        Geometry bg = locateBoard(crop, size);
        if (trace) {
            fprintf(stderr, "[trace] refineGrid crop=%dx%d at(%d,%d) step=%.2f locateBoard x=%d y=%d conf=%.3f src=%s\n",
                    crop.cols, crop.rows, ax0, ay0, step,
                    (int)bg.x_lines.size(), (int)bg.y_lines.size(), bg.confidence, bg.source.c_str());
        }
        if ((int)bg.x_lines.size() == size && (int)bg.y_lines.size() == size) {
            xs = bg.x_lines;
            ys = bg.y_lines;
            spacing = bg.spacing();
            source = "projection";
            have = true;
        }
    } catch (const std::exception& e) {
        if (trace) fprintf(stderr, "[trace] locateBoard threw: %s\n", e.what());
    } catch (...) {
        if (trace) fprintf(stderr, "[trace] locateBoard threw (unknown)\n");
    }
    // ② 深色/亮线棋盘：Hough 兜底
    if (!have) {
        std::vector<double> hx, hy;
        double res = 0;
        try {
            bool okH = locateGridHough(g, size, hx, hy, res);
            if (trace) fprintf(stderr, "[trace] hough ok=%d x=%d y=%d res=%.3f\n",
                               (int)okH, (int)hx.size(), (int)hy.size(), res);
            if (okH &&
                (int)hx.size() == size && (int)hy.size() == size) {
                xs = hx; ys = hy;
                spacing = size > 1 ? mean(diff(xs)) : spacing;
                source = "hough";
                have = true;
            }
        } catch (const std::exception& e) {
            if (trace) fprintf(stderr, "[trace] hough threw: %s\n", e.what());
        } catch (...) {
            if (trace) fprintf(stderr, "[trace] hough threw (unknown)\n");
        }
    }
    // ③ 锚点外推：①② 都拼不齐 size 条线时，用「已锁定的线 + 步长 + 路数」把完整盘面
    //    窗口算回来再精定位（密子把网线打断 → 粗定位只能抓到半个盘时的主修法）。
    //
    //    窗口外扩口径与 `cropBoard` 完全一致 —— **边界线再往外「半格 + 边长/30」**
    //    （2026-09-25 用户要求：「悄悄地从棋盘边界向外延伸出棋盘的 1/30 的距离，
    //    这样的话能识别边缘的子」）。①② 用的 step*1.5 只是临时观察窗，
    //    这一步才按正式口径留余量，压在边界线上的整颗子都在窗口里。
    if (!have) {
        std::vector<std::pair<double, double>> xsp, ysp;
        fullBoardSpans(cand.vx, size, step, xsp);
        fullBoardSpans(cand.hy, size, step, ysp);
        double spanGuess = std::max(0.0, step * (size - 1));
        double padG = step * 0.5 + spanGuess / 30.0;
        if (padG < step * 0.5) padG = step * 0.5;
        const int budget = 36;      // 两种路数同时缺线最多 8×12 种分法，取前 36 种足够覆盖真实缺陷
        double bestScore = -1.0;
        int tried = 0;
        for (auto& sx : xsp) {
            for (auto& sy : ysp) {
                if (++tried > budget) break;
                // 补出来的那几条**边线本身**必须还在图里（外侧余量被图边裁掉无所谓），
                // 否则这个分法说的盘面一半在屏幕外 —— 视觉上不可能存在，直接剪掉。
                double edge = step * 0.5;
                if (sx.first < edge || sy.first < edge ||
                    sx.second > W - 1 - edge || sy.second > H - 1 - edge) continue;
                int wx0 = std::max(0, (int)std::floor(sx.first - padG));
                int wy0 = std::max(0, (int)std::floor(sy.first - padG));
                int wx1 = std::min(W - 1, (int)std::ceil(sx.second + padG));
                int wy1 = std::min(H - 1, (int)std::ceil(sy.second + padG));
                if (wx1 - wx0 + 1 < size * 4 || wy1 - wy0 + 1 < size * 4) continue;
                for (int lock = 0; lock < 2; ++lock) {
                    Geometry bg;
                    try {
                        bg = geometryFromRect(rgb, wx0, wy0, wx1, wy1, size,
                                              "anchor", lock == 1);
                    } catch (...) { continue; }
                    if ((int)bg.x_lines.size() != size || (int)bg.y_lines.size() != size) continue;
                    double xSpan = bg.x_lines.back() - bg.x_lines.front();
                    double ySpan = bg.y_lines.back() - bg.y_lines.front();
                    if (xSpan <= 0 || ySpan <= 0) continue;
                    double aspect = std::min(xSpan / ySpan, ySpan / xSpan);
                    double regularity = std::min(evenness(bg.x_lines), evenness(bg.y_lines));
                    double extent = std::min(xSpan / std::max(wx1 - wx0, 1),
                                             ySpan / std::max(wy1 - wy0, 1));
                    double agX = coarseAgree(bg.x_lines, cand.vx, step);
                    double agY = coarseAgree(bg.y_lines, cand.hy, step);
                    if (aspect < 0.84 || regularity < 0.42 || agX < 0.70 || agY < 0.70) continue;
                    // 与 locateBoard 的评标口径同款，只是本函数拿不到那个 file-local 的 gridMetrics
                    double score = 0.70 * bg.confidence + 0.20 * regularity + 0.10 * extent
                                 + 0.05 * std::min(agX, agY);
                    if (trace)
                        fprintf(stderr, "[trace]   anchor win=(%d,%d)-(%d,%d)%s aspect=%.3f "
                                        "reg=%.3f ext=%.3f agree=%.2f/%.2f conf=%.3f score=%.3f\n",
                                wx0, wy0, wx1, wy1, lock ? " lock" : "",
                                aspect, regularity, extent, agX, agY, bg.confidence, score);
                    if (score > bestScore) {
                        bestScore = score;
                        // geometryFromRect 返回的是整幅图坐标，折算回 crop 相对坐标与 ①② 对齐
                        xs.resize(bg.x_lines.size());
                        for (size_t i = 0; i < xs.size(); ++i) xs[i] = bg.x_lines[i] - ax0;
                        ys.resize(bg.y_lines.size());
                        for (size_t i = 0; i < ys.size(); ++i) ys[i] = bg.y_lines[i] - ay0;
                        spacing = bg.spacing();
                        source = lock ? "anchor-lock" : "anchor";
                        have = true;
                    }
                }
            }
        }
        if (trace) fprintf(stderr, "[trace] ③ anchor windows=%d bestScore=%.3f\n",
                           tried, bestScore);
    }
    if (!have) {
        if (trace) fprintf(stderr, "[trace] refineGrid FAILED (no %d-line fit)\n", size);
        return out;
    }
    out.ok = true;
    out.xLines.resize(xs.size());
    for (size_t i = 0; i < xs.size(); ++i) out.xLines[i] = xs[i] + ax0;
    out.yLines.resize(ys.size());
    for (size_t i = 0; i < ys.size(); ++i) out.yLines[i] = ys[i] + ay0;
    out.spacing = spacing;
    out.source = source;
    out.ox = ax0;
    out.oy = ay0;
    return out;
}

/** 在上一帧棋盘位置附近搜索（跟踪模式）：只在局部跑找线，比全屏快一个量级 */
bool searchNear(const cv::Mat& gray, const ScanHint& hint, int size, BoardCand& out,
                double expand = 0.35) {
    int H = gray.rows, W = gray.cols;
    if (hint.w <= 0 || hint.h <= 0) return false;
    double ex = hint.w * expand, ey = hint.h * expand;
    int x0 = std::max(0, (int)(hint.x - ex)), y0 = std::max(0, (int)(hint.y - ey));
    int x1 = std::min(W, (int)(hint.x + hint.w + ex));
    int y1 = std::min(H, (int)(hint.y + hint.h + ey));
    if (x1 - x0 < 40 || y1 - y0 < 40) return false;
    cv::Mat sub = gray(cv::Rect(x0, y0, x1 - x0, y1 - y0));
    std::vector<BoardCand> c = findBoardRects(sub, size);
    if (c.empty()) return false;
    BoardCand cand = c[0];
    cand.x0 += x0; cand.y0 += y0; cand.x1 += x0; cand.y1 += y0;
    for (double& v : cand.vx) v += x0;
    for (double& v : cand.hy) v += y0;
    out = cand;
    return true;
}

/** 裁出棋盘区域 —— 外扩口径 = **边界线再往外「半格 + 棋盘边长 / 30」**。
 *
 *  ★ 2026-09-25（用户要求）：「识别的范围要在棋盘的边界线上，再多出 1/30 距离的棋盘」，
 *    并且「先识别出棋盘的外围，再识别盘中的子」—— 落子只在交叉点上，**压在边界线上的
 *    那颗子有一半身体探在线外**，所以裁剪区必须包含边界线以外的一整颗子半径（≈ 半格）；
 *    半格换算成棋盘边长 ≈ 边长/28，与用户说的 1/30 同一量级，这里两个都留足。
 *
 *  ⚠ 老实现留的是 `spacing * 1.3`（整整一格多的边距）。多出来的那一大圈**全是盘外**
 *    （桌面 / 网页底色），有两个害处：
 *      ① `scanSub` 明确要求「必须在棋盘裁剪区内读子，不能拿整屏去读：estimate_background
 *         的全局众数会取到桌面底色 → 空点全判白子」（见那边的注释）—— 盘外圈越大，
 *         这个众数越容易被带偏；
 *      ② 盘外背景与「贴边白子」在灰度上常常很像，圈越大越难分。
 *    ⇒ 收成「边界线 + 半格 + 边长/30」，与另两处同款口径完全一致：
 *        · 宿主截图选框自动贴盘 `host.cpp` 的 VSEL_WM_SNAP；
 *        · 识图侧吸附重试 `gbrecognize.cpp` 的 `pad = step*0.5 + (bw+bh)*0.5/30`。
 *    `padMul` 只留作「诊断/回归要求更大余量」的倍率（默认 1.0 = 上面那个口径）。 */
void cropBoard(const cv::Mat& rgb, const std::vector<double>& xLines,
               const std::vector<double>& yLines, double spacing,
               cv::Mat& crop, int& ox, int& oy, double padMul = 1.0) {
    int H = rgb.rows, W = rgb.cols;
    double span = ((xLines.back() - xLines.front()) + (yLines.back() - yLines.front())) * 0.5;
    double pad = (spacing * 0.5 + span / 30.0) * padMul;
    if (pad < spacing * 0.5) pad = spacing * 0.5;          // 兜底：任何情况下都不少于半格
    int x0 = std::max(0, (int)(xLines.front() - pad));
    int x1 = std::min(W, (int)(xLines.back() + pad) + 1);
    int y0 = std::max(0, (int)(yLines.front() - pad));
    int y1 = std::min(H, (int)(yLines.back() + pad) + 1);
    crop = rgb(cv::Rect(x0, y0, x1 - x0, y1 - y0));
    ox = x0;
    oy = y0;
}

/**
 * 把「本软件自己的窗口」在截图里抹成一块纯色。
 * 面板里有密集的等距横线（参数行、曲线网格），间距与棋盘的某一族非常接近，
 * 极易被当成第二个棋盘，或者把真正的棋盘定位拽歪。
 */
void maskExcluded(cv::Mat& rgb, const std::vector<ExcludeRect>& exclude, int offX, int offY) {
    if (exclude.empty()) return;
    std::vector<double> samples[3];
    for (int r = 0; r < rgb.rows; r += 16)
        for (int c = 0; c < rgb.cols; c += 16) {
            const uint8_t* p = rgb.ptr<uint8_t>(r) + c * 3;
            for (int k = 0; k < 3; ++k) samples[k].push_back((double)p[k]);
        }
    double fill[3] = {128, 128, 128};
    for (int k = 0; k < 3; ++k)
        if (!samples[k].empty()) fill[k] = median(samples[k]);

    for (const ExcludeRect& rr : exclude) {
        int x = rr.x - offX, y = rr.y - offY;
        int w = rr.w, h = rr.h;
        if (w <= 0 || h <= 0) continue;
        int x0 = std::max(0, x), y0 = std::max(0, y);
        int x1 = std::min(rgb.cols, x + w), y1 = std::min(rgb.rows, y + h);
        if (x1 <= x0 || y1 <= y0) continue;
        for (int r = y0; r < y1; ++r) {
            uint8_t* p = rgb.ptr<uint8_t>(r);
            for (int c = x0; c < x1; ++c) {
                p[c * 3 + 0] = (uint8_t)fill[0];
                p[c * 3 + 1] = (uint8_t)fill[1];
                p[c * 3 + 2] = (uint8_t)fill[2];
            }
        }
    }
}

Json diagKV(const std::string& k, const std::string& v) {
    Json j = Json::makeObj();
    j.set(k, Json::makeStr(v));
    return j;
}

/** geometry.x_lines / y_lines 与 board_rect 在 Python 里都是 float（json 输出带 .0） */
Json numD(double v) { return Json::makeNum(v); }

/** region 模式下把子图坐标平移回整体（等价 Python 的 `+ rx` / `+ ry`） */
void shiftJsonNum(Json& container, const std::string& key, double d) {
    Json* p = container.findMutable(key);
    if (p && p->type == Json::NUM) {
        if (p->isInt) { p->isInt = false; p->num = (double)p->inum + d; }
        else p->num += d;
    }
}

void shiftJsonArr(Json& container, const std::string& key, double d) {
    Json* p = container.findMutable(key);
    if (!p || p->type != Json::ARR) return;
    for (Json& v : p->arr)
        if (v.type == Json::NUM) {
            if (v.isInt) { v.isInt = false; v.num = (double)v.inum + d; }
            else v.num += d;
        }
}

ScanResult scanSub(const cv::Mat& rgbIn, int size, const ScanHint& hint,
                   const std::vector<ExcludeRect>& exclude, bool probe,
                   double offX, double offY);

ScanResult notFound(double offX, double offY, int multi, const std::string& reason) {
    ScanResult r;
    r.ok = true;
    r.found = false;
    r.ox = offX;
    r.oy = offY;
    r.multiBoard = multi;
    r.diag = diagKV("reason", reason);
    return r;
}

ScanResult scanSub(const cv::Mat& rgbIn, int size, const ScanHint& hint,
                   const std::vector<ExcludeRect>& exclude, bool probe,
                   double offX, double offY) {
    cv::Mat masked = rgbIn.clone();
    maskExcluded(masked, exclude, (int)offX, (int)offY);
    cv::Mat gray;
    cv::cvtColor(masked, gray, cv::COLOR_RGB2GRAY);

    bool haveCand = false;
    BoardCand cand;
    int multi = 0;
    if (probe) {
        // 全量探测（慢，但只有它数得清「屏幕上有几个棋盘」）
        std::vector<BoardCand> tops = findBoardRects(gray, size, 8, 6);
        if (!tops.empty()) {
            cand = tops[0];
            haveCand = true;
            multi = countDistinctBoards(tops);
        }
    }
    if (!haveCand && hint.has) haveCand = searchNear(gray, hint, size, cand);
    if (!haveCand) {
        std::vector<BoardCand> c = findBoardRects(gray, size, 8, 1);
        if (!c.empty()) { cand = c[0]; haveCand = true; }
    }
    if (!haveCand) return notFound(offX, offY, 0, "no-board");

    RefineResult geo = refineGrid(masked, cand, size);
    if (!geo.ok) {
        ScanResult r = notFound(offX, offY, multi, "no-grid");
        Json c = Json::makeObj();
        c.set("x0", Json::makeNum(cand.x0));
        c.set("y0", Json::makeNum(cand.y0));
        c.set("x1", Json::makeNum(cand.x1));
        c.set("y1", Json::makeNum(cand.y1));
        c.set("step", Json::makeNum(cand.step));
        c.set("score", Json::makeNum(cand.score));
        c.set("size", Json::makeInt(cand.size));
        c.set("scale", Json::makeNum(cand.scale));
        r.diag.set("cand", c);
        return r;
    }
    double spacing = geo.spacing != 0 ? geo.spacing : cand.step;
    // ⚠️ 必须在**棋盘裁剪区**内读子，不能拿整屏去读：estimate_background 的全局众数
    //    取的是整屏直方图，而棋盘往往只占屏幕一小块，众数会落到桌面/页面底色上。
    cv::Mat crop;
    int cox = 0, coy = 0;
    cropBoard(masked, geo.xLines, geo.yLines, spacing, crop, cox, coy);

    GeoLike g;
    g.size = size;
    g.spacing = spacing;
    g.x_lines.resize(geo.xLines.size());
    for (size_t i = 0; i < geo.xLines.size(); ++i) g.x_lines[i] = geo.xLines[i] - cox;
    g.y_lines.resize(geo.yLines.size());
    for (size_t i = 0; i < geo.yLines.size(); ++i) g.y_lines[i] = geo.yLines[i] - coy;

    if (const char* dp = getenv("GB_VISION_DUMP_CROP")) {
        cv::Mat bgr;
        cv::cvtColor(crop, bgr, cv::COLOR_RGB2BGR);
        cv::imwrite(dp, bgr);
        fprintf(stderr, "[dump] crop %dx%d ox=%d oy=%d spacing=%.3f x0=%.3f y0=%.3f\n",
                crop.cols, crop.rows, cox, coy, spacing,
                geo.xLines.front(), geo.yLines.front());
    }

    cv::Mat board, conf;
    Json diag;
    readStonesAdaptive(crop, g, board, conf, diag);

    // ★ 2026-09-25（用户要求：「优化识别棋盘外围 … 增强桌面识别棋盘的适应能力」）：
    //   贴边棋子被裁掉半个身体 → 结果「可疑」（黑白失衡 / 落子占比过高，见 invariants）。
    //   凡可疑就把余量放大一倍（边界线外 2×（半格 + 边长/30））**重读一次**，
    //   新的不可疑就换成新的 —— 宁可用大一点的窗口读准，也不要交一个可疑的盘面。
    //   （可疑结果宿主本来就会丢弃 → 表现为「未检测到棋盘」；这条重试把它救回来。）
    {
        bool sus0 = (diag.find("suspect") && diag.find("suspect")->b);
        if (sus0) {
            cv::Mat crop2;
            int cx2 = 0, cy2 = 0;
            cropBoard(masked, geo.xLines, geo.yLines, spacing, crop2, cx2, cy2, 2.0);
            if (crop2.cols > crop.cols || crop2.rows > crop.rows) {
                GeoLike g2;
                g2.size = size;
                g2.spacing = spacing;
                g2.x_lines.resize(geo.xLines.size());
                for (size_t i = 0; i < geo.xLines.size(); ++i) g2.x_lines[i] = geo.xLines[i] - cx2;
                g2.y_lines.resize(geo.yLines.size());
                for (size_t i = 0; i < geo.yLines.size(); ++i) g2.y_lines[i] = geo.yLines[i] - cy2;
                cv::Mat board2, conf2;
                Json diag2;
                readStonesAdaptive(crop2, g2, board2, conf2, diag2);
                bool sus2 = (diag2.find("suspect") && diag2.find("suspect")->b);
                if (!sus2) {
                    crop = crop2; cox = cx2; coy = cy2;
                    g = g2; board = board2; conf = conf2; diag = diag2;
                    diag.set("wide_crop_retry", Json::makeBool(true));
                }
            }
        }
    }

    ScanResult res;
    res.ok = true;
    res.found = true;
    res.ox = offX;
    res.oy = offY;
    res.suspect = diag.find("suspect") && diag.find("suspect")->b;
    res.multiBoard = multi;
    res.diag = diag;

    int n = board.rows;
    for (int r = 0; r < n; ++r)
        for (int c = 0; c < n; ++c) {
            int8_t v = board.at<int8_t>(r, c);
            if (v == BLACK) res.black.emplace_back(c, r);
            else if (v == WHITE) res.white.emplace_back(c, r);
        }

    Json br = Json::makeObj();
    br.set("x", Json::makeNum(geo.xLines.front()));
    br.set("y", Json::makeNum(geo.yLines.front()));
    br.set("w", Json::makeNum(geo.xLines.back() - geo.xLines.front()));
    br.set("h", Json::makeNum(geo.yLines.back() - geo.yLines.front()));
    res.boardRect = br;

    Json gj = Json::makeObj();
    Json xa = Json::makeArr(), ya = Json::makeArr();
    for (double v : geo.xLines) xa.push(numD(v));
    for (double v : geo.yLines) ya.push(numD(v));
    gj.set("x_lines", xa);
    gj.set("y_lines", ya);
    gj.set("spacing", Json::makeNum(geo.spacing != 0 ? geo.spacing : cand.step));
    gj.set("size", Json::makeInt(size));
    res.geometry = gj;
    res.crop = crop;
    return res;
}

}  // namespace

ScanResult scanOnce(const cv::Mat* rgbIn, int size, const ScanHint& hint,
                    const std::vector<ExcludeRect>& exclude, bool probe,
                    const std::vector<int>* region) {
    cv::Mat owned;
    const cv::Mat* rgb = rgbIn;
    double offX = 0, offY = 0;
    if (!rgb) {
        int ox = 0, oy = 0;
        if (!captureScreen(owned, ox, oy)) {
            ScanResult r;
            r.ok = false;
            r.diag = Json::makeObj();
            r.diag.set("reason", Json::makeStr("capture-failed"));
            return r;
        }
        rgb = &owned;
        offX = ox;
        offY = oy;
    } else {
        offX = screenOx;
        offY = screenOy;
    }

    // ---- 手动调节：把屏幕裁到用户矩形里，几何偏移回虚拟屏坐标 ----
    if (region && region->size() >= 4) {
        int oxI = iRound(offX), oyI = iRound(offY);
        int rx0 = iRound((double)(*region)[0]), ry0 = iRound((double)(*region)[1]);
        int rw0 = iRound((double)(*region)[2]), rh0 = iRound((double)(*region)[3]);
        int rx = rx0 - oxI, ry = ry0 - oyI;
        int h = rgb->rows, w = rgb->cols;
        rx = std::max(0, std::min(rx, w - 1));
        ry = std::max(0, std::min(ry, h - 1));
        int rw = std::max(1, std::min(rw0, w - rx));
        int rh = std::max(1, std::min(rh0, h - ry));
        cv::Mat sub = (*rgb)(cv::Rect(rx, ry, rw, rh)).clone();
        // ★ region 模式下同样要抹掉本软件自己的窗口（旧实现这里传 None，会被面板行线拽歪）。
        //   子图下标 = 屏幕坐标 − rx0，所以绝对原点 rx0/ry0 就是这一小块自己的 off。
        maskExcluded(sub, exclude, rx0, ry0);
        ScanResult res = scanSub(sub, size, ScanHint{}, {}, probe, 0, 0);
        if (res.found) {
            shiftJsonNum(res.boardRect, "x", rx);
            shiftJsonNum(res.boardRect, "y", ry);
            shiftJsonArr(res.geometry, "x_lines", rx);
            shiftJsonArr(res.geometry, "y_lines", ry);
            res.ox = offX + rx;
            res.oy = offY + ry;
        }
        return res;
    }
    return scanSub(*rgb, size, hint, exclude, probe, offX, offY);
}

/** ★ 自动吸附棋盘候选导出（2026-09-22）：gbrecognize 的棋理仲裁重试链在主结果
 *  违反棋理时，用它在大图里找棋盘矩形、裁出来重读。转发到内部 findBoardRects。 */
std::vector<BoardRectCand> snapBoardRects(const cv::Mat& gray, int lineCount, int topn) {
    std::vector<BoardRectCand> out;
    for (const BoardCand& c : findBoardRects(gray, lineCount, 8, topn)) {
        BoardRectCand r;
        r.x0 = c.x0; r.y0 = c.y0; r.x1 = c.x1; r.y1 = c.y1;
        r.step = c.step; r.score = c.score;
        out.push_back(r);
    }
    return out;
}

}  // namespace gb
