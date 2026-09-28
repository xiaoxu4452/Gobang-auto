// gbadaptive.cpp —— adaptive.py 的 C++ 移植（自适应读子核心 + Hough 网格兜底）
// =====================================================================
// ★ 移植纪律：所有常量、判据顺序、注释里的现场实测数字**逐条保留**。
//   这些数字是 2026-09-19 现场（屏江棋院 / 五林 / renjuworld）钉出来的，
//   少一条就会在某个站点上退回「未检测到棋盘」。凡是读起来"多余"的分支，
//   都对应一次真实事故，不要合并、不要「优化掉」。
#include "gbvision.h"

#include <cstdlib>
#include <climits>
#include <limits>
#include <cstring>
#include <set>
#include <thread>
#include <atomic>

namespace gb {

namespace {

inline double npRound(double v) { return std::nearbyint(v); }
inline int iRound(double v) { return (int)std::nearbyint(v); }

/** adaptive._odd */
inline int oddKernel(double n, int lo, int hi) {
    int v = iRound(n);
    if (v % 2 == 0) v += 1;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
}

// —— 径向证据（空心/描边棋子的判色依据）——
constexpr double CORE_R = 0.26;
constexpr double RING_R0 = 0.34;
constexpr double RING_R1 = 0.50;
constexpr int RING_SECTORS = 24;
constexpr double RING_COVER_MIN = 0.70;
constexpr double RING_ARC_MIN = 0.50;
constexpr double RING_FILL_MIN = 0.10;

// —— 「平斑块」闸门（反识别手段：水印 / 渐变叠加，2026-09-19 识别预防针）——
constexpr double OUT_R0 = 0.50;
constexpr double OUT_R1 = 0.555;

// —— 逐格「存在性」判据：木纹 / 照片底板上的浅色子 ——
constexpr double CELL_CONTRAST_MIN = 14.0;
constexpr double CELL_THR_RATIO = 0.45;
constexpr double CELL_BG_R = 0.12;
constexpr double CELL_BG_OFF = 0.50;
constexpr double CELL_FILL_REL = 0.25;
constexpr double CELL_FILL_MIN = 0.60;
// ★ 主路径「实心圆盘」闸门（2026-09-21 用户：识别太敏感，木纹亮带/照片边缘暗带被读成棋子；
//   且「棋子是实心圆」—— 开源实现普遍按填充度判）。真棋子核心盘极性填充 ≥0.9，
//   暗带假斑只有 ~0.45（与 Python adaptive.CELL_FILL_MAIN_MIN 同值，改一处必须改两处）。
constexpr double CELL_FILL_MAIN_MIN = 0.55;

constexpr double BASE_CONTRAST = 10.0;
constexpr double MAD_K = 4.0;
constexpr double MIN_CIRCULARITY = 0.55;
constexpr double HULL_CIRC_MIN = 0.80;
constexpr double SCORE_MIN_RATIO = 0.25;
constexpr double SCORE_MAX_RATIO = 3.2;

/** 掩膜 + 预计算的展平下标（225 个交点复用同一批掩膜 → 必须预计算，否则慢一个量级） */
struct MaskIdx {
    cv::Mat m;                  // CV_8U，0/1
    std::vector<int> idx;       // row-major 展平下标
    bool empty() const { return idx.empty(); }
};

MaskIdx makeMask(const cv::Mat& bin) {
    MaskIdx out;
    out.m = bin.clone();
    out.idx.reserve((size_t)cv::countNonZero(bin));
    for (int r = 0; r < bin.rows; ++r) {
        const uint8_t* p = bin.ptr<uint8_t>(r);
        for (int c = 0; c < bin.cols; ++c)
            if (p[c]) out.idx.push_back(r * bin.cols + c);
    }
    return out;
}

inline std::vector<int16_t> gatherI16(const cv::Mat& patch, const MaskIdx& mi) {
    std::vector<int16_t> v;
    v.reserve(mi.idx.size());
    const int16_t* p = patch.ptr<int16_t>(0);
    for (int i : mi.idx) v.push_back(p[i]);
    return v;
}

inline std::vector<int> gatherI32(const cv::Mat& patch, const MaskIdx& mi) {
    std::vector<int> v;
    v.reserve(mi.idx.size());
    const int32_t* p = patch.ptr<int32_t>(0);
    for (int i : mi.idx) v.push_back(p[i]);
    return v;
}

inline std::vector<double> toDouble(const std::vector<int16_t>& v) {
    std::vector<double> d(v.size());
    for (size_t i = 0; i < v.size(); ++i) d[i] = (double)v[i];
    return d;
}

/** 掩膜按位或 */
inline cv::Mat maskOr(const cv::Mat& a, const cv::Mat& b) {
    cv::Mat out;
    cv::bitwise_or(a, b, out);
    return out;
}

}  // namespace

// =====================================================================
// 噪声 / 背景
// =====================================================================

double noiseSigma(const cv::Mat& diff16) {
    std::vector<double> v;
    v.reserve((size_t)diff16.rows * diff16.cols);
    for (int r = 0; r < diff16.rows; ++r) {
        const int16_t* p = diff16.ptr<int16_t>(r);
        for (int c = 0; c < diff16.cols; ++c) v.push_back((double)p[c]);
    }
    return medianAbsDev(std::move(v));
}

BgEstimate estimateBackground(const cv::Mat& gray, double spacing) {
    BgEstimate out;
    int bg0 = globalMode(gray);
    out.bg0 = bg0;

    cv::Mat g;
    gray.convertTo(g, CV_32F);
    cv::Mat i16;
    gray.convertTo(i16, CV_16S);
    double sigma0 = noiseSigma(i16);

    // 前景（非背景）掩膜：阈值取「鲁棒噪声」与 10 灰阶的较大者，保证白子相对浅底
    // 的微弱对比（如 #fff vs #f2ead8 ≈ 21 灰阶）也能被剔除，不污染背景场。
    double fgThr = std::max(10.0, MAD_K * sigma0);
    cv::Mat bgMask(g.rows, g.cols, CV_32F);
    for (int r = 0; r < g.rows; ++r) {
        const float* gp = g.ptr<float>(r);
        float* bp = bgMask.ptr<float>(r);
        for (int c = 0; c < g.cols; ++c)
            bp[c] = (std::abs((double)gp[c] - (double)bg0) > fgThr) ? 0.f : 1.f;
    }

    int k = oddKernel(spacing * 4.0, 9, 301);
    cv::Mat wsum, vsum, gmask;
    cv::boxFilter(bgMask, wsum, -1, cv::Size(k, k), cv::Point(-1, -1), false);
    cv::multiply(g, bgMask, gmask);
    cv::boxFilter(gmask, vsum, -1, cv::Size(k, k), cv::Point(-1, -1), false);

    cv::Mat field(g.rows, g.cols, CV_32F);
    for (int r = 0; r < g.rows; ++r) {
        const float* wp = wsum.ptr<float>(r);
        const float* vp = vsum.ptr<float>(r);
        float* fp = field.ptr<float>(r);
        for (int c = 0; c < g.cols; ++c) {
            float w = std::max(wp[c], 1.0f);
            float val = vp[c] / w;
            fp[c] = (wp[c] < 5.0f) ? (float)bg0 : val;
        }
    }

    // 背景噪声 σ：只在背景像素上估计 → 阈值不会被密集棋簇抬高，浅底白子的弱对比得以保留
    std::vector<double> bp;
    for (int r = 0; r < g.rows; ++r) {
        const float* gp = g.ptr<float>(r);
        const float* mp = bgMask.ptr<float>(r);
        for (int c = 0; c < g.cols; ++c)
            if (mp[c] > 0.5f) bp.push_back((double)gp[c]);
    }
    double sigmaBg = 0.0;
    if (bp.size() > 100) sigmaBg = medianAbsDev(std::move(bp));

    out.field = field;
    out.sigma = sigmaBg;
    return out;
}

// =====================================================================
// 平斑块闸门
// =====================================================================

bool plateauLikeMed(double outMed, double ref) {
    double thr = std::max(10.0, 0.35 * std::abs(ref));
    if (ref >= 0) return outMed > thr;
    return outMed < -thr;
}

bool quadsPlateauVals(const std::vector<double>& quadMeds, double ref) {
    double thr = std::max(12.0, 0.35 * std::abs(ref));
    bool pos = ref >= 0;
    for (double v : quadMeds) {
        if (pos && v > thr) return true;
        if (!pos && v < -thr) return true;
    }
    return false;
}

bool plateauGateVeto(bool outPlateau, double ref, double edge) {
    if (!outPlateau) return false;
    return edge < std::max(26.0, 0.12 * std::abs(ref));
}

static double circularity(const std::vector<cv::Point>& contour) {
    double area = std::abs(cv::contourArea(contour));
    double per = cv::arcLength(contour, true);
    if (area <= 0 || per <= 0) return 0.0;
    return 4.0 * CV_PI * area / (per * per);
}

/** 以交点为中心的「内盘 / 描边环带 / 环带角向扇区」索引图（窗口 (2*half+1)²） */
static void radialMaps(int half, double spacing, MaskIdx& coreM, MaskIdx& ringM, cv::Mat& ringSec) {
    int n = 2 * half + 1;
    cv::Mat core(n, n, CV_8U, cv::Scalar(0));
    cv::Mat ring(n, n, CV_8U, cv::Scalar(0));
    ringSec = cv::Mat(n, n, CV_32S, cv::Scalar(-1));
    for (int r = 0; r < n; ++r) {
        double yy = (double)(r - half);
        uint8_t* cp = core.ptr<uint8_t>(r);
        uint8_t* rp = ring.ptr<uint8_t>(r);
        int32_t* sp = ringSec.ptr<int32_t>(r);
        for (int c = 0; c < n; ++c) {
            double xx = (double)(c - half);
            double dist = std::hypot(xx, yy);
            if (dist <= CORE_R * spacing) cp[c] = 1;
            if (dist >= RING_R0 * spacing && dist <= RING_R1 * spacing) {
                rp[c] = 1;
                double ang = (std::atan2(yy, xx) + CV_PI) / (2.0 * CV_PI);
                int sec = (int)std::floor(ang * RING_SECTORS);
                if (sec < 0) sec = 0;
                if (sec > RING_SECTORS - 1) sec = RING_SECTORS - 1;
                sp[c] = sec;
            }
        }
    }
    coreM = makeMask(core);
    ringM = makeMask(ring);
}

/** 格子四角采样掩膜（key = (sx>0)*1 + (sy>0)*2，即 (sx,sy) ∈ {-1,1}²） */
static void cellBgMasks(int half, double spacing, MaskIdx out[4]) {
    int n = 2 * half + 1;
    double rr = CELL_BG_R * spacing;
    for (int si = 0; si < 2; ++si) {
        for (int sj = 0; sj < 2; ++sj) {
            double sx = si == 0 ? -1.0 : 1.0;
            double sy = sj == 0 ? -1.0 : 1.0;
            double cx = sx * CELL_BG_OFF * spacing;
            double cy = sy * CELL_BG_OFF * spacing;
            cv::Mat m(n, n, CV_8U, cv::Scalar(0));
            for (int r = 0; r < n; ++r) {
                uint8_t* p = m.ptr<uint8_t>(r);
                for (int c = 0; c < n; ++c) {
                    double xx = (double)(c - half), yy = (double)(r - half);
                    if (std::hypot(xx - cx, yy - cy) <= rr) p[c] = 1;
                }
            }
            out[si * 2 + sj] = makeMask(m);
        }
    }
}

/**
 * cell_bg_union —— 边界格必须把「盘外的两只角」也并进来。
 * 为什么：棋盘木底自带边缘暗角，距交点 0.5 格（盘内角）与 1 格（再往里的角）之间
 * 就有 ~14 灰阶的单调梯度，正好顶到 CELL_CONTRAST_MIN → 四角被打成「整块暗区」
 * 当黑子（现场：局面小棋盘左上角凭空多出一颗黑子）。并进盘外的角后梯度两侧相消。
 */
static MaskIdx cellBgUnion(const MaskIdx cellBg[4], int row, int col, int n) {
    std::vector<int> sxList, syList;
    if (col - 1 >= 0) sxList.push_back(-1);
    if (col + 1 < n) sxList.push_back(1);
    if (row - 1 >= 0) syList.push_back(-1);
    if (row + 1 < n) syList.push_back(1);
    if (sxList.empty()) sxList.push_back(-1);
    if (syList.empty()) syList.push_back(-1);

    auto at = [&](int sx, int sy) -> const MaskIdx& {
        return cellBg[(sx > 0 ? 1 : 0) * 2 + (sy > 0 ? 1 : 0)];
    };
    cv::Mat acc = at(sxList[0], syList[0]).m.clone();
    for (int sx : sxList)
        for (int sy : syList) {
            if (sx == sxList[0] && sy == syList[0]) continue;
            cv::bitwise_or(acc, at(sx, sy).m, acc);
        }
    if (sxList.size() < 2 || syList.size() < 2) {
        for (int sx : {-1, 1})
            for (int sy : {-1, 1}) {
                bool inside = (col + sx >= 0 && col + sx < n && row + sy >= 0 && row + sy < n);
                if (inside) continue;
                cv::bitwise_or(acc, at(sx, sy).m, acc);
            }
    }
    return makeMask(acc);
}

/**
 * decide_color —— 按径向证据判定交点处的棋子颜色。
 * ⚠️ 存在性与颜色必须一起判：粗网格线棋盘上，空交叉点的内盘本就被线十字占掉一半
 * （实测 core 暗占比 0.5~0.63），所以「内盘暗」只说明*颜色*，不能说明*有子*。
 * 有无棋子一律以「环带角向是否闭合」为准。
 */
static std::pair<int, double> decideColor(const cv::Mat& patch, const MaskIdx& coreM,
                                          const MaskIdx& ringM, const cv::Mat& ringSec,
                                          double thr) {
    std::vector<int16_t> ring = gatherI16(patch, ringM);
    if (ring.empty()) return {EMPTY, 0.0};
    std::vector<char> hit(ring.size());
    double hitSum = 0.0;
    for (size_t i = 0; i < ring.size(); ++i) {
        hit[i] = (std::abs((int)ring[i]) > thr) ? 1 : 0;
        hitSum += hit[i];
    }
    if (hitSum / (double)ring.size() < RING_FILL_MIN) return {EMPTY, 0.0};

    std::vector<int> rs = gatherI32(ringSec, ringM);

    // 逐扇区统计「强对比像素密度 / 该扇区对比的极性」，再找环形最大连续有效弧。
    // 用「连续弧长」而非「总覆盖率」，是为了容纳画法 B：描边只画了多半圈、剩下是阴影；
    // 同时仍能挡住网格线十字（只在 4 个方向上各占 1~2 个扇区，最大连续弧 ≤ 0.1 圈）。
    std::vector<int> secTot(RING_SECTORS, 0), secHit(RING_SECTORS, 0);
    std::vector<std::vector<double>> secVals(RING_SECTORS);
    for (size_t i = 0; i < ring.size(); ++i) {
        int s = rs[i];
        if (s < 0) continue;
        secTot[s] += 1;
        if (hit[i]) {
            secHit[s] += 1;
            secVals[s].push_back((double)ring[i]);
        }
    }
    std::vector<char> valid(RING_SECTORS, 0);
    std::vector<double> polar(RING_SECTORS, 0.0);
    for (int s = 0; s < RING_SECTORS; ++s) {
        if (secHit[s] > 0 && secTot[s] > 0 &&
            double(secHit[s]) / double(secTot[s]) >= 0.25) {
            valid[s] = 1;
            polar[s] = median(secVals[s]);
        }
    }
    bool anyValid = false;
    for (int s = 0; s < RING_SECTORS; ++s) if (valid[s]) { anyValid = true; break; }
    if (!anyValid) return {EMPTY, 0.0};

    int best = 0, cur = 0;
    for (int s = 0; s < RING_SECTORS * 2; ++s) {
        if (valid[s % RING_SECTORS]) {
            cur += 1;
            best = std::max(best, std::min(cur, RING_SECTORS));
        } else cur = 0;
    }
    double arc = double(best) / double(RING_SECTORS);
    int validCount = 0;
    for (int s = 0; s < RING_SECTORS; ++s) validCount += valid[s] ? 1 : 0;
    double cover = double(validCount) / double(RING_SECTORS);
    if (arc < RING_ARC_MIN && cover < RING_COVER_MIN) return {EMPTY, 0.0};

    // —— 环带闭合 ⇒ 确有棋子，此后再定色 ——
    std::vector<int16_t> core = gatherI16(patch, coreM);
    if (!core.empty()) {
        int neg = 0, pos = 0;
        for (int16_t v : core) {
            if ((double)v < -thr) neg++;
            if ((double)v > thr) pos++;
        }
        double m = (double)core.size();
        // ★ 八轮注：此处**不做**「环极性反向 → 按环定色」的纠偏——深色盘黑子天生配
        //   浅描边（deep_dark stroke=150 vs 盘 24），环必然偏亮，会把黑子全翻成白
        //   （对拍 B/deep_dark、B/dark_blue、K/深盘 回退教训）。带手数数字棋子的
        //   纠偏统一由盘面亮度感知的 rawRefine / rawClassify（原始灰度壳环）承担。
        if (double(neg) / m >= 0.5) return {BLACK, 0.85};
        if (double(pos) / m >= 0.5) return {WHITE, 0.85};
    }
    // 内盘与底色不可分辨：只能靠描边环的极性（这是空心画法的唯一线索）
    std::vector<double> pv;
    for (int s = 0; s < RING_SECTORS; ++s) if (valid[s]) pv.push_back(polar[s]);
    int pos = 0, neg = 0;
    for (double v : pv) {
        if (v > 0) pos++;
        else if (v < 0) neg++;
    }
    if (pos == neg) return {EMPTY, 0.0};
    double med = median(pv);
    if (med == 0.0) med = (pos > neg) ? 1.0 : -1.0;
    return {med < 0 ? WHITE : BLACK, 0.55};
}

int stripBorderArtifacts(cv::Mat& board, cv::Mat* conf, double minRatio) {
    int n = board.rows;
    if (n < 2) return 0;
    int minRun = std::max(8, iRound(n * minRatio));
    int removed = 0;

    auto cleanLine = [&](const std::vector<std::pair<int, int>>& cells) {
        size_t i = 0;
        while (i < cells.size()) {
            int v = board.at<int8_t>(cells[i].first, cells[i].second);
            size_t j = i;
            while (j + 1 < cells.size() &&
                   board.at<int8_t>(cells[j + 1].first, cells[j + 1].second) == v) j++;
            if (v != EMPTY && (int)(j - i + 1) >= minRun) {
                for (size_t k = i; k <= j; ++k) {
                    board.at<int8_t>(cells[k].first, cells[k].second) = EMPTY;
                    if (conf) conf->at<float>(cells[k].first, cells[k].second) = 0.0f;
                    removed++;
                }
            }
            i = j + 1;
        }
    };

    for (int r : {0, n - 1}) {
        std::vector<std::pair<int, int>> line;
        for (int c = 0; c < n; ++c) line.emplace_back(r, c);
        cleanLine(line);
    }
    for (int c : {0, n - 1}) {
        std::vector<std::pair<int, int>> line;
        for (int r = 0; r < n; ++r) line.emplace_back(r, c);
        cleanLine(line);
    }
    return removed;
}

Json invariants(const cv::Mat& board) {
    int nb = 0, nw = 0;
    int n = board.rows;
    for (int r = 0; r < n; ++r) {
        const int8_t* p = board.ptr<int8_t>(r);
        for (int c = 0; c < n; ++c) {
            if (p[c] == BLACK) nb++;
            else if (p[c] == WHITE) nw++;
        }
    }
    int total = nb + nw;
    bool balanced = std::abs(nb - nw) <= 2;
    bool notSwamped = double(total) <= 0.80 * double(n) * double(n);
    Json j = Json::makeObj();
    j.set("black", Json::makeInt(nb));
    j.set("white", Json::makeInt(nw));
    j.set("total", Json::makeInt(total));
    j.set("balanced", Json::makeBool(balanced));
    j.set("not_swamped", Json::makeBool(notSwamped));
    j.set("suspect", Json::makeBool((total >= 6 && !balanced) || !notSwamped));
    return j;
}

// =====================================================================
// 自适应读子主流程
// =====================================================================

void readStonesAdaptive(const cv::Mat& rgb, const GeoLike& geo,
                        cv::Mat& board, cv::Mat& conf, Json& diag) {
    cv::Mat gray;
    cv::cvtColor(rgb, gray, cv::COLOR_RGB2GRAY);
    int n = geo.size;
    board = cv::Mat(n, n, CV_8S, cv::Scalar(EMPTY));
    conf = cv::Mat(n, n, CV_32F, cv::Scalar(0.f));
    double spacing = geo.spacing;
    int h = gray.rows, w = gray.cols;

    BgEstimate bgEst = estimateBackground(gray, spacing);
    double sigma = bgEst.sigma;
    double thr = std::max(BASE_CONTRAST, MAD_K * sigma);

    // 棋子尺度（像素）：满格棋子半径 ≈ 0.44 格距（面板/主流实现的通用比例）
    double stoneR = spacing * 0.44;
    double stoneArea = CV_PI * stoneR * stoneR;
    double minArea = stoneArea * SCORE_MIN_RATIO;
    double maxArea = stoneArea * SCORE_MAX_RATIO;
    int half = iRound(spacing * 0.62);

    // diff = gray(int16) − bg(int16)；★ bg 转 int16 是**截断**（numpy astype），
    // 不能用 convertTo（那是四舍五入），否则阈值边缘会系统性偏移。
    cv::Mat diff16(gray.rows, gray.cols, CV_16S);
    for (int r = 0; r < gray.rows; ++r) {
        const uint8_t* gp = gray.ptr<uint8_t>(r);
        const float* fp = bgEst.field.ptr<float>(r);
        int16_t* dp = diff16.ptr<int16_t>(r);
        for (int c = 0; c < gray.cols; ++c)
            dp[c] = (int16_t)((int)gp[c] - (int)(float)fp[c]);
    }

    // 边缘补 0（= 与背景零偏差）：贴边/角落的交叉点补丁会越界，旧实现直接 continue
    // 跳过 → **边角棋子永远读不到**。补零后补丁恒为完整尺寸，边角棋子照常参与形状验证。
    int pad = half;
    cv::Mat diff;
    cv::copyMakeBorder(diff16, diff, pad, pad, pad, pad, cv::BORDER_CONSTANT, cv::Scalar(0));

    cv::Mat kernel = cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(3, 3));
    MaskIdx coreM, ringM;
    cv::Mat ringSec;
    radialMaps(half, spacing, coreM, ringM, ringSec);
    MaskIdx cellBg[4];
    cellBgMasks(half, spacing, cellBg);

