/* Vision-zhizi - gbzhizi.cpp.
   Faithful C++ port of the readboard.exe stone classifier (Zhizi board
   reader), cross-checked against out/core_detect.py and
   readboard-source/readboard/MainForm.cs:
     getWhiteBlackColorPercent  MainForm.cs:2203
     getTrueWhite               MainForm.cs:2170
     getRedBlueColorPercent     MainForm.cs:2130
     classify_point (single)    MainForm.cs:1943-2041
   Default thresholds = the Yihu/Yicheng/Sina one-click sync values. */

#include "gbzhizi.h"

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace gb {

namespace {

struct ZhiziParams {
    int black_percent = 37;   // black ratio gate  (blackZB)
    int white_percent = 30;   // white ratio gate  (whiteZB)
    int black_offset = 96;    // black brightness  (blackPC)
    int white_offset = 112;   // white brightness  (whitePC; Yicheng 80)
    int gray_offset = 50;     // neutral-gray tolerance
};

// MainForm.cs:2203 getWhiteBlackColorPercent.
// Count neutral-gray pixels matching black/white over the window, return %.
int whiteBlackPercent(const cv::Mat& rgb, int sx, int sy, int w, int h,
                      bool isBlack, int offset, int grayOffset,
                      int tw, int th) {
    if (sx + w > tw) sx = tw - w;
    if (sy + h > th) sy = th - h;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx >= tw || sy >= th) return 0;
    int xEnd = std::min(sx + w, tw), yEnd = std::min(sy + h, th);
    int count = 0;
    for (int y = sy; y < yEnd; ++y) {
        const uint8_t* p = rgb.ptr<uint8_t>(y);
        for (int x = sx; x < xEnd; ++x) {
            int r = p[x * 3], g = p[x * 3 + 1], b = p[x * 3 + 2];
            // 1) neutral-gray gate: colored pixels (wood grain, borders,
            //    UI chrome) are dropped before any black/white counting.
            if (std::abs(r - g) >= grayOffset || std::abs(g - b) >= grayOffset ||
                std::abs(b - r) >= grayOffset)
                continue;
            if (isBlack) {
                if (r <= offset && g <= offset && b <= offset) ++count;
            } else {
                int thr = 255 - offset;
                if (r >= thr && g >= thr && b >= thr) ++count;
            }
        }
    }
    int area = (yEnd - sy) * (xEnd - sx);
    return area > 0 ? 100 * count / area : 0;
}

// MainForm.cs:2170 getTrueWhite. Band at 1/4 height x 2/6 width; any channel
// < 225 proves a real white stone lives here (rejects a plain light board).
bool trueWhite(const cv::Mat& rgb, int sx, int sy, int w, int h,
               int tw, int th) {
    const int limit = 225;
    if (sx + w > tw) sx = tw - w;
    if (sy + h > th) sy = th - h;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    int bandY = sy + std::max(0, h / 4);
    if (bandY >= th) bandY = th - 1;
    int bandN = std::max(1, (int)std::round(w * 2.0 / 6.0));
    bandN = std::min(bandN, tw - sx);
    const uint8_t* p = rgb.ptr<uint8_t>(bandY);
    for (int i = 0; i < bandN; ++i) {
        int r = p[(sx + i) * 3], g = p[(sx + i) * 3 + 1], b = p[(sx + i) * 3 + 2];
        if (r < limit || g < limit || b < limit) return true;
    }
    return false;
}

// MainForm.cs:2130 getRedBlueColorPercent - red/blue last-move mark.
int redBluePercent(const cv::Mat& rgb, int sx, int sy, int w, int h,
                   bool isBlue, int tw, int th) {
    if (sx + w > tw) sx = tw - w;
    if (sy + h > th) sy = th - h;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx >= tw || sy >= th) return 0;
    int xEnd = std::min(sx + w, tw), yEnd = std::min(sy + h, th);
    int count = 0;
    for (int y = sy; y < yEnd; ++y) {
        const uint8_t* p = rgb.ptr<uint8_t>(y);
        for (int x = sx; x < xEnd; ++x) {
            int r = p[x * 3], g = p[x * 3 + 1], b = p[x * 3 + 2];
            if (isBlue) { if (r <= 50 && g <= 50 && b >= 150) ++count; }
            else if (r >= 150 && g <= 50 && b <= 50) ++count;
        }
    }
    int area = (yEnd - sy) * (xEnd - sx);
    return area > 0 ? 100 * count / area : 0;
}

