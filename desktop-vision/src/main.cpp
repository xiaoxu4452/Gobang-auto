// main.cpp —— GomokuVision 进程入口
// =====================================================================
// 一个自包含 EXE 取代原来的两个 Python 服务：
//     GomokuVision.exe --recognize   ≈ python recognize_server.py   (:8970)
//     GomokuVision.exe --scan        ≈ python screen_scan_server.py (:8971)
//     GomokuVision.exe               = 两个端口都服务
//
// 为什么按角色分进程（而不是永远一个进程两个端口）：
//   覆盖层关闭时会 POST :8971/quit 把扫描服务**整个进程**结束掉（Python 语义），
//   下次打开覆盖层再拉起一个新的、状态干净的实例。若两者共用一个进程，
//   quit 会把浏览器书签那侧依赖的 :8970 一起带走 —— 那是另一个组件的生命线。
//
// 单实例锁用命名互斥体（进程退出/崩溃由 OS 自动释放），并按角色分开命名，
// 与原来 Python 的两把文件锁一一对应。
#include "gbhttp.h"
#include "gbvision.h"

#include <windows.h>
#include <intrin.h>   // ★ --cpuid：__cpuidex（与 host.cpp 的指令集探测同源）

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>
#include <typeinfo>
#include <vector>

using namespace gb;