    int win = 2 * half + 1;
    // 「平斑块」闸门的外环带（0.50~0.555 格距）；边角格只取朝盘内的半带。
    cv::Mat outM(win, win, CV_8U, cv::Scalar(0));
    cv::Mat quadMs[4];   // (yy>0,xx>0) (yy>0,xx<0) (yy<0,xx>0) (yy<0,xx<0)
    for (int k = 0; k < 4; ++k) quadMs[k] = cv::Mat(win, win, CV_8U, cv::Scalar(0));
    cv::Mat edgeIn(win, win, CV_8U, cv::Scalar(0));
    cv::Mat edgeOut(win, win, CV_8U, cv::Scalar(0));
    cv::Mat yyPos(win, win, CV_8U, cv::Scalar(0)), yyNeg(win, win, CV_8U, cv::Scalar(0));
    cv::Mat xxPos(win, win, CV_8U, cv::Scalar(0)), xxNeg(win, win, CV_8U, cv::Scalar(0));
    for (int r = 0; r < win; ++r) {
        double yy = (double)(r - half);
        for (int c = 0; c < win; ++c) {
            double xx = (double)(c - half);
            double rr = std::hypot(xx, yy);
            if (rr >= OUT_R0 * spacing && rr <= OUT_R1 * spacing) outM.at<uint8_t>(r, c) = 1;
            if (rr >= spacing * 0.27 && rr <= spacing * 0.33) edgeIn.at<uint8_t>(r, c) = 1;
            if (rr >= spacing * 0.495 && rr <= spacing * 0.605) edgeOut.at<uint8_t>(r, c) = 1;
            if (yy > 0) yyPos.at<uint8_t>(r, c) = 1; else if (yy < 0) yyNeg.at<uint8_t>(r, c) = 1;
            if (xx > 0) xxPos.at<uint8_t>(r, c) = 1; else if (xx < 0) xxNeg.at<uint8_t>(r, c) = 1;
        }
    }
    {
        cv::Mat a, b;
        cv::bitwise_and(yyPos, xxPos, a); quadMs[0] = a;
        cv::bitwise_and(yyPos, xxNeg, b); quadMs[1] = b;
        cv::bitwise_and(yyNeg, xxPos, b); quadMs[2] = b;
        cv::bitwise_and(yyNeg, xxNeg, b); quadMs[3] = b;
    }

