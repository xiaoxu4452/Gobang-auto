// gbvision.h —— 识别管线对外接口（C++ 移植版）
// =====================================================================
// 与 Python 参考实现的对应关系（一句一句对着抄，注释里的「实测」数字全部保留）：
//   detector.py      → gbdetector.cpp    网格定位（投影晶格 / 周期锁定 / 拉伸盘兜底）
//   adaptive.py      → gbadaptive.cpp    自适应读子 + Hough 兜底
//   screen_board.py  → gbscreen.cpp      整屏找盘 + 抓屏 + 跟踪/区域/排除
//   recognize_server → gbrecognize.cpp   /recognize 的编排与仲裁
#pragma once

#include "gb.h"

namespace gb {

// ---------------------------------------------------------------- 通用

/** screen_board.Geo / models.BoardGeometry 的最小公共面 */
struct GeoLike {
    int size = 15;
    double spacing = 0.0;
    std::vector<double> x_lines;
    std::vector<double> y_lines;
};

struct BgEstimate {
    cv::Mat field;      // CV_32F 局部背景亮度场
    int bg0 = 200;      // 全局众数
    double sigma = 0.0; // 背景噪声 σ
};

// ---------------------------------------------------------------- adaptive

double noiseSigma(const cv::Mat& diff16);

BgEstimate estimateBackground(const cv::Mat& gray, double spacing);

bool plateauLikeMed(double outMed, double ref);
bool quadsPlateauVals(const std::vector<double>& quadMeds, double ref);
bool plateauGateVeto(bool outPlateau, double ref, double edge);

/** 自适应读子：board 为 CV_8S（0 空 / 1 黑 / -1 白），conf 为 CV_32F */
void readStonesAdaptive(const cv::Mat& rgb, const GeoLike& geo,
                        cv::Mat& board, cv::Mat& conf, Json& diag);

int stripBorderArtifacts(cv::Mat& board, cv::Mat* conf, double minRatio = 0.80);
Json invariants(const cv::Mat& board);

cv::Mat autoCanny(const cv::Mat& gray, double sigma = 0.33);

/** Hough 等距格兜底：返回 false 表示未找到 */
bool locateGridHough(const cv::Mat& gray, int lineCount,
                     std::vector<double>& xs, std::vector<double>& ys, double& residual);

// ---------------------------------------------------------------- detector

struct DetectionError {
    std::string msg;
    explicit DetectionError(const std::string& m) : msg(m) {}
};

Geometry locateBoard(const cv::Mat& rgb, int lineCount);
Geometry geometryFromRect(const cv::Mat& rgb, int x1, int y1, int x2, int y2,
                          int lineCount, const std::string& source, bool lock);
double gridLiveness(const cv::Mat& rgb, const Geometry& geo);
void readStonesLegacy(const cv::Mat& rgb, const Geometry& geo, int bgLevel,
                      cv::Mat& board, cv::Mat& conf);

// ---------------------------------------------------------------- screen_board

struct ScanResult {
    bool ok = true;
    bool found = false;
    double ox = 0, oy = 0;             // 虚拟屏原点偏移
    Json geometry;                     // {x_lines,y_lines,spacing,size}
    Json boardRect;                    // {x,y,w,h}
    std::vector<std::pair<int, int>> black, white;   // (x, y)
    bool suspect = false;
    int multiBoard = 0;
    Json diag;
    cv::Mat crop;                      // 棋盘裁剪图（调试/预览用）
};

/** 抓全屏（可多显示器）：rgb 为 CV_8UC3(RGB)，off 为虚拟屏原点 */
bool captureScreen(cv::Mat& rgb, int& ox, int& oy);
void setDpiAware();

struct ScanHint { bool has = false; double x = 0, y = 0, w = 0, h = 0; };
struct ExcludeRect { int x = 0, y = 0, w = 0, h = 0; };

ScanResult scanOnce(const cv::Mat* rgbIn, int size, const ScanHint& hint,
                    const std::vector<ExcludeRect>& exclude, bool probe,
                    const std::vector<int>* region);

// ---------------------------------------------------------------- recognize

/** ★ 自动吸附棋盘候选（2026-09-22，gbscreen.findBoardRects 的跨编译单元导出）：
 *  在整幅图里找「横竖等距线族真交叉」的棋盘矩形 —— 与桌面版五子棋助手整屏扫描同源。
 *  recognize 在主结果违反棋理时用它裁出棋盘区域重新定位读子（大图内嵌小棋盘主修法）。 */
struct BoardRectCand {
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    double step = 0;
    double score = 0;
};
std::vector<BoardRectCand> snapBoardRects(const cv::Mat& gray, int lineCount, int topn);

/** /recognize 编排：与 recognize_server.recognize 等价。
 *  ★ 2026-09-22（用户要求）：allowSnap=false 时跳过「自动吸附棋盘」重试
 *  （snapBoardRects 裁小图重读）—— 吸附偶尔会锁错区域导致识别出错，
 *  界面给了开关，关掉后直接信整图直读的核心结果。 */
Json recognize(const std::string& imageB64, int size, bool allowSnap = true);

/** 五林（Cocos WebGL）适配：服务端截屏 + 前端校准几何 */
Json recognizeWulin(const Json& geo, const Json& win, int size);

}  // namespace gb
