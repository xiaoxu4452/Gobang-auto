// gb.h —— 五子棋识别引擎公共层
// =====================================================================
// 这里是「原本由 numpy 提供」的那部分能力（中位数/分位数/直方图众数/
// 卷积/最小二乘/排序索引），以及 JSON 与 base64。
//
// ★ 数值语义必须与 numpy 逐条对齐，否则疫苗矩阵会漂：
//   · np.median —— 偶数长度取中间两数的**算术平均**
//   · np.percentile(..., method='linear') —— idx = q/100*(n-1)，线性内插
//   · np.argmax —— 返回**第一个**最大值下标
//   · np.bincount + np.convolve(...,'same') —— 零填充同长卷积
//   · np.polyfit(k, m, 1) —— 最小二乘 ax+b
#pragma once

// Windows 的 windef.h 会把 min/max 定义成宏，直接和 std::min/std::max 打架
// （报错形态是 C2589 「'(' 右边非法记号」）。必须在任何 Windows 头之前关掉。
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
// OpenCV 5.0 把轮廓几何（contourArea / arcLength / convexHull …）拆到了独立的
// geometry 模块 —— 它是 imgproc 的依赖，静态链接时一并带上。
#include <opencv2/geometry.hpp>
#include <opencv2/imgcodecs.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <numeric>
#include <string>
#include <utility>
#include <vector>

namespace gb {

// 面板约定（与 gomoku_assistant.engine 一致）
constexpr int EMPTY = 0;
constexpr int BLACK = 1;
constexpr int WHITE = -1;

struct Geometry;

// 数值助手前置声明（Geometry::spacing() 需要 medianDiff）
inline double medianDiff(const std::vector<double>& v);

struct Geometry {
    std::vector<double> x_lines;
    std::vector<double> y_lines;
    double confidence = 0.0;
    std::string source = "auto";
    int screen_left = 0;
    int screen_top = 0;

    int size() const { return (int)x_lines.size(); }