    // 9 类（行上/中/下 × 列左/中/右）预计算掩膜：225 个交点只有这 9 种形态
    auto cat = [&](int idx, int nline) { return idx == 0 ? 0 : (idx == nline - 1 ? 2 : 1); };
    MaskIdx bgIdxCache[3][3], outIdxCache[3][3];
    std::vector<MaskIdx> outQuadCache[3][3];
    bool bgCacheReady[3][3] = {{false}};
    for (int ri = 0; ri < 3; ++ri)
        for (int ci = 0; ci < 3; ++ci) {
            int row = (ri == 0 ? 0 : (ri == 1 ? n / 2 : n - 1));
            int col = (ci == 0 ? 0 : (ci == 1 ? n / 2 : n - 1));
            if (row >= n) row = n - 1;
            if (col >= n) col = n - 1;
            bgIdxCache[ri][ci] = cellBgUnion(cellBg, row, col, n);
            cv::Mat om = outM.clone();
            if (row == 0) cv::bitwise_and(om, yyPos, om);
            else if (row == n - 1) cv::bitwise_and(om, yyNeg, om);
            if (col == 0) cv::bitwise_and(om, xxPos, om);
            else if (col == n - 1) cv::bitwise_and(om, xxNeg, om);
            outIdxCache[ri][ci] = makeMask(om);
            // ★ 象限可用性必须**三态**：首行 / 末行 / 其余（四象限全可用）。
            //   这里曾写成「默认 = 首行取值，只有末行才改写」—— 于是**盘内格只取到 1 个象限**
            //   （Python 原文是 `(1,1,0,0) if row==0 else ((0,0,1,1) if row==n-1 else (1,1,1,1))`）。
            //   后果：平斑块闸门的分象限判据形同虚设 → 深盘水印在空盘上被误报成白子
            //   （现场：E/空盘水印/deep_dark 与 dark_blue 各多一颗假白子）。
            int rowsOk[4] = {1, 1, 1, 1};
            if (row == 0) { rowsOk[2] = 0; rowsOk[3] = 0; }
            else if (row == n - 1) { rowsOk[0] = 0; rowsOk[1] = 0; }
            int colsOk[4] = {1, 1, 1, 1};
            if (col == 0) { colsOk[1] = 0; colsOk[3] = 0; }
            else if (col == n - 1) { colsOk[0] = 0; colsOk[2] = 0; }
            for (int k = 0; k < 4; ++k) {
                if (!rowsOk[k] || !colsOk[k]) continue;
                cv::Mat qm;
                cv::bitwise_and(outM, quadMs[k], qm);
                outQuadCache[ri][ci].push_back(makeMask(qm));
            }
            bgCacheReady[ri][ci] = true;
        }

    MaskIdx edgeInM = makeMask(edgeIn), edgeOutM = makeMask(edgeOut);