namespace {

constexpr int DEFAULT_RECOGNIZE_PORT = 8970;
constexpr int DEFAULT_SCAN_PORT = 8971;

HANDLE gMutex = nullptr;
std::atomic<bool> gStopping{false};

std::vector<std::pair<std::string, std::string>> corsHeaders(bool privateNetwork) {
    std::vector<std::pair<std::string, std::string>> h;
    h.emplace_back("Access-Control-Allow-Origin", "*");
    h.emplace_back("Access-Control-Allow-Headers", "Content-Type");
    h.emplace_back("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    // 覆盖层页面是 https://gb.local（WebView2 虚拟主机），访问 127.0.0.1 属跨私网请求，
    // Chrome 会先发预检；缺这个头会被浏览器整体拦掉（表现为面板一直"连接中"）。
    if (privateNetwork) h.emplace_back("Access-Control-Allow-Private-Network", "true");
    return h;
}

HttpResponse jsonResponse(const Json& j) {
    HttpResponse r;
    r.status = 200;
    r.contentType = "application/json";
    r.body = j.dump();
    return r;
}

HttpResponse noContent(bool privateNetwork) {
    HttpResponse r;
    r.status = 204;
    r.body.clear();
    r.extraHeaders = corsHeaders(privateNetwork);
    return r;
}

HttpResponse notFound(const std::string& err) {
    Json j = Json::makeObj();
    j.set("ok", Json::makeBool(false));
    j.set("err", Json::makeStr(err));
    HttpResponse r = jsonResponse(j);
    r.status = 404;
    return r;
}

// ---------------------------------------------------------------- :8970

int recognizePort() {
    const char* e = getenv("GB_RECOG_PORT");
    if (e && *e) return atoi(e);
    return DEFAULT_RECOGNIZE_PORT;
}

HttpResponse handleRecognize(const HttpRequest& req) {
    // ★ 2026-09-26（用户报 playok 书签版识别坏）：:8970 的应答也必须带
    //   Access-Control-Allow-Private-Network —— Chrome「私有网络访问」强制后，
    //   https 公网页面（playok/gomocalc…）向 127.0.0.1 发的 POST 一律先发 PNA 预检，
    //   缺这个头 = 浏览器直接拦掉 → 面板拿不到识别结果，回落页内 JS 识别（不准）。
    //   （:8971 覆盖层早就带 true —— 同一个坑当年在覆盖层侧修过、书签侧漏了。）
    if (req.method == "OPTIONS") return noContent(true);
    if (req.method == "GET" && req.path == "/health") {
        Json j = Json::makeObj();
        j.set("ok", Json::makeBool(true));
        return jsonResponse(j);
    }
    if (req.method == "POST" && req.path == "/recognize") {
        Json body;
        Json result;
        try {
            if (!jsonParse(req.body, body))
                throw std::runtime_error("bad json body");
            int size = (int)body.numOr("size", 15);
            std::string mode = body.strOr("mode", "image");
            if (mode == "wulin") {
                const Json* geo = body.find("geo");
                const Json* win = body.find("win");
                result = recognizeWulin(geo ? *geo : Json::makeObj(),
                                        win ? *win : Json::makeObj(), size);
            } else {
                result = recognize(body.strOr("image", ""), size, !body.boolOr("nosnap", false));
            }
        } catch (const std::exception& e) {
            result = Json::makeObj();
            result.set("ok", Json::makeBool(false));
            result.set("err", Json::makeStr(e.what()));
        }
        HttpResponse r = jsonResponse(result);
        r.extraHeaders = corsHeaders(true);   // ★ 2026-09-26：PNA 应答（书签版识别被 Chrome 拦的根治）
        return r;
    }
    return notFound("not found");
}

// ---------------------------------------------------------------- :8971

int scanPort() {
    const char* e = getenv("GB_SCAN_PORT");
    if (e && *e) return atoi(e);
    return DEFAULT_SCAN_PORT;
}

Json offsetJson(double ox, double oy) {
    Json a = Json::makeArr();
    a.push(Json::makeInt((long long)ox));
    a.push(Json::makeInt((long long)oy));
    return a;
}

Json stonesArr(const std::vector<std::pair<int, int>>& v) {
    Json a = Json::makeArr();
    for (auto& p : v) {
        Json s = Json::makeObj();
        s.set("x", Json::makeInt(p.first));
        s.set("y", Json::makeInt(p.second));
        a.push(s);
    }
    return a;
}

Json scanResultJson(const ScanResult& r) {
    Json j = Json::makeObj();
    j.set("ok", Json::makeBool(r.ok));
    j.set("found", Json::makeBool(r.found));
    j.set("offset", offsetJson(r.ox, r.oy));
    if (!r.found) {
        j.set("multi_board", Json::makeInt(r.multiBoard));
        j.set("diag", r.diag);
        return j;
    }
    j.set("board_rect", r.boardRect);
    j.set("geometry", r.geometry);
    j.set("black", stonesArr(r.black));
    j.set("white", stonesArr(r.white));
    j.set("suspect", Json::makeBool(r.suspect));
    j.set("multi_board", Json::makeInt(r.multiBoard));
    j.set("diag", r.diag);
    return j;
}

/** 覆盖层自己的窗口（面板/局面窗）—— 抹掉再识别，免得被当成第二个棋盘 */
std::vector<ExcludeRect> parseExclude(const Json& req) {
    std::vector<ExcludeRect> out;
    const Json* p = req.find("exclude");
    if (!p || p->type != Json::ARR) return out;
    for (const Json& it : p->arr) {
        if (it.type != Json::OBJ) continue;
        ExcludeRect e;
        e.x = (int)it.numOr("x", 0);
        e.y = (int)it.numOr("y", 0);
        e.w = (int)it.numOr("w", 0);
        e.h = (int)it.numOr("h", 0);
        out.push_back(e);
    }
    return out;
}

HttpResponse handleScan(const HttpRequest& req) {
    if (req.method == "OPTIONS") return noContent(true);
    if (req.method == "GET" && req.path == "/health") {
        Json j = Json::makeObj();
        j.set("ok", Json::makeBool(true));
        j.set("port", Json::makeInt(scanPort()));
        return jsonResponse(j);
    }
    if (req.method == "POST" && req.path == "/quit") {
        HttpResponse r = jsonResponse([]{ Json j = Json::makeObj();
                                          j.set("ok", Json::makeBool(true));
                                          return j; }());
        r.extraHeaders = corsHeaders(true);
        gStopping.store(true);
        std::thread([] {
            Sleep(200);
            if (gMutex) ReleaseMutex(gMutex);
            ExitProcess(0);
        }).detach();
        return r;
    }
    if (req.method != "POST" || req.path != "/scan") return notFound("not found");

    // 「没给 hint 就用上一帧的位置」——持续跟踪时几乎每次都命中，省掉全屏搜索
    static ScanHint lastHint;
    static bool lastHintValid = false;

    Json reqJson;
    ScanHint hint;
    bool hintGiven = false;
    int size = 15;
    bool probe = false;
    std::vector<int> region;
    std::vector<ExcludeRect> exclude;
    if (!req.body.empty()) {
        if (jsonParse(req.body, reqJson)) {
            const Json* h = reqJson.find("hint");
            if (h && h->type == Json::OBJ) {
                hint.has = true;
                hint.x = h->numOr("x", 0);
                hint.y = h->numOr("y", 0);
                hint.w = h->numOr("w", 0);
                hint.h = h->numOr("h", 0);
                hintGiven = true;
            }
            size = (int)reqJson.numOr("size", 15);
            probe = reqJson.boolOr("probe", false);
            exclude = parseExclude(reqJson);
            const Json* rg = reqJson.find("region");
            if (rg && rg->type == Json::ARR && rg->arr.size() >= 4) {
                for (int i = 0; i < 4; ++i) region.push_back((int)rg->arr[i].num);
            }
        }
    }
    if (!hintGiven && lastHintValid) hint = lastHint;

    ScanResult res;
    try {
        res = scanOnce(nullptr, size, hint, exclude, probe, region.empty() ? nullptr : &region);
    } catch (const std::exception& e) {
        Json j = Json::makeObj();
        j.set("ok", Json::makeBool(false));
        j.set("err", Json::makeStr(std::string(typeid(e).name()) + ": " + e.what()));
        HttpResponse r = jsonResponse(j);
        r.extraHeaders = corsHeaders(true);
        return r;
    } catch (...) {
        Json j = Json::makeObj();
        j.set("ok", Json::makeBool(false));
        j.set("err", Json::makeStr("unknown error"));
        HttpResponse r = jsonResponse(j);
        r.extraHeaders = corsHeaders(true);
        return r;
    }

    if (res.found && !res.boardRect.obj.empty()) {
        const Json* x = res.boardRect.find("x");
        const Json* y = res.boardRect.find("y");
        const Json* w = res.boardRect.find("w");
        const Json* hh = res.boardRect.find("h");
        if (x && y && w && hh) {
            lastHint.has = true;
            lastHint.x = x->num;
            lastHint.y = y->num;
            lastHint.w = w->num;
            lastHint.h = hh->num;
            lastHintValid = true;
        }
    }

    HttpResponse r = jsonResponse(scanResultJson(res));
    r.extraHeaders = corsHeaders(true);
    return r;
}

// ---------------------------------------------------------------- 单实例

std::string roleName(const std::string& role) {
    return "Global\\GomokuVision_" + role + "_v1";
}

}  // namespace

int main(int argc, char** argv) {
    setDpiAware();

    std::string role = "both";
    std::string scanImage;
    std::string recognizeImage;
    bool probeImage = false;
    bool nosnap = false;      // ★ 2026-09-22（用户要求）：关掉自动吸附棋盘的重试
    bool cpuidDump = false;   // ★ 2026-09-25：打印 CPU 指令集能力（engine-server 选原生 Rapfi 变体用）
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--scan") role = "scan";
        else if (a == "--recognize") role = "recognize";
        else if (a == "--both") role = "both";
        else if (a == "--probe") probeImage = true;
        else if (a == "--nosnap") nosnap = true;
        else if (a == "--cpuid") cpuidDump = true;
        else if (a == "--scan-image" && i + 1 < argc) scanImage = argv[++i];
        else if (a == "--recognize-image" && i + 1 < argc) recognizeImage = argv[++i];
        else if (a == "--help" || a == "-h") {
            printf("GomokuVision —— 五子棋棋盘识别服务（OpenCV C++ 版）\n");
            printf("  --recognize            仅服务 :8970（POST /recognize, GET /health）\n");
            printf("  --scan                 仅服务 :8971（POST /scan, /quit, GET /health）\n");
            printf("  （不带参数 = 两个端口都服务）\n");
            printf("  --recognize-image 文件  离线跑一次 /recognize 并打印 JSON（开发期对拍用）\n");
            printf("  --scan-image 文件       离线跑一次 /scan 并打印 JSON（可配 --probe）\n");
            printf("  --nosnap                跳过自动吸附棋盘的重试（请求体 nosnap:true 同效）\n");
            printf("  --cpuid                 打印 CPU 指令集能力 JSON 后退出（avx2 / avx512vnni）\n");
            return 0;
        }
    }