    /** 平均格距（Python BoardGeometry.spacing：两轴中位格距的均值） */
    double spacing() const {
        return (medianDiff(x_lines) + medianDiff(y_lines)) / 2.0;
    }
    /** (x0, y0, x1, y1) —— Python BoardGeometry.bounds */
    void bounds(int& x0, int& y0, int& x1, int& y1) const {
        x0 = (int)std::nearbyint(x_lines.front());
        y0 = (int)std::nearbyint(y_lines.front());
        x1 = (int)std::nearbyint(x_lines.back());
        y1 = (int)std::nearbyint(y_lines.back());
    }
};

// ---------------------------------------------------------------- 数值

inline double medianSorted(std::vector<double>& v) {
    if (v.empty()) return 0.0;
    size_t n = v.size();
    // ★ 2026-09-25（识别提速）：全量 std::sort（O(N log N)）→ std::nth_element（O(N) 选择）。
    //   返回值与排序法**逐位相同**（奇数取正中；偶数 = 上中位 + 下中位（前半最大值）的平均），
    //   调用方全部经按值拷贝的 median()/medianAbsDev() 进来，无任何人依赖「v 被排好序」
    //   的副作用。estimateBackground / noiseSigma 在 200 万像素上各要两次取中位，
    //   全排序是识别延迟的头号热点之一。
    if (n % 2 == 1) {
        std::nth_element(v.begin(), v.begin() + (std::ptrdiff_t)(n / 2), v.end());
        return v[n / 2];
    }
    std::nth_element(v.begin(), v.begin() + (std::ptrdiff_t)(n / 2), v.end());
    double hi = v[n / 2];
    double lo = *std::max_element(v.begin(), v.begin() + (std::ptrdiff_t)(n / 2));
    return (lo + hi) / 2.0;
}

inline double median(std::vector<double> v) { return medianSorted(v); }

inline double median(const std::vector<int16_t>& src) {
    std::vector<double> v(src.begin(), src.end());
    return medianSorted(v);
}

inline double median(const std::vector<uint8_t>& src) {
    std::vector<double> v(src.begin(), src.end());
    return medianSorted(v);
}

inline double median(const std::vector<float>& src) {
    std::vector<double> v(src.begin(), src.end());
    return medianSorted(v);
}

/** numpy.percentile(..., method='linear')：空数组 → NaN（调用方需自行保底） */
inline double percentile(std::vector<double> v, double q) {
    if (v.empty()) return std::numeric_limits<double>::quiet_NaN();
    std::sort(v.begin(), v.end());
    size_t n = v.size();
    if (n == 1) return v[0];
    double idx = (q / 100.0) * double(n - 1);
    double lo = std::floor(idx), hi = std::ceil(idx);
    size_t ilo = (size_t)std::max(0.0, std::min(lo, double(n - 1)));
    size_t ihi = (size_t)std::max(0.0, std::min(hi, double(n - 1)));
    if (ilo == ihi) return v[ilo];
    double frac = idx - lo;
    return v[ilo] + (v[ihi] - v[ilo]) * frac;
}

/** 1.4826 × MAD —— 鲁棒噪声估计（numpy 版见 adaptive._noise_sigma） */
inline double medianAbsDev(std::vector<double> v) {
    if (v.empty()) return 0.0;
    double med = medianSorted(v);
    std::vector<double> dev(v.size());
    for (size_t i = 0; i < v.size(); ++i) dev[i] = std::abs(v[i] - med);
    return 1.4826 * medianSorted(dev);
}

inline double mean(const std::vector<double>& v) {
    if (v.empty()) return 0.0;
    double s = 0.0;
    for (double x : v) s += x;
    return s / double(v.size());
}

/** 总体标准差（np.std 默认 ddof=0） */
inline double stddev(const std::vector<double>& v) {
    if (v.empty()) return 0.0;
    double m = mean(v), s = 0.0;
    for (double x : v) s += (x - m) * (x - m);
    return std::sqrt(s / double(v.size()));
}

/** np.diff */
inline std::vector<double> diff(const std::vector<double>& v) {
    std::vector<double> out;
    if (v.size() < 2) return out;
    out.resize(v.size() - 1);
    for (size_t i = 1; i < v.size(); ++i) out[i - 1] = v[i] - v[i - 1];
    return out;
}

inline double medianDiff(const std::vector<double>& v) { return median(diff(v)); }

/** np.linspace(start, stop, num) */
inline std::vector<double> linspace(double start, double stop, int num) {
    std::vector<double> out;
    if (num <= 0) return out;
    out.resize(num);
    if (num == 1) { out[0] = start; return out; }
    double step = (stop - start) / double(num - 1);
    for (int i = 0; i < num; ++i) out[i] = start + step * i;
    out[num - 1] = stop;   // 与 numpy 一致：末点严格等于 stop
    return out;
}

/** np.arange(count) 的值：o + d*k */
inline std::vector<double> ramp(double o, double d, int count) {
    std::vector<double> out(count);
    for (int i = 0; i < count; ++i) out[i] = o + d * i;
    return out;
}

/** np.polyfit(x, y, 1) → (slope, intercept) */
inline void polyfit1(const std::vector<double>& x, const std::vector<double>& y,
                     double& slope, double& intercept) {
    size_t n = std::min(x.size(), y.size());
    if (n == 0) { slope = 0.0; intercept = 0.0; return; }
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (size_t i = 0; i < n; ++i) {
        sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i];
    }
    double dn = double(n);
    double den = dn * sxx - sx * sx;
    if (std::abs(den) < 1e-12) { slope = 0.0; intercept = sy / dn; return; }
    slope = (dn * sxy - sx * sy) / den;
    intercept = (sy - slope * sx) / dn;
}

/** np.argsort（稳定排序，与 numpy 默认 quicksort 的并列行为不同，但并列时只取位置值，可接受） */
inline std::vector<int> argsort(const std::vector<double>& v) {
    std::vector<int> idx(v.size());
    std::iota(idx.begin(), idx.end(), 0);
    std::stable_sort(idx.begin(), idx.end(),
                     [&v](int a, int b) { return v[a] < v[b]; });
    return idx;
}

/** 灰度直方图众数（先做 5 点滑动平均抑制噪声尖峰）—— adaptive._global_mode */
inline int globalMode(const cv::Mat& gray) {
    double hist[256] = {0};
    int total = gray.rows * gray.cols;
    const uint8_t* p = gray.ptr<uint8_t>(0);
    for (int i = 0; i < total; ++i) hist[p[i]] += 1.0;
    // np.convolve(hist, ones(5)/5, 'same')：零填充，长度 5 的对称核
    double sm[256];
    for (int i = 0; i < 256; ++i) {
        double s = 0.0;
        for (int j = 0; j < 5; ++j) {
            int k = i + j - 2;
            if (k >= 0 && k < 256) s += hist[k];
        }
        sm[i] = s / 5.0;
    }
    int best = 0;
    for (int i = 1; i < 256; ++i)
        if (sm[i] > sm[best]) best = i;   // np.argmax = 第一个最大
    return best;
}