// MainForm.cs:1943-2041 single-point classify, with the white double-check.
int classifyPoint(const cv::Mat& rgb, int sx, int sy, int w, int h,
                  const ZhiziParams& p, int tw, int th) {
    int pctBlack = whiteBlackPercent(rgb, sx, sy, w, h, true,
                                     p.black_offset, p.gray_offset, tw, th);
    if (pctBlack >= p.black_percent) return 1;  // BLACK
    int pctWhite = whiteBlackPercent(rgb, sx, sy, w, h, false,
                                     p.white_offset, p.gray_offset, tw, th);
    if (pctWhite >= p.white_percent) {
        int pct30 = whiteBlackPercent(rgb, sx, sy, w, h, false, 30,
                                      p.gray_offset, tw, th);
        int pct65 = whiteBlackPercent(rgb, sx, sy, w, h, false, 65,
                                      p.gray_offset, tw, th);
        if (trueWhite(rgb, sx, sy, w, h, tw, th) || (pct65 - pct30) >= 10)
            return 2;  // WHITE
    }
    return 0;  // EMPTY
}

}  // namespace

void readStonesZhizi(const cv::Mat& rgb, const GeoLike& geo,
                     cv::Mat& board, cv::Mat& conf, Json& diag) {
    const int n = geo.size;
    board = cv::Mat(n, n, CV_8S, cv::Scalar(EMPTY));
    conf = cv::Mat(n, n, CV_32F, cv::Scalar(0.f));
    const std::vector<double>& xs = geo.x_lines;
    const std::vector<double>& ys = geo.y_lines;
    if ((int)xs.size() < n || (int)ys.size() < n) {
        diag.set("reader", Json::makeStr("zhizi:bad_geo"));
        return;
    }
    const int tw = rgb.cols, th = rgb.rows;
    double sp = geo.spacing > 1.0 ? geo.spacing : 20.0;
    // Sample window = the full cell, matching the readboard reader (its
    // per-point window is one grid cell). A smaller window would squeeze the
    // pct65-pct30 gap below the white double-check threshold.
    int win = (int)std::round(sp);
    if (win < 8) win = 8;
    ZhiziParams p;

    for (int r = 0; r < n; ++r) {
        int cy = (int)std::round(ys[r]);
        for (int c = 0; c < n; ++c) {
            int cx = (int)std::round(xs[c]);
            int sx = cx - win / 2, sy = cy - win / 2;
            int v = classifyPoint(rgb, sx, sy, win, win, p, tw, th);
            if (v != EMPTY) board.at<int8_t>(r, c) = (int8_t)v;
        }
    }

    // Last-move red/blue mark (result codes 3/4 collapse to 1/2 for the
    // shared pipeline; the mark is reported in diag for debugging).
    int markR = -1, markC = -1;
    for (int r = 0; r < n && markR < 0; ++r) {
        int cy = (int)std::round(ys[r]);
        for (int c = 0; c < n; ++c) {
            if (board.at<int8_t>(r, c) == EMPTY) continue;
            int cx = (int)std::round(xs[c]);
            int sx = cx - win / 2, sy = cy - win / 2;
            if (redBluePercent(rgb, sx, sy, win, win, false, tw, th) >= 1) {
                markR = r; markC = c; break;
            }
            if (redBluePercent(rgb, sx, sy, win, win, true, tw, th) >= 1) {
                markR = r; markC = c; break;
            }
        }
    }
    if (markR >= 0) {
        diag.set("last_mark", Json::makeStr(
            std::to_string(markC) + "," + std::to_string(markR)));
    }
    diag.set("reader", Json::makeStr("zhizi"));
}

}  // namespace gb