    // ---- --cpuid：与 desktop-calculator/src/host.cpp 的 CpuSupportsAvx512Vnni() 同判据。
    //   engine-server（Node）拿不到 cpuid，起原生 Rapfi 前借本 exe 问一句「什么指令集」，
    //   决定用 RapfiEngine-avx512.exe 还是 RapfiEngine-avx2.exe（选错会 SIGILL）。----
    if (cpuidDump) {
        int r[4] = {0, 0, 0, 0};
        __cpuidex(r, 0, 0);
        int maxLeaf = r[0];
        bool avx2 = false, vnni = false;
        if (maxLeaf >= 1) {
            __cpuidex(r, 1, 0);
            bool osxsave = (r[2] & (1 << 27)) != 0;
            bool avx0 = (r[2] & (1 << 28)) != 0;
            avx2 = osxsave && avx0;
            if (osxsave && maxLeaf >= 7) {
                __cpuidex(r, 7, 0);
                bool avx512f  = (r[1] >> 16) & 1;
                bool avx512dq = (r[1] >> 17) & 1;
                bool avx512bw = (r[1] >> 30) & 1;
                bool avx512vl = (r[1] >> 31) & 1;
                bool vnnibit  = (r[2] >> 11) & 1;
                vnni = avx512f && avx512dq && avx512bw && avx512vl && vnnibit;
            }
        }
        Json j = Json::makeObj();
        j.set("ok", Json::makeBool(true));
        j.set("avx2", Json::makeBool(avx2));
        j.set("avx512vnni", Json::makeBool(vnni));
        printf("%s\n", j.dump().c_str());
        return 0;
    }