/** np.bincount(region.ravel()) 的 minlength=256 版本 */
inline std::vector<double> bincount256(const cv::Mat& gray) {
    std::vector<double> hist(256, 0.0);
    int total = gray.rows * gray.cols;
    const uint8_t* p = gray.ptr<uint8_t>(0);
    for (int i = 0; i < total; ++i) hist[p[i]] += 1.0;
    return hist;
}

// ---------------------------------------------------------------- 棋盘约定

/** 把 numpy 版 detector.WHITE(-1) 折算成服务约定 2=白 */
inline cv::Mat boardToService(const cv::Mat& board) {
    cv::Mat out = board.clone();
    int total = out.rows * out.cols;
    int8_t* p = out.ptr<int8_t>(0);
    for (int i = 0; i < total; ++i)
        if (p[i] == WHITE) p[i] = 2;
    return out;
}

// ---------------------------------------------------------------- base64

inline std::string base64Encode(const std::vector<uint8_t>& in) {
    static const char* T =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((in.size() + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 2 < in.size(); i += 3) {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out.push_back(T[(v >> 18) & 63]); out.push_back(T[(v >> 12) & 63]);
        out.push_back(T[(v >> 6) & 63]);  out.push_back(T[v & 63]);
    }
    if (i < in.size()) {
        uint32_t v = in[i] << 16;
        bool two = (i + 1 < in.size());
        if (two) v |= in[i + 1] << 8;
        out.push_back(T[(v >> 18) & 63]); out.push_back(T[(v >> 12) & 63]);
        out.push_back(two ? T[(v >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

/** 宽容 base64 解码：跳过空白与非法字符，容忍缺失的 '=' */
inline bool base64Decode(const std::string& in, std::vector<uint8_t>& out) {
    static int8_t LUT[256];
    static bool init = false;
    if (!init) {
        std::memset(LUT, -1, sizeof(LUT));
        const char* T =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) LUT[(uint8_t)T[i]] = (int8_t)i;
        init = true;
    }
    out.clear();
    out.reserve(in.size() / 4 * 3 + 3);
    uint32_t acc = 0;
    int nbits = 0;
    for (char c : in) {
        int8_t d = LUT[(uint8_t)c];
        if (d < 0) continue;                  // '=' / 空白 / 换行一律跳过
        acc = (acc << 6) | (uint32_t)d;
        nbits += 6;
        if (nbits >= 8) {
            nbits -= 8;
            out.push_back((uint8_t)((acc >> nbits) & 0xFF));
        }
    }
    return true;
}

// ---------------------------------------------------------------- JSON

class Json {
public:
    enum Type { NUL, BOOL, NUM, STR, ARR, OBJ };

    Type type = NUL;
    bool b = false;
    double num = 0.0;
    bool isInt = false;
    long long inum = 0;
    std::string str;
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;

    Json() {}
    static Json makeNull() { return Json(); }
    static Json makeBool(bool v) { Json j; j.type = BOOL; j.b = v; return j; }
    static Json makeInt(long long v) {
        Json j; j.type = NUM; j.isInt = true; j.inum = v; j.num = (double)v; return j;
    }
    static Json makeNum(double v) { Json j; j.type = NUM; j.num = v; return j; }
    static Json makeStr(const std::string& v) { Json j; j.type = STR; j.str = v; return j; }
    static Json makeArr() { Json j; j.type = ARR; return j; }
    static Json makeObj() { Json j; j.type = OBJ; return j; }

    void set(const std::string& k, Json v) { obj.emplace_back(k, std::move(v)); }
    void push(Json v) { arr.push_back(std::move(v)); }

    const Json* find(const std::string& k) const {
        for (const auto& kv : obj) if (kv.first == k) return &kv.second;
        return nullptr;
    }
    Json* findMutable(const std::string& k) {
        for (auto& kv : obj) if (kv.first == k) return &kv.second;
        return nullptr;
    }
    double numOr(const std::string& k, double d) const {
        const Json* p = find(k);
        return (p && p->type == NUM) ? p->num : d;
    }
    bool boolOr(const std::string& k, bool d) const {
        const Json* p = find(k);
        if (!p) return d;
        if (p->type == BOOL) return p->b;
        if (p->type == NUM) return p->num != 0.0;
        return d;
    }
    std::string strOr(const std::string& k, const std::string& d) const {
        const Json* p = find(k);
        return (p && p->type == STR) ? p->str : d;
    }

    std::string dump() const;
};

// 解析（失败返回 false）。request body 一律走这里。
bool jsonParse(const std::string& text, Json& out);

// 最短往返浮点输出（等价 Python repr）
std::string fmtDouble(double v);

}  // namespace gb