    // ★ 八轮原始灰度护栏（用户报两例）：
    //   a) 半透明水印/圆痕鬼影：与盘面几乎同亮（实测核心盘灰度 209 vs 盘面 ~221），
    //      自适应背景场被它局部抬高后 diff 成负 → 被「黑子」收编（假黑子 H2）；
    //      真黑子在原始灰度上永远远暗于盘面（~0.3×盘面），鬼影 ~0.95× —— 一刀可分。
    //   b) 白子候选的暗描边验证：白子必有暗描边（rim 暗于盘面），盘面亮斑没有。
    //   口径都在**原始灰度**上做（与 diff/背景场解耦），boardMed = 网格包围盒灰度中位。
    // ★ 八轮补（renjutool 数字棋子）：印手数数字的白子/黑子会同时骗过径向定色与
    //   填充度门 —— 用「壳环原始灰度」（0.30~0.42 格距，数字笔画够不到的棋子真身）
    //   + 「核心饱和度」（中性白身 vs 彩色盘面/亮斑）做二次定色，见 rawClassify。
    cv::Mat sat;
    {
        std::vector<cv::Mat> ch;
        cv::split(rgb, ch);
        cv::Mat mx, mn;
        cv::max(ch[0], ch[1], mx); cv::max(mx, ch[2], mx);
        cv::min(ch[0], ch[1], mn); cv::min(mn, ch[2], mn);
        cv::subtract(mx, mn, sat);
    }
    double boardMed = 0.0, boardSat = 0.0;
    {
        int bx0 = std::max(0, iRound(geo.x_lines.front())), bx1 = std::min(w - 1, iRound(geo.x_lines.back()));
        int by0 = std::max(0, iRound(geo.y_lines.front())), by1 = std::min(h - 1, iRound(geo.y_lines.back()));
        if (bx1 > bx0 && by1 > by0) {
            std::vector<uint8_t> all,alls;
            all.reserve((size_t)(bx1 - bx0 + 1) * (size_t)(by1 - by0 + 1));
            alls.reserve(all.capacity());
            for (int yy = by0; yy <= by1; ++yy) {
                const uint8_t* gp = gray.ptr<uint8_t>(yy);
                const uint8_t* sp = sat.ptr<uint8_t>(yy);
                for (int xx = bx0; xx <= bx1; ++xx) { all.push_back(gp[xx]); alls.push_back(sp[xx]); }
            }
            boardMed = (double)median(all);
            boardSat = (double)median(alls);
        }
        if (boardMed <= 1.0) boardMed = 255.0;
    }
    // 饱和度闸门：中性白身 vs 彩色盘面/亮斑。盘面不彩（boardSat≈0，黑白照片）时退到绝对小闸门
    double satGate = std::max(28.0, boardSat * 0.5);
    // 原始灰度采样：核心盘（r ≤ rfrac·格距）中位 / 环带（r0~r1·格距）中位
    auto rawMedDisc = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        std::vector<uint8_t> vals;
        vals.reserve((size_t)(rr * rr * 3 + 8));
        for (int dy = -rr; dy <= rr; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* gp = gray.ptr<uint8_t>(gy);
            int dxlim = (int)std::sqrt((double)rr * rr - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                vals.push_back(gp[gx]);
            }
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    // 原始灰度环带采样：r0~r1·格距 的壳环（数字笔画够不到的棋子真身）
    auto rawMedRing = [&](int ax, int ay, double r0frac, double r1frac) -> double {
        int r0 = iRound(spacing * r0frac), r1 = iRound(spacing * r1frac);
        if (r1 < 3) r1 = 3;
        if (r0 >= r1) r0 = r1 - 1;
        std::vector<uint8_t> vals;
        vals.reserve((size_t)((r1 * 2 + 1) * (r1 * 2 + 1) / 2));
        for (int dy = -r1; dy <= r1; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* gp = gray.ptr<uint8_t>(gy);
            for (int dx = -r1; dx <= r1; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                double rad = std::hypot((double)dx, (double)dy);
                if (rad < (double)r0 || rad > (double)r1) continue;
                vals.push_back(gp[gx]);
            }
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    // 核心盘饱和度中位：中性白身（印数字白子/无描边白子）远低于彩色盘面/亮斑
    auto rawSatDisc = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        std::vector<uint8_t> vals;
        vals.reserve((size_t)(rr * rr * 3 + 8));
        for (int dy = -rr; dy <= rr; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* sp = sat.ptr<uint8_t>(gy);
            int dxlim = (int)std::sqrt((double)rr * rr - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                vals.push_back(sp[gx]);
            }
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    // 壳环饱和度中位：真白子壳环是中性纯白；缩放模糊/光泽白子与木底混色后带木色
    auto rawSatRing = [&](int ax, int ay, double r0frac, double r1frac) -> double {
        int r0 = iRound(spacing * r0frac), r1 = iRound(spacing * r1frac);
        if (r1 < 3) r1 = 3;
        if (r0 >= r1) r0 = r1 - 1;
        std::vector<uint8_t> vals;
        for (int dy = -r1; dy <= r1; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* sp = sat.ptr<uint8_t>(gy);
            for (int dx = -r1; dx <= r1; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                double rad = std::hypot((double)dx, (double)dy);
                if (rad < (double)r0 || rad > (double)r1) continue;
                vals.push_back(sp[gx]);
            }
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    // 核心盘「高饱和彩块」占比：平台把「最后一手」标记（红方块/蓝点等）画在棋子中心时，
    // 核心盘里彩色像素占比会骤增（红标白子实测 0.55）—— 这是「标记」而非「棋子本色」。
    auto rawColoredFrac = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        long tot = 0, colored = 0;
        for (int dy = -rr; dy <= rr; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* sp = sat.ptr<uint8_t>(gy);
            int dxlim = (int)std::sqrt((double)rr * rr - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                ++tot;
                if (sp[gx] > satGate) ++colored;
            }
        }
        return tot > 0 ? (double)colored / (double)tot : 0.0;
    };
    // ★ 八轮二次定色（仅凭原始灰度/饱和度证据，独立于 diff 径向证据）：
    //   壳环深暗 + 核心偏暗 = 黑身；壳环亮于盘面 + 核心不暗 + 中性低饱和 = 白身。
    //   用于 a) decideColor 弃权时补判；b) 填充度门误杀时的二次机会（数字白子）。
    //   ⚠ 只在浅色盘（boardMed>140）启用：深色盘上「暗于盘面」的水印鬼影会被
    //   壳+核双暗规则误收编（对拍 B/deep_dark、B/dark_blue、K/深盘 回退教训）。
    auto rawClassify = [&](int ax, int ay) -> int {
        if (boardMed <= 140.0) return EMPTY;
        double coreRaw = rawMedDisc(ax, ay, 0.18);
        double shellRaw = rawMedRing(ax, ay, 0.30, 0.42);
        if (shellRaw < boardMed * 0.55 && coreRaw < boardMed * 0.80) return BLACK;
        // 白子：壳环亮于盘面 + 核/壳饱和度都中性。真白子壳环是中性纯白
        // （renjutool 1.24×；五林光泽 1.11×，饱和度 2~13）；缩放模糊/混色白子
        // 壳环带木色（J/0.6x 实测饱和度 90~96）—— 饱和度是主判据，亮度阈值
        // 只需 1.06（防 ≈盘面 亮斑）。
        if (shellRaw > boardMed * 1.06 && coreRaw > boardMed * 0.60) {
            if (rawSatDisc(ax, ay, 0.24) < satGate &&
                rawSatRing(ax, ay, 0.30, 0.42) < satGate) return WHITE;
        }
        // ★ 2026-09-27（用户截图像素级取证，tools/_forensics/）：平台把「最后一手」
        //   红方块直接印在白子中心 —— 核心盘中位被红色拉到深暗（实测 coreRaw=76 <
        //   0.60×盘面=112），上面的白子规则因「核不够亮」弃权 → 整颗白子被丢 →
        //   白子数少 1 → 轮次奇偶反转 → 面板恒「等待对手落子」且差分锚定无法自愈
        //   （红标一直在盘上，帧帧读数相同）。
        //   补救：核心盘被高饱和彩块占据（≥25%）+ 壳环是中性亮白 = 「白身印彩色标记」，
        //   按壳环定白。黑身印标记走上面的黑规则（壳深暗）不受影响；亮斑鬼影核心是
        //   中性低饱和的，凑不出 ≥25% 彩块占比，不会误伤。
        if (shellRaw > boardMed * 1.06 &&
            rawSatRing(ax, ay, 0.30, 0.42) < satGate &&
            rawColoredFrac(ax, ay, 0.18) >= 0.25) return WHITE;
        return EMPTY;
    };
    // 候选定色后的原始灰度护栏 + 数字棋子纠偏（返回最终颜色；EMPTY = 本格放弃）。
    // ★ 八轮（用户报两例）：
    //   a) 半透明水印鬼影：「黑」不够黑（核心盘灰度 ≈0.95×盘面）→ 拦下；
    //   b) 复盘图在手数数字：黑数字压暗白子核心 / 白数字压亮黑子核心 ——
    //      用**壳环**（0.30~0.42 格距，在棋子壳上、在数字外）的原始灰度判真身：
    //      壳环亮于盘面 = 白壳（印数字的白子）；壳环深暗 = 黑壳（印数字的黑子）。
    auto rawRefine = [&](int ax, int ay, int color) -> int {
        double coreRaw = rawMedDisc(ax, ay, 0.18);
        double shellRaw = rawMedRing(ax, ay, 0.30, 0.42);   // 壳环中位（数字笔画够不到的棋子真身）
        if (color == BLACK) {
            // ★ 壳环优先定真身（浅色盘）：壳亮 = 白身印黑数字（黑数字压暗核心骗过径向定色）；
            //   壳深暗 = 黑身印白数字（白数字压亮核心）；壳≈盘面且核不黑 = 水印鬼影
            if (boardMed > 140.0 && shellRaw > boardMed * 1.06) return WHITE;
            if (coreRaw > boardMed * 0.75) {
                if (boardMed > 140.0 && shellRaw < boardMed * 0.5) return BLACK;
                return EMPTY;
            }
        } else if (color == WHITE && boardMed > 140.0) {
            // 浅色盘：白子应有暗描边弧（环带最暗四分位明显暗于盘面）
            int r0i = iRound(spacing * 0.34), r1i = iRound(spacing * 0.44);
            std::vector<uint8_t> vals;
            for (int dy = -r1i; dy <= r1i; ++dy) {
                int gy = ay + dy; if (gy < 0 || gy >= h) continue;
                const uint8_t* gp = gray.ptr<uint8_t>(gy);
                for (int dx = -r1i; dx <= r1i; ++dx) {
                    int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                    double rad = std::hypot((double)dx, (double)dy);
                    if (rad < (double)r0i || rad > (double)r1i) continue;
                    vals.push_back(gp[gx]);
                }
            }
            if (vals.empty()) return EMPTY;
            std::vector<double> dv(vals.begin(), vals.end());
            if (percentile(dv, 25) > boardMed * 0.80) {
                // 无暗描边：a) 核心盘明显亮于盘面（≥1.12×）= 真白子（含光泽高光、
                //   缩放模糊白子 —— 对拍 J/整屏0.6x、I/五林 教训，这是八轮前的旧行为）；
                //   b) 否则看「中性低饱和亮壳」（renjutool 无描边/印数字白子画法）；
                //   ≈盘面亮度的候选 = 亮斑鬼影 → rawClassify 会拦下。
                if (coreRaw > boardMed * 1.12) return WHITE;
                return rawClassify(ax, ay);
            }
            // 核心亮（白数字）+ 壳环深暗（黑壳）= 印数字的黑子
            if (coreRaw > boardMed * 0.80 && shellRaw < boardMed * 0.5) return BLACK;
        }
        return color;
    };

    cv::Mat cellStat = cv::Mat::zeros(n, n, CV_32F);
    cv::Mat cellFill = cv::Mat::zeros(n, n, CV_32F);
    cv::Mat cellOut = cv::Mat::zeros(n, n, CV_32F);
    cv::Mat cellOutq(n, n, CV_32FC4, cv::Scalar(9999.f, 9999.f, 9999.f, 9999.f));
    cv::Mat cellEdge = cv::Mat::zeros(n, n, CV_32F);

    int hits = 0, cellHits = 0;
    int nY = (int)geo.y_lines.size(), nX = (int)geo.x_lines.size();

    // ★ 八轮调试：GB_VISION_TRACE="c:r,c:r"（引擎帧列:行）或 "all" → 逐格门控轨迹（stderr）
    const char* traceEnv = getenv("GB_VISION_TRACE");
    bool traceAll = traceEnv && strcmp(traceEnv, "all") == 0;
    std::set<std::pair<int,int>> traceCells;
    if (traceEnv && !traceAll) {
        const char* p0 = traceEnv;
        while (*p0) {
            char* endp = nullptr;
            long cval = strtol(p0, &endp, 10);
            if (endp == p0) break;
            p0 = endp;
            long rval = -1;
            if (*p0 == ':') { ++p0; rval = strtol(p0, (char**)&p0, 10); }
            traceCells.insert({(int)cval, (int)rval});
            if (*p0 == ',') ++p0; else break;
        }
    }
    auto traceOn = [&](int col, int row) {
        return traceAll || traceCells.count({col, row}) > 0;
    };
#define GB_TRACE(col, row, ...) do { if (traceOn(col, row)) { fprintf(stderr, "[trace %d:%d] ", col, row); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while(0)

    // ★ 2026-09-25（用户要求：识别提速，给引擎腾思考时间）：主逐格循环**按行分片并行**。
    //   线程安全性已逐项核对：循环体只写「自己的 (row,col)」（board/conf/cellStat/cellFill/
    //   cellOut/cellOutq/cellEdge 七个 n×n 表各写一格），所有辅助 lambda（rawMedDisc /
    //   rawMedRing / rawSatDisc / rawSatRing / rawClassify / rawRefine / decideColor /
    //   gatherI16 / plateauLikeMed / circularity）都是**读共享常量 + 产出局部值**，无静态
    //   可变状态；OpenCV 的 connectedComponentsWithStats / findContours / morphologyEx
    //   各线程独立实例，线程安全。计数器 hits / cellHits 改由各线程本地累计、汇合时相加。
    //   ★ 结果与串行版**逐格一致**：格子间零数据依赖，行分片只是调度顺序不同。
    //   GB_VISION_TRACE 开启时强制串行（轨迹输出按行序可读、可与旧日志逐行对拍）。
    auto processCell = [&](int row, int col, int& hits, int& cellHits) {
            int x = iRound(geo.x_lines[col]);
            int y = iRound(geo.y_lines[row]);
            if (!(x >= 0 && x < w && y >= 0 && y < h)) return;
            int xo = x, yo = y;                 // ★ 原图坐标（判「图内有效像素」用）
            x += pad; y += pad;
            // ★ 补零 padding = 「无数据」，**不是黑色**：贴图像边缘的交点（截图贴边棋子、
            //   残盘裁切）核心盘有一半在图外，把补零算进中位数/填充度的分母会把对比度
            //   稀释成 0、填充度拉低 → 真棋子被实心闸门误杀（与 Python 同口径）。
            cv::Mat validM(win, win, CV_8U, cv::Scalar(0));
            int discTotal = 0, discValid = 0;
            for (int rr2 = 0; rr2 < win; ++rr2) {
                uint8_t* vp = validM.ptr<uint8_t>(rr2);
                int gy = yo + (rr2 - half);
                for (int cc2 = 0; cc2 < win; ++cc2) {
                    int gx = xo + (cc2 - half);
                    bool inImg = (gx >= 0 && gx < w && gy >= 0 && gy < h);
                    vp[cc2] = inImg ? 1 : 0;
                    double rad = std::hypot((double)(cc2 - half), (double)(rr2 - half));
                    if (rad <= spacing * 0.44) { discTotal++; if (inImg) discValid++; }
                }
            }
            // ★ 必须 clone：patch 是**大于它的父矩阵** diff 的子视图（父宽 = 棋盘裁剪宽 + 2·pad），
            //   若只是视图，patch 就**不连续**，而 gatherI16 / 掩膜展平循环都用 `ptr(0)[i]` 做
            //   行主序线性寻址 —— 那会跨过 patch 边界读到父矩阵相邻列，取值全错。
            //   克隆成连续块后，展平下标与 Python 的 `patch[mask]` 语义完全一致。
            cv::Mat patch = diff(cv::Rect(x - half, y - half, win, win)).clone();

            int ri = cat(row, nY), ci = cat(col, nX);
            if (ri > 2) ri = 2;
            if (ci > 2) ci = 2;

            // ---- 逐格存在性判据 → 定「本格阈值」（木纹/照片底板上的浅色子）----
            std::vector<int16_t> coreV;    // ★ 只取图内有效像素（见上 validM）
            {
                cv::Mat cb;
                cv::bitwise_and(coreM.m, validM, cb);
                coreV = gatherI16(patch, makeMask(cb));
            }
            const MaskIdx& bgm = bgIdxCache[ri][ci];
            std::vector<int16_t> bgV;
            {
                cv::Mat bb;
                cv::bitwise_and(bgm.m, validM, bb);
                bgV = gatherI16(patch, makeMask(bb));
            }
            double thrCell = thr;
            double localC = 0.0;
            if (!coreV.empty() && !bgV.empty()) {
                localC = median(coreV) - median(bgV);
                // 核心盘内「与极性一致」的像素占比：形状无关的**填充度**证据，
                // 用来把「真棋子」与「只有网格线十字/文字」区分开（后者占比 <0.4）。
                double tFill = std::max(BASE_CONTRAST * 0.5, std::abs(localC) * CELL_FILL_REL);
                int cnt = 0;
                if (localC < 0) {
                    for (int16_t v : coreV) if ((double)v < -tFill) cnt++;
                } else {
                    for (int16_t v : coreV) if ((double)v > tFill) cnt++;
                }
                cellFill.at<float>(row, col) = float(double(cnt) / double(coreV.size()));
                if (std::abs(localC) >= CELL_CONTRAST_MIN) {
                    thrCell = std::max(BASE_CONTRAST, std::min(thr, std::abs(localC) * CELL_THR_RATIO));
                    cellHits++;
                }
                GB_TRACE(col, row, "localC=%.1f fill=%.2f thrCell=%.1f", localC, cellFill.at<float>(row, col), thrCell);
            }
            cellStat.at<float>(row, col) = (float)localC;

            const MaskIdx& om = outIdxCache[ri][ci];
            std::vector<int16_t> ov = gatherI16(patch, om);
            cellOut.at<float>(row, col) = ov.empty() ? 0.f : (float)median(ov);
            {
                const std::vector<MaskIdx>& qs = outQuadCache[ri][ci];
                float* qp = cellOutq.ptr<float>(row, col);
                for (size_t k = 0; k < qs.size() && k < 4; ++k) {
                    std::vector<int16_t> qv = gatherI16(patch, qs[k]);
                    if (!qv.empty()) qp[k] = (float)median(qv);
                }
            }
            {
                std::vector<int16_t> ev1 = gatherI16(patch, edgeInM);
                std::vector<int16_t> ev2 = gatherI16(patch, edgeOutM);
                double e = 0.0;
                if (!ev1.empty() && !ev2.empty()) e = std::abs(median(ev1) - median(ev2));
                cellEdge.at<float>(row, col) = (float)e;
            }

            // ---- 连通域形状验证 ----
            cv::Mat mask(win, win, CV_8U, cv::Scalar(0));
            {
                const int16_t* pp = patch.ptr<int16_t>(0);
                uint8_t* mp = mask.ptr<uint8_t>(0);
                for (int i = 0; i < win * win; ++i)
                    mp[i] = (std::abs((int)pp[i]) > thrCell) ? 1 : 0;
            }
            if ((double)cv::countNonZero(mask) < minArea * 0.6) {
                GB_TRACE(col, row, "REJECT tiny-mask nz=%d minArea*0.6=%.1f", (int)cv::countNonZero(mask), minArea * 0.6);
                return;
            }
            // 形态学开运算：抹掉 1~2px 宽的网格线毛刺（官方去噪手段）
            cv::morphologyEx(mask, mask, cv::MORPH_OPEN, kernel);

            cv::Mat labels, stats, cents;
            int cntN = cv::connectedComponentsWithStats(mask, labels, stats, cents, 8, CV_32S);
            int pick = -1;
            double best = -1e18;
            for (int i = 1; i < cntN; ++i) {
                double area = (double)stats.at<int32_t>(i, cv::CC_STAT_AREA);
                if (area < minArea || area > maxArea) continue;
                double dx = (double)cents.at<double>(i, 0) - half;
                double dy = (double)cents.at<double>(i, 1) - half;
                double dist = std::hypot(dx, dy);
                if (dist > spacing * 0.30) continue;   // 质心必须贴在交点上
                double score = area - dist * 6.0;
                if (score > best) { best = score; pick = i; }
            }
            if (pick < 0) {
                GB_TRACE(col, row, "REJECT no-blob (area/centroid)");
                return;
            }

            cv::Mat comp(win, win, CV_8U, cv::Scalar(0));
            for (int r = 0; r < win; ++r) {
                const int32_t* lp = labels.ptr<int32_t>(r);
                uint8_t* cpp = comp.ptr<uint8_t>(r);
                for (int c = 0; c < win; ++c) cpp[c] = (lp[c] == pick) ? 1 : 0;
            }
            std::vector<std::vector<cv::Point>> conts;
            std::vector<cv::Vec4i> hier;
            cv::findContours(comp, conts, hier, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
            if (conts.empty()) return;
            size_t bigI = 0;
            double bigA = -1;
            for (size_t i = 0; i < conts.size(); ++i) {
                double a = std::abs(cv::contourArea(conts[i]));
                if (a > bigA) { bigA = a; bigI = i; }
            }
            std::vector<cv::Point> big = conts[bigI];
            // ★ 实心圆盘闸门（2026-09-21 用户：a) 识别太敏感，木纹亮带 / 照片边缘暗带
            //   被读成棋子；b) 棋子是**实心圆**，开源实现普遍按填充度判）：
            //   假斑能凑出「有对比、面积够大、质心贴交点、圆度刚达标」，但核心盘的
            //   极性填充只有 ~0.45（中位差是暗带把背景拉出来的，核心盘根本没被填满）；
            //   真棋子实测 ≥0.9。⚠ 只用核心盘填充，不用「外接圆填充率」—— 深盘棋子的
            //   亮描边环/高光会把外接圆撑大或挖空，实测会误杀真棋子。
            // ★ 贴图边豁免（同日用户：**截断的棋子仍带圆弧**，不能一刀切）：棋子被图像
            //   边缘裁掉一块时填充度天然低 —— 只要本格对比证据够强且棋子盘确实被图像
            //   边裁过，就放行给后面的「圆度 / 平斑块」闸门把关。
            if ((double)cellFill.at<float>(row, col) < CELL_FILL_MAIN_MIN) {
                bool clipped = (discTotal > 0) &&
                               ((double)discValid < (double)discTotal * 0.98);
                // ★ 八轮：印手数数字的白子核心盘被数字压暗 → 极性填充度不足被误杀；
                //   壳环原始灰度+饱和度证据清晰时给二次机会（圆度/平斑块闸门仍在后面把关）
                int rawC = EMPTY;
                if (!(clipped && std::abs(localC) >= CELL_CONTRAST_MIN)) {
                    rawC = rawClassify(xo, yo);
                    if (rawC == EMPTY) {
                        GB_TRACE(col, row, "REJECT fill=%.2f < %.2f localC=%.1f", cellFill.at<float>(row, col), CELL_FILL_MAIN_MIN, localC);
                        return;
                    }
                }
            }
            double circ = circularity(big);
            if (circ < MIN_CIRCULARITY) {
                // 拟真「光泽棋子」复核：凸包圆度（高光+落影把掩膜切成新月时救回）
                std::vector<cv::Point> hp;
                cv::convexHull(big, hp);
                double hcirc = circularity(hp);
                double harea = std::abs(cv::contourArea(hp));
                if (hcirc < HULL_CIRC_MIN || harea > maxArea) {
                    GB_TRACE(col, row, "REJECT circ=%.2f hull=%.2f", circ, hcirc);
                    return;
                }
                circ = hcirc;
                comp = cv::Mat::zeros(win, win, CV_8U);
                std::vector<std::vector<cv::Point>> one{hp};
                cv::drawContours(comp, one, -1, cv::Scalar(1), -1);
            }

            // ★ 平斑块闸门（2026-09-19 反识别）
            {
                std::vector<int16_t> ov2 = gatherI16(patch, om);
                std::vector<double> quadMeds;
                const std::vector<MaskIdx>& qs = outQuadCache[ri][ci];
                for (const MaskIdx& qm : qs) {
                    std::vector<int16_t> qv = gatherI16(patch, qm);
                    if (!qv.empty()) quadMeds.push_back(median(qv));
                }
                bool plateau = plateauLikeMed(ov.empty() ? 0.0 : median(ov), localC) ||
                               quadsPlateauVals(quadMeds, localC);
                std::vector<int16_t> e1 = gatherI16(patch, edgeInM);
                std::vector<int16_t> e2 = gatherI16(patch, edgeOutM);
                double edge = 0.0;
                if (!e1.empty() && !e2.empty()) edge = std::abs(median(e1) - median(e2));
                if (plateauGateVeto(plateau, localC, edge)) {
                    GB_TRACE(col, row, "REJECT plateau=%d edge=%.1f", (int)plateau, edge);
                    return;
                }
            }

            auto dc = decideColor(patch, coreM, ringM, ringSec, thrCell);
            int color = dc.first;
            double cconf = dc.second;
            GB_TRACE(col, row, "decideColor=%d conf=%.2f", (int)color, cconf);
            if (color == EMPTY) {
                // ★ 八轮：径向证据弃权（数字搅乱核心/环带极性）时，
                //   先用原始灰度壳环+饱和度补判，再回退旧「整块中位数」判法
                int rawC0 = rawClassify(xo, yo);
                if (rawC0 != EMPTY) {
                    board.at<int8_t>(row, col) = (int8_t)rawC0;
                    conf.at<float>(row, col) = 0.5f;
                    hits++;
                    GB_TRACE(col, row, "COMMIT rawClassify=%d", (int)rawC0);
                    return;
                }
                // 新证据不足以定色时，回退到旧的「整块中位数」判法，避免已有场景回归
                std::vector<int16_t> vals;
                const uint8_t* cp = comp.ptr<uint8_t>(0);
                const int16_t* pp = patch.ptr<int16_t>(0);
                for (int i = 0; i < win * win; ++i) if (cp[i]) vals.push_back(pp[i]);
                if (vals.empty()) return;
                double med = median(vals);
                if (std::abs(med) < thrCell * 0.75) {
                    GB_TRACE(col, row, "REJECT fallback-med=%.1f thr*0.75=%.1f", med, thrCell * 0.75);
                    return;
                }
                color = med > 0 ? WHITE : BLACK;
                cconf = std::min(1.0, 0.6 * std::min(1.0, std::abs(med) / (thrCell * 3.0)) + 0.4 * circ);
                if (color == BLACK) {
                    // 旧判法给出的「黑」可能是描边环伪装：内盘若明显不暗，改判白
                    int neg = 0, pos = 0;
                    for (int16_t v : coreV) {
                        if ((double)v < -thrCell) neg++;
                        if ((double)v > thrCell) pos++;
                    }
                    double m = coreV.empty() ? 0.0 : (double)coreV.size();
                    if (m > 0 && double(neg) / m < 0.2 && double(pos) / m < 0.2) {
                        color = WHITE;
                        cconf = 0.5;
                    }
                }
            }
            // ★ 八轮：原始灰度护栏 + 数字棋子纠偏 —— 水印鬼影、反光亮斑拦下
            int refC = rawRefine(xo, yo, color);
            if (refC == EMPTY) {
                GB_TRACE(col, row, "REJECT rawRefine EMPTY (color=%d)", (int)color);
                return;
            }
            GB_TRACE(col, row, "COMMIT color=%d -> %d", (int)color, refC);
            board.at<int8_t>(row, col) = (int8_t)refC;
            conf.at<float>(row, col) = (float)std::min(1.0, cconf);
            hits++;
    };

    // ---- 调度：默认按 CPU 核数分行并行（上限 8 线程）；trace 开启 / 单核 → 串行 ----
    //   （hits / cellHits 在前面已声明，这里本地累计后写回）
    {
        unsigned hw = std::thread::hardware_concurrency();
        bool canPar = (!traceEnv) && hw > 1;           // traceEnv 非 null = 有人在追轨迹 → 串行
        int T = canPar ? (int)std::min<unsigned>(hw, 8u) : 1;
        if (T > 1) {
            std::atomic<int> hitsSum{0}, cellSum{0};
            std::vector<std::thread> ths;
            ths.reserve(T);
            for (int t = 0; t < T; ++t) {
                ths.emplace_back([&, t]() {
                    int hL = 0, cL = 0;
                    for (int row = t; row < nY && row < n; row += T)
                        for (int col = 0; col < nX && col < n; ++col)
                            processCell(row, col, hL, cL);
                    hitsSum.fetch_add(hL, std::memory_order_relaxed);
                    cellSum.fetch_add(cL, std::memory_order_relaxed);
                });
            }
            for (auto& th : ths) th.join();
            hits = hitsSum.load(std::memory_order_relaxed);
            cellHits = cellSum.load(std::memory_order_relaxed);
        } else {
            int hL = 0, cL = 0;
            for (int row = 0; row < nY && row < n; ++row)
                for (int col = 0; col < nX && col < n; ++col)
                    processCell(row, col, hL, cL);
            hits = hL; cellHits = cL;
        }
    }

    if (const char* dcell = getenv("GB_VISION_DUMP_CELL")) {
        FILE* fp = fopen(dcell, "wb");
        if (fp) {
            fprintf(fp, "%d %d hits=%d cellHits=%d thr=%.4f half=%d pad=%d\n",
                    n, n, hits, cellHits, thr, half, pad);
            for (int r = 0; r < n; ++r) {
                for (int c = 0; c < n; ++c) fprintf(fp, "%.4f,", cellStat.at<float>(r, c));
                fprintf(fp, "\n");
            }
            for (int r = 0; r < n; ++r) {
                for (int c = 0; c < n; ++c) fprintf(fp, "%.4f,", cellFill.at<float>(r, c));
                fprintf(fp, "\n");
            }
            fclose(fp);
        }
    }

    // ---- 逐格中位数兜底：木纹 / 照片底板 + 「高光白子」的画法 ----
    // ⚠ 必须放在**描边兜底之前**：描边兜底是给「中性内盘 + 深色描边环」那种画法用的。
    int cellRescued = 0;
    for (int row = 0; row < n; ++row) {
        for (int col = 0; col < n; ++col) {
            if (board.at<int8_t>(row, col) != EMPTY) continue;
            double lc = cellStat.at<float>(row, col);
            if (std::abs(lc) < CELL_CONTRAST_MIN ||
                cellFill.at<float>(row, col) < CELL_FILL_MIN) continue;
            std::vector<double> qv;
            const float* qp = cellOutq.ptr<float>(row, col);
            for (int k = 0; k < 4; ++k) if (qp[k] < 9000.0) qv.push_back((double)qp[k]);
            bool plateau = plateauLikeMed(cellOut.at<float>(row, col), lc) ||
                           quadsPlateauVals(qv, lc);
            if (plateauGateVeto(plateau, lc, cellEdge.at<float>(row, col))) continue;
            // ★ 八轮：原始灰度护栏（与主循环/描边兜底同源）—— 救援路径也要过闸，
            //   否则水印鬼影从这里溜进来（现场：cell_rescued=1 = 假黑子 H2）
            {
                int rcol = rawRefine(geo.x_lines[col], geo.y_lines[row], (lc < 0) ? BLACK : WHITE);
                if (rcol == EMPTY) continue;
                board.at<int8_t>(row, col) = (int8_t)rcol;
                conf.at<float>(row, col) = 0.6f;
                cellRescued++;
            }
        }
    }

    // ---- 描边线索兜底：底色≈白子亮度时，填充对比度趋零，只能靠"空心圆"识别 ----
    int outlineHits = 0;
    {
        bool anyEmpty = false;
        for (int r = 0; r < n && !anyEmpty; ++r) {
            const int8_t* p = board.ptr<int8_t>(r);
            for (int c = 0; c < n; ++c) if (p[c] == EMPTY) { anyEmpty = true; break; }
        }
        if (anyEmpty) {
            cv::Mat distMap(win, win, CV_32F);
            for (int r = 0; r < win; ++r)
                for (int c = 0; c < win; ++c) {
                    double xx = (double)(c - half), yy = (double)(r - half);
                    distMap.at<float>(r, c) = (float)std::hypot(xx, yy);
                }
            cv::Mat innerB(win, win, CV_8U, cv::Scalar(0)), outRingB(win, win, CV_8U, cv::Scalar(0));
            for (int r = 0; r < win; ++r)
                for (int c = 0; c < win; ++c) {
                    float d = distMap.at<float>(r, c);
                    if (d <= spacing * 0.26) innerB.at<uint8_t>(r, c) = 1;
                    if (d >= spacing * 0.36 && d <= spacing * 0.52) outRingB.at<uint8_t>(r, c) = 1;
                }
            MaskIdx innerM = makeMask(innerB), outRingM = makeMask(outRingB);

            for (int row = 0; row < nY && row < n; ++row) {
                for (int col = 0; col < nX && col < n; ++col) {
                    if (board.at<int8_t>(row, col) != EMPTY) continue;
                    int x = iRound(geo.x_lines[col]);
                    int y = iRound(geo.y_lines[row]);
                    if (!(x >= 0 && x < w && y >= 0 && y < h)) continue;
                    x += pad; y += pad;
                    // ★ 必须 clone（与主循环同教训）：patch 是**大于它的父矩阵** diff 的
                    //   子视图（不连续），而 gatherI16 / 掩膜展平循环用 ptr(0)[i] 行主序
                    //   线性寻址 —— 视图不 clone 会读到跨列错位数据，描边兜底全灭
                    //   （现场：白底白子盘 outline_hits=0，白子全丢）。
                    cv::Mat patch = diff(cv::Rect(x - half, y - half, win, win)).clone();
                    if (patch.rows != innerM.m.rows || patch.cols != innerM.m.cols) continue;

                    std::vector<int16_t> coreV = gatherI16(patch, coreM);
                    double coreMed = coreV.empty() ? 0.0 : median(coreV);
                    int ri = cat(row, nY), ci = cat(col, nX);
                    if (ri > 2) ri = 2;
                    if (ci > 2) ci = 2;
                    std::vector<int16_t> omV = gatherI16(patch, outIdxCache[ri][ci]);
                    std::vector<double> quadMeds;
                    for (const MaskIdx& qm : outQuadCache[ri][ci]) {
                        std::vector<int16_t> qv = gatherI16(patch, qm);
                        if (!qv.empty()) quadMeds.push_back(median(qv));
                    }
                    std::vector<int16_t> e1 = gatherI16(patch, edgeInM);
                    std::vector<int16_t> e2 = gatherI16(patch, edgeOutM);
                    double edge = 0.0;
                    if (!e1.empty() && !e2.empty()) edge = std::abs(median(e1) - median(e2));
                    bool plateau = plateauLikeMed(omV.empty() ? 0.0 : median(omV), coreMed) ||
                                   quadsPlateauVals(quadMeds, coreMed);
                    if (plateauGateVeto(plateau, coreMed, edge)) continue;   // ★ 平斑块闸门（与主循环同源）

                    // ① 径向证据（带角向连续性验证，覆盖「多半圈描边 + 阴影」的画法）
                    auto dc = decideColor(patch, coreM, ringM, ringSec, thr);
                    if (dc.first != EMPTY) {
                        int refC = rawRefine(x - pad, y - pad, dc.first);
                        if (refC == EMPTY) continue;   // ★ 八轮：原始灰度护栏
                        board.at<int8_t>(row, col) = (int8_t)refC;
                        conf.at<float>(row, col) = (float)std::min(0.5, dc.second);
                        outlineHits++;
                        continue;
                    }
                    // ② 旧兜底：内盘平坦 + 环带整体偏暗/偏亮
                    std::vector<int16_t> inner = gatherI16(patch, innerM);
                    std::vector<int16_t> ring = gatherI16(patch, outRingM);
                    if (inner.empty() || ring.empty()) continue;
                    {
                        std::vector<double> av(inner.size());
                        for (size_t i = 0; i < inner.size(); ++i) av[i] = std::abs((double)inner[i]);
                        if (percentile(av, 90) >= thr) continue;   // 内盘不平坦（网格十字）→ 非棋子
                    }
                    int dark = 0, bright = 0;
                    for (int16_t v : ring) {
                        if ((double)v < -thr) dark++;
                        if ((double)v > thr) bright++;
                    }
                    double dr = double(dark) / double(ring.size());
                    double br = double(bright) / double(ring.size());
                    if (dr >= 0.45 && br < 0.15) {
                        if (rawRefine(x - pad, y - pad, WHITE) == EMPTY) continue;  // ★ 八轮：护栏
                        board.at<int8_t>(row, col) = WHITE;
                        conf.at<float>(row, col) = 0.45f;
                        outlineHits++;
                    } else if (br >= 0.45 && dr < 0.15) {
                        if (rawRefine(x - pad, y - pad, BLACK) == EMPTY) continue;  // ★ 八轮：护栏
                        board.at<int8_t>(row, col) = BLACK;
                        conf.at<float>(row, col) = 0.45f;
                        outlineHits++;
                    }
                }
            }
        }
    }

    // ★ 外边界伪棋子清理：必须在 invariants 之前做
    int removed = stripBorderArtifacts(board, &conf);

    diag = Json::makeObj();
    diag.set("method", Json::makeStr("adaptive"));
    diag.set("threshold", Json::makeNum(npRound(thr * 100.0) / 100.0));
    diag.set("noise_sigma", Json::makeNum(npRound(sigma * 100.0) / 100.0));
    diag.set("cell_contrast_hits", Json::makeInt(cellHits));
    diag.set("cell_rescued", Json::makeInt(cellRescued));
    diag.set("blob_hits", Json::makeInt(hits));
    diag.set("outline_hits", Json::makeInt(outlineHits));
    diag.set("border_artifacts", Json::makeInt(removed));
    Json inv = invariants(board);
    for (auto& kv : inv.obj) diag.set(kv.first, kv.second);
    // round(x, 2) 与 Python 的 round 同为「四舍六入五成双」，这里用 nearbyint 对齐
}

// =====================================================================
// Hough 网格定位兜底
// =====================================================================

cv::Mat autoCanny(const cv::Mat& gray, double sigma) {
    std::vector<double> v;
    v.reserve((size_t)gray.rows * gray.cols);
    for (int r = 0; r < gray.rows; ++r) {
        const uint8_t* p = gray.ptr<uint8_t>(r);
        for (int c = 0; c < gray.cols; ++c) v.push_back((double)p[c]);
    }
    double med = median(std::move(v));
    double lo = (double)(int)std::max(0.0, (1.0 - sigma) * med);
    double hi = (double)(int)std::min(255.0, (1.0 + sigma) * med);
    cv::Mat edges;
    cv::Canny(gray, edges, lo, hi, 3);
    return edges;
}

namespace {

/**
 * 把检测到的线位置拟合成「等距 count 线」模型 o + k·d（RANSAC 思路）。
 * 实测深色主题下朴素 ICP 会停在「步距 76、原点偏 30px」的假网格上，故必须走这套。
 */
bool fitLattice(const std::vector<double>& positions, int count,
                double& oOut, double& dOut, double& residOut) {
    if (positions.size() < 4) return false;
    std::vector<double> p = positions;
    std::sort(p.begin(), p.end());
    double span = p.back() - p.front();
    if (span < 10.0) return false;
    double tol = std::max(2.0, span * 0.01);
    std::vector<double> merged;
    merged.push_back(p[0]);
    for (size_t i = 1; i < p.size(); ++i) {
        if (p[i] - merged.back() <= tol) merged.back() = (merged.back() + p[i]) / 2.0;
        else merged.push_back(p[i]);
    }
    std::vector<double>& m = merged;
    if (m.size() < (size_t)std::max(4, (int)(count * 0.5))) return false;

    std::map<int, int> gapCnt;
    for (size_t i = 1; i < m.size(); ++i) {
        int g = iRound(m[i] - m[i - 1]);
        if (g >= 3) gapCnt[g]++;
    }
    if (gapCnt.empty()) return false;
    int base = 0, bestCnt = -1;
    for (auto& kv : gapCnt)   // map 已按 key 升序 → 并列取最小，与 np.unique+argmax 一致
        if (kv.second > bestCnt) { bestCnt = kv.second; base = kv.first; }
    double baseD = (double)base;

    bool haveBest = false;
    double bestResid = 0, bestO = 0, bestD = 0;
    for (double o0 : m) {
        std::vector<double> k(m.size());
        for (size_t i = 0; i < m.size(); ++i) k[i] = npRound((m[i] - o0) / baseD);
        // np.unique(k).size
        std::vector<double> ks = k;
        std::sort(ks.begin(), ks.end());
        ks.erase(std::unique(ks.begin(), ks.end()), ks.end());
        if ((double)ks.size() < (double)m.size() * 0.8) continue;
        double slope, intercept;
        polyfit1(k, m, slope, intercept);
        if (slope <= 1.0) continue;
        double s = 0;
        for (size_t i = 0; i < m.size(); ++i)
            s += std::abs(m[i] - (intercept + slope * k[i]));
        double resid = (s / (double)m.size()) / slope;
        if (!haveBest || resid < bestResid) {
            haveBest = true; bestResid = resid; bestO = intercept; bestD = slope;
        }
    }
    if (!haveBest) return false;
    double o = bestO, d = bestD;

    // ICP 微调（只做小幅收敛；整体对齐交给 _snap_lattice）
    for (int iter = 0; iter < 4; ++iter) {
        std::vector<double> model = ramp(o, d, count);
        std::vector<double> dist(count, 0.0);
        std::vector<int> argminIdx(count, 0);
        for (int i = 0; i < count; ++i) {
            double bd = 1e300; int bi = 0;
            for (size_t j = 0; j < m.size(); ++j) {
                double dd = std::abs(m[j] - model[i]);
                if (dd < bd) { bd = dd; bi = (int)j; }
            }
            dist[i] = bd; argminIdx[i] = bi;
        }
        int selCount = 0;
        for (int i = 0; i < count; ++i) if (dist[i] < d * 0.3) selCount++;
        if ((double)selCount < count * 0.5) return false;
        std::vector<double> selX, claimed;
        std::vector<int> uniq;
        for (int i = 0; i < count; ++i) {
            if (dist[i] < d * 0.3) {
                selX.push_back((double)i);
                claimed.push_back(m[argminIdx[i]]);
                uniq.push_back(argminIdx[i]);
            }
        }
        std::sort(uniq.begin(), uniq.end());
        uniq.erase(std::unique(uniq.begin(), uniq.end()), uniq.end());
        if ((double)uniq.size() < (double)selCount * 0.8) return false;
        double slope, intercept;
        polyfit1(selX, claimed, slope, intercept);
        bool converged = (std::abs(slope - d) < 1e-3 && std::abs(intercept - o) < 1e-3);
        o = intercept; d = slope;
        if (converged) break;
    }
    if (d <= 1.0) return false;
    std::vector<double> model = ramp(o, d, count);
    double s = 0;
    for (int i = 0; i < count; ++i) {
        double bd = 1e300, bv = 0;
        for (size_t j = 0; j < m.size(); ++j) {
            double dd = std::abs(m[j] - model[i]);
            if (dd < bd) { bd = dd; bv = m[j]; }
        }
        s += std::abs(bv - model[i]);
    }
    oOut = o; dOut = d; residOut = (s / (double)count) / d;
    return true;
}

/** 候选线上的「线感」强度 = |线上中位数 − 两侧背景中位数|（极性无关） */
double lineEvidence(const cv::Mat& gray, int pos, int axis, double d, int W, int H) {
    int off = std::max(4, (int)(d * 0.3));
    auto colMedian = [&](int x) {
        std::vector<double> v(H);
        for (int y = 0; y < H; ++y) v[y] = (double)gray.at<uint8_t>(y, x);
        return median(std::move(v));
    };
    auto rowMedian = [&](int y) {
        std::vector<double> v(W);
        const uint8_t* p = gray.ptr<uint8_t>(y);
        for (int x = 0; x < W; ++x) v[x] = (double)p[x];
        return median(std::move(v));
    };
    if (axis == 0) {
        if (pos - off < 0 || pos + off >= W) return 0.0;
        double on = colMedian(pos);
        double bg = (colMedian(pos - off) + colMedian(pos + off)) / 2.0;
        return std::abs(on - bg);
    }
    if (pos - off < 0 || pos + off >= H) return 0.0;
    double on = rowMedian(pos);
    double bg = (rowMedian(pos - off) + rowMedian(pos + off)) / 2.0;
    return std::abs(on - bg);
}

/** 确定等距格的整体对齐（原点）—— 判别顺序：线感证据 → 网格居中 */
double snapLattice(const cv::Mat& gray, double o, double d, int count, int axis,
                   int W, int H, int& strongOut) {
    double span = (double)(axis == 0 ? W : H);
    double center = span / 2.0;
    double total = (count - 1) * d;
    strongOut = 0;
    if (d <= 1.0) return o;
    std::vector<std::array<double, 3>> cands;   // (strong, -drift, oo)
    int tLo = (int)std::floor((-2.0 - o) / d);
    int tHi = (int)std::ceil((span + 2.0 - total - o) / d);
    for (int t = tLo; t <= tHi; ++t) {
        double oo = o + t * d;
        double first = oo, last = oo + d * (count - 1);
        if (first < -2 || last > span + 2) continue;
        int strong = 0;
        for (int i = 0; i < count; ++i) {
            double v = oo + d * i;
            if (lineEvidence(gray, iRound(v), axis, d, W, H) > 6.0) strong++;
        }
        double drift = std::abs((first + last) / 2.0 - center);
        cands.push_back({(double)strong, -drift, oo});
    }
    if (cands.empty()) return o;
    double bestStrong = -1e300;
    for (auto& c : cands) bestStrong = std::max(bestStrong, c[0]);
    std::vector<std::array<double, 3>> tied;
    for (auto& c : cands) if (c[0] >= bestStrong) tied.push_back(c);
    std::stable_sort(tied.begin(), tied.end(),
                     [](const std::array<double, 3>& a, const std::array<double, 3>& b) {
                         return a[1] > b[1];
                     });
    strongOut = (int)tied[0][0];
    return tied[0][2];
}

}  // namespace

bool locateGridHough(const cv::Mat& gray, int lineCount,
                     std::vector<double>& xs, std::vector<double>& ys, double& residual) {
    cv::Mat edges = autoCanny(gray);
    int h = gray.rows, w = gray.cols;
    double minLen = std::min(h, w) * 0.35;
    std::vector<cv::Vec4i> segs;
    cv::HoughLinesP(edges, segs, 1, CV_PI / 180.0, 60,
                    (int)minLen, (int)(minLen * 0.04));
    if (segs.empty()) return false;
    std::vector<double> vx, hy;
    for (const cv::Vec4i& s : segs) {
        double x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
        double ang = std::abs(std::atan2(y2 - y1, x2 - x1) * 180.0 / CV_PI);
        if (ang < 6.0) hy.push_back((y1 + y2) / 2.0);
        else if (std::abs(ang - 90.0) < 6.0) vx.push_back((x1 + x2) / 2.0);
    }
    double ox0, dx, rx0, oy0, dy, ry0;
    if (!fitLattice(vx, lineCount, ox0, dx, rx0)) return false;
    if (!fitLattice(hy, lineCount, oy0, dy, ry0)) return false;
    int strongX = 0, strongY = 0;
    double ox = snapLattice(gray, ox0, dx, lineCount, 0, w, h, strongX);
    double oy = snapLattice(gray, oy0, dy, lineCount, 1, w, h, strongY);
    if (std::min(strongX, strongY) < lineCount * 0.5) return false;

    xs = ramp(ox, dx, lineCount);
    ys = ramp(oy, dy, lineCount);
    if (xs.front() < -2 || ys.front() < -2 || xs.back() > w + 2 || ys.back() > h + 2)
        return false;

    // 残差只看「确实匹配到检测线」的那些模型线
    auto score = [&](const std::vector<double>& positions, const std::vector<double>& arr,
                     double d) -> std::pair<double, double> {
        if (positions.empty() || d <= 1.0) return {1.0, 0.0};
        std::vector<double> dist(positions.size(), 0.0);
        bool anyHit = false;
        int hit = 0;
        double sum = 0;
        for (size_t i = 0; i < positions.size(); ++i) {
            double bd = 1e300;
            for (double a : arr) bd = std::min(bd, std::abs(positions[i] - a));
            dist[i] = bd;
            if (bd < d * 0.3) { anyHit = true; hit++; sum += bd; }
        }
        double ratio = double(hit) / double(positions.size());
        double resid = anyHit ? (sum / double(hit)) / d : 1.0;
        return {resid, ratio};
    };
    auto sx = score(vx, xs, dx);
    auto sy = score(hy, ys, dy);
    if ((sx.second + sy.second) / 2.0 < 0.5) return false;
    residual = (sx.first + sy.first) / 2.0;
    return true;
}

}  // namespace gb