    // ---- 开发期离线入口：不起服务，直接对一张图片跑一遍并输出 JSON ----
    // 用途：与 Python 参考实现在**同一张图**上逐子对拍（见 tools/vision-parity.py）。
    if (!scanImage.empty() || !recognizeImage.empty()) {
        if (!scanImage.empty()) {
            cv::Mat raw = cv::imread(scanImage, cv::IMREAD_COLOR);
            if (raw.empty()) {
                fprintf(stderr, "[vision] cannot read image: %s\n", scanImage.c_str());
                return 2;
            }
            cv::Mat rgb;
            cv::cvtColor(raw, rgb, cv::COLOR_BGR2RGB);
            ScanResult res = scanOnce(&rgb, 15, ScanHint{}, {}, probeImage, nullptr);
            printf("%s\n", scanResultJson(res).dump().c_str());
        } else {
            // ★ 直接喂**文件的原始字节**（base64），与浏览器 POST /recognize 的报文完全同源。
            //   早先这里是 imread → imencode 再喂：理论上无损，但实测**不是**（E/空盘水印/
            //   deep_dark 在这条路上会多出一颗误报白子，而 HTTP 路径没有）—— 于是「对拍全过、
            //   线上却错」。对拍工具本身必须走真实链路的同一口径，这条不能省。
            std::ifstream in(recognizeImage, std::ios::binary);
            if (!in) {
                fprintf(stderr, "[vision] cannot read image: %s\n", recognizeImage.c_str());
                return 2;
            }
            std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)),
                                       std::istreambuf_iterator<char>());
            printf("%s\n", recognize(base64Encode(bytes), 15).dump().c_str());
        }
        return 0;
    }

    // ---- 单实例锁（按角色分开；进程退出/崩溃时 OS 自动释放）----
    std::string mtxName = roleName(role);
    gMutex = CreateMutexW(nullptr, TRUE, std::wstring(mtxName.begin(), mtxName.end()).c_str());
    if (gMutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        printf("[vision] another %s instance is already running - exit.\n", role.c_str());
        return 0;
    }

    std::vector<int> ports;
    if (role == "recognize" || role == "both") ports.push_back(recognizePort());
    if (role == "scan" || role == "both") ports.push_back(scanPort());

    bool anyOk = false;
    for (int port : ports) {
        std::string err;
        bool isScan = (port == scanPort());
        HttpHandler handler = isScan ? HttpHandler(handleScan) : HttpHandler(handleRecognize);
        if (startHttpServer(port, handler, err)) {
            printf("[vision] %s listening on 127.0.0.1:%d\n",
                   isScan ? "scan service" : "recognize service", port);
            anyOk = true;
        } else {
            printf("[vision] %s failed to start on :%d (%s)\n",
                   isScan ? "scan" : "recognize", port, err.c_str());
        }
    }
    fflush(stdout);
    if (!anyOk) {
        if (gMutex) ReleaseMutex(gMutex);
        return 1;
    }

    while (!gStopping.load()) Sleep(500);
    if (gMutex) ReleaseMutex(gMutex);
    return 0;
}
