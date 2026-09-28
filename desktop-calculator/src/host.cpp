/* ============================================================================
 * Desktop GomokuTrainer.exe —— 「五子棋练习器」桌面端（第三个 EXE）
 *
 * 与另外两个 EXE 的分工：
 *   · Web GomokuEngine.exe       —— 书签版启动器（浏览器里用）
 *   · Desktop GomokuOverlay.exe  —— 屏幕识别 + 覆盖层指导（只指导、不落子）
 *   · Desktop GomokuTrainer.exe（本文件）—— 独立的人机对战 / 复盘 / 历史台
 *
 * 形态（用户 2026-09-18 定稿）：
 *   · **普通可缩放窗口**：系统标题栏自带最小化 / 最大化（=全屏）/ 关闭，
 *     不再是无边框分层窗 —— 计算器是要长时间盯着用的工具，不是浮动条。
 *   · 客户区全部交给 WebView2 渲染 calc/calc.html（左棋盘、右仪表盘）。
 *   · **没有任何黑色控制台**：/SUBSYSTEM:WINDOWS（2026-09-19 页面内 AI 后
 *     连依赖进程都没有了 —— 不再有引擎子进程，自然也不弹窗）。
 *
 * 依赖（2026-09-19 页面内 AI）：AI = rapfi wasm 跑在页面 Worker（ui/engine-ai.js），
 *      宿主以 COOP/COEP 头供页 + /ai/* 供模型资源，不再依赖 Web GomokuEngine.exe/:8964。
 *
 * 外部接入（两个识别器存档历史）：
 *   · HTTP  :8972  POST /history   —— 书签页直接 POST JSON 进来（带 CORS）；
 *   · 落盘  %TEMP%\gb-calc-inbox.json —— 桌面覆盖层「复盘」写文件、再拉起本 exe。
 *   两条路最终都转成一条 WebMessage 推给页面，页面统一入库（上限 150 局）。
 * ==========================================================================*/

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX              // ★ 识图：gdiplus.h 的模板头与 windows.h 的 min/max 宏冲突
#endif
#include <winsock2.h>     // ★ 必须排在 windows.h 之前（否则会拉进旧的 winsock.h 冲突）
#include <ws2tcpip.h>
#include <windows.h>
#include <objidl.h>       // ★ gdiplus.h 要 IStream（WIN32_LEAN_AND_MEAN 会把它收掉）
#include <gdiplus.h>      // 识图「屏幕截图」：BitBlt 抓屏后用 GDI+ 编 PNG（识图窗，2026-09-21）
#include <gdiplusflat.h>  // ★ flat API（GdipGetImageEncoders*）要显式引入，gdiplus.h 不自带
#include <commdlg.h>      // 「保存局面」的系统「另存为」对话框（GetSaveFileNameW）
#include <shellapi.h>
#include <shlwapi.h>
#include <objbase.h>
#include <dwmapi.h>       // 深色主题下把**系统标题栏**也变深（DWMWA_USE_IMMERSIVE_DARK_MODE）
#include <tlhelp32.h>     // BoostWebViewPriority：枚举 WebView2 子进程提权
#include "WebView2.h"
#include "ui_crypto.h"          // calc/ UI 的运行时解密（与 tools/obfuscator.js 互逆）

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <intrin.h>   // CPUID：原生 Rapfi 车道按 CPU 能力挑 AVX512 / AVX2 变体
#include <mutex>      // 原生引擎车道的输出行队列锁
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")

// ---------------------------------------------------------------- 基础工具

static HINSTANCE g_hInst = nullptr;
static HWND      g_hwnd = nullptr;
static HWND      g_view = nullptr;      // WebView2 的宿主位置就用 g_hwnd 客户区
static ICoreWebView2* g_webview = nullptr;
static ICoreWebView2Controller* g_controller = nullptr;
static ICoreWebView2Environment* g_env = nullptr;
static std::atomic<bool> g_running{true};
/** ★ 2026-09-28 终版：UI 供给端口号（0 = 尚未绑定）。HttpUiServer 用 **bind(port 0)**
 *  让系统分配空闲端口 —— 固定 :8965 时代，「多开 / 上个实例未退净 → bind 失败 →
 *  页面 ERR_CONNECTION_REFUSED」（本日 15:36 实测三连，用户截图为证）。端口动态化后
 *  该故障模式不存在了。页面/Worker 全部同源，拿到什么端口就用什么端口。 */
static std::atomic<int> g_uiPort{0};
static std::string g_pending;           // 页面还没 ready 时先攒着的消息

// ---- 复盘窗口：**第二个顶层窗口**（用户要求「打开复盘，弹出一个新的窗口」）----
// 和主窗口共享同一个 WebView2 环境（g_env）与同一份 calc/ 目录映射，但：
//   · 页面带 ?rv=1（RV_MODE）→ 渲染成「纯棋盘 + 一行复盘功能键」；
//   · 不拉引擎、不连看门狗、不参与历史抽屉 —— 那个窗口「不参与任何功能的连接」。
// 全进程只保留**一个**复盘窗口：再点一次复盘/换一局 → 复用同一个窗口并把新局投进去。
static HWND      g_rvHwnd = nullptr;
static ICoreWebView2* g_rvWebview = nullptr;
static ICoreWebView2Controller* g_rvController = nullptr;
static std::string g_rvPending;         // 复盘页 ready 之前先攒着的「要复盘的那一局」
static bool        g_rvCreating = false;
// 定义在后面的「复盘窗口」段；MsgHandler（主窗口）要调用它们，所以先声明。
static void OpenReviewWindow(const std::string& recordJson);
static void ScheduleRvPrewarm(UINT ms);      // 主窗口页面就绪后预约一次「预热复盘窗」
static void PrewarmReviewWindow();           // 立刻预热（用户要求：不等任何固定时间）
static void PostToRvPage(const std::string& json);
static void PostToPage(const std::string& json);
// ★ 2026-09-21 识图窗口（GbCalcVis）：克隆复盘窗机制，另加 GDI 抓屏 + GomokuVision.exe
//   子进程离线识别（--recognize-image / --scan-image，喂**原始图片字节**）。
//   定义在后面的「识图窗口」段；MsgHandler（主窗口）要先调用它们，所以先声明。
static void OpenVisWindow();
static void PostToVisPage(const std::string& json);
static void PostToVisPageSoon(const std::string& json);   // 后台线程（截屏/识别）也要用
static void StartVisShotFlow();                           // 截图 = 开中空选框（UI 线程）
static void RunVisionForVis(std::string req);             // 写临时文件 → 拉起 GomokuVision.exe
// 测试钩子（GB_TEST_*=1）：DOMContentLoaded 或页面报到 —— 谁先到谁发一次（见下方实现处的注释）
static void FireTestHooks();
// 主窗口上的一个定时器 id（复盘窗口段里也要用，所以放这儿统一定义）
static const UINT_PTR kRvTimerTestOpen = 3;  // 测试钩子：延迟触发「去开复盘窗」

// ---- 识图窗口的全局状态（MsgHandler / WndProc 都要先见到）----
static HWND      g_visHwnd = nullptr;
static ICoreWebView2* g_visWebview = nullptr;
static ICoreWebView2Controller* g_visController = nullptr;
static std::string g_visPending;         // 识图页 ready 之前先攒着的报文
static bool        g_visCreating = false;
static bool        g_visShown = false;
static bool        g_visPageReady = false;
static std::vector<std::string> g_outboxVis;   // 识图窗的回程消息队列（后台线程回投走这里）

static std::wstring ExeDir() {
  wchar_t buf[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring s(buf);
  size_t p = s.find_last_of(L"\\/");
  return (p == std::wstring::npos) ? L"." : s.substr(0, p);
}
static std::wstring Join(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  if (a.back() == L'\\' || a.back() == L'/') return a + b;
  return a + L"\\" + b;
}
static bool FileExists(const std::wstring& p) {
  return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES;
}

// ---------------- 三件套版引擎依赖（GB_SUITE_ENGINE；独立版构建不含这段） ----------------
// ★ 2026-09-19（用户要求）：三件套（Desktop version / Meter engine-server）**保留原本的相互
//   连接逻辑** —— 练习器的 AI 走 HTTP :8964，与遮罩盘共用同一个引擎后端；这与独立版
//   （页面内 Worker 自带 rapfi，无 :8964）**彻底分开**。独立版构建不带 GB_SUITE_ENGINE，
//   这段代码整体不参与编译。模式移植自 desktop-overlay 的 EnsureEngine：
//   · :8964 在跑 → 复用（不重复拉起）；不在 → 拉起「Web GomokuEngine.exe --as-backend」
//     （无界面后端：不参与互斥、不开浏览器页，只提供 :8964 API）；
//   · 拉起带 25s 冷却（CAS 抢占），看门狗线程 15s 巡检 → 引擎中途挂掉能自动补拉。
#ifdef GB_SUITE_ENGINE
#include <winhttp.h>
static void LogMsg(const std::string& s);        // 前置声明（定义在下面，与主日志同一通道）

static bool PortAlive(int port) {
  HINTERNET s = WinHttpOpen(L"gbcalc", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) return false;
  WinHttpSetTimeouts(s, 250, 250, 250, 250);
  HINTERNET c = WinHttpConnect(s, L"127.0.0.1", (INTERNET_PORT)port, 0);
  bool ok = false;
  if (c) {
    HINTERNET r = WinHttpOpenRequest(c, L"GET", L"/health", nullptr, WINHTTP_NO_REFERER,
                                     WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (r) {
      if (WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
          WinHttpReceiveResponse(r, nullptr)) {
        DWORD code = 0, len = sizeof(code);
        WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &code, &len, WINHTTP_NO_HEADER_INDEX);
        ok = (code == 200);
      }
      WinHttpCloseHandle(r);
    }
    WinHttpCloseHandle(c);
  }
  WinHttpCloseHandle(s);
  return ok;
}

static void SpawnDetached(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd) {
  std::wstring cmd = L"\"" + exe + L"\"";
  if (!args.empty()) cmd += L" " + args;
  STARTUPINFOW si; ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
  PROCESS_INFORMATION pi; ZeroMemory(&pi, sizeof(pi));
  std::vector<wchar_t> buf(cmd.begin(), cmd.end()); buf.push_back(0);
  // ★ 环境块必须传 nullptr（子进程继承本进程环境）—— 自建环境块在本机必 ERROR_INVALID_PARAMETER(87)
  if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE,
                     CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr,
                     cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    LogMsg("[deps] spawned engine backend (as --as-backend)");
  } else {
    char b[96]; snprintf(b, sizeof(b), "[deps] spawn failed err=%lu", (unsigned long)GetLastError());
    LogMsg(b);
  }
}

static std::atomic<unsigned long long> g_engineSpawnedAt(0);
static void EnsureEngine() {
  if (PortAlive(8964)) {
    static std::atomic<bool> told(false);
    if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");
    return;
  }
  std::wstring root = ExeDir();                 // 三件套布局：引擎就躺在练习器同一个目录
  std::wstring exe = Join(root, L"Web GomokuEngine.exe");
  if (!FileExists(exe)) {
    exe = Join(root, L"GomokuEngine.exe");
    if (!FileExists(exe)) { LogMsg("[deps] engine exe not found (Web GomokuEngine.exe / GomokuEngine.exe)"); return; }
  }
  // CAS 抢「启动名额」（25s 冷却）：防看门狗重复拉起第二个引擎实例
  unsigned long long now = GetTickCount64(), cur = g_engineSpawnedAt.load();
  for (;;) {
    if (now - cur < 25000) return;
    if (g_engineSpawnedAt.compare_exchange_weak(cur, now)) break;
  }
  LogMsg("[deps] starting engine backend --as-backend (headless, no browser)");
  SpawnDetached(exe, L"--as-backend", root);
}
static void EngineWatchdog() {
  EnsureEngine();
  while (g_running.load()) {
    Sleep(15000);
    if (!g_running.load()) return;
    EnsureEngine();
  }
}
#endif  // GB_SUITE_ENGINE

static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

// ★ 2026-09-19（用户要求）：「打开时间要控制在 1.2 秒以内」—— 光靠猜没用，
//   每个启动里程碑打一条 [perf]，直接从日志里读出时间到底花在哪一步。
static void LogMsg(const std::string& s);        // 函数体在下面（LogBoot 要用它）
static DWORD g_bootT0 = 0;
static void LogBoot(const char* what) {
  char b[160];
  snprintf(b, sizeof(b), "[perf] %-24s %5lu ms", what,
           (unsigned long)(GetTickCount() - g_bootT0));
  LogMsg(b);
}
/** 两个 GDI 颜色按 t(0..1) 插值 —— 遮罩上那排点用它做「亮 → 暗」的渐变。 */
static COLORREF MixColor(COLORREF a, COLORREF b, float t) {
  int ar = (int)(a & 0xFF), ag = (int)((a >> 8) & 0xFF), ab = (int)((a >> 16) & 0xFF);
  int br = (int)(b & 0xFF), bg = (int)((b >> 8) & 0xFF), bb = (int)((b >> 16) & 0xFF);
  auto cl = [](int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); };
  return RGB(cl((int)(ar + (br - ar) * t)), cl((int)(ag + (bg - ag) * t)), cl((int)(ab + (bb - ab) * t)));
}


static void LogMsg(const std::string& s) {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  std::wstring path = Join(std::wstring(tmp), L"GomokuTrainer.log");
  FILE* f = _wfopen(path.c_str(), L"ab");
  if (!f) return;
  SYSTEMTIME st; GetLocalTime(&st);
  char head[64];
  snprintf(head, sizeof(head), "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  fwrite(head, 1, strlen(head), f);
  fwrite(s.data(), 1, s.size(), f);
  fwrite("\n", 1, 1, f);
  fclose(f);
}

static void PostToPage(const std::string& json) {
  if (!g_webview) { g_pending = json; return; }
  std::wstring w = Utf8ToWide(json);
  g_webview->PostWebMessageAsJson(w.c_str());
}

static const UINT_PTR kMainTimerOutbox = 6;       // 延迟发送「回程消息」（见 PostToPageSoon）
static const UINT_PTR kMainTimerHook = 7;         // 延迟发测试钩子（见 FireTestHooks）
// ★ 识图窗的后台线程（截屏 / GomokuVision.exe 子进程）完成时不在 UI 线程上，
//   SetTimer 跨线程不可靠 → 用 PostMessage(kMsgFlushOutbox) 触发主线程下一轮 flush。
static const UINT kMsgFlushOutbox = WM_APP + 2;
// 「截图」入口也从 WebView2 事件回调里挪出来：回调栈上跑嵌套消息循环容易把页面搅乱
static const UINT kMsgVisShot = WM_APP + 7;
// ★★ 2026-09-25 新引擎后端：原生引擎的输出**推**给页面，不再让页面去 :8965 上轮询。
//   读线程拿到新行 → 投这个消息（跨线程只能用 PostMessage，SetTimer 跨线程不可靠）
//   → 主线程一次 drain 三个车道、打包成一条 engineOut 推给页面。引擎安静时零开销。
static const UINT kMsgEngineFlush = WM_APP + 10;
static std::atomic<bool> g_engineFlushPending{false};
static std::atomic<bool> g_pushEngineOut{false};   // 页面走 WebView 通道后才开始推
static void RequestEngineFlush() {
  if (!g_pushEngineOut.load()) return;
  if (g_engineFlushPending.exchange(true)) return;   // 已排队 → 合并成一次，别刷爆消息队列
  if (g_hwnd && IsWindow(g_hwnd)) PostMessageW(g_hwnd, kMsgEngineFlush, 0, 0);
  else g_engineFlushPending = false;
}
// ★ 回程消息队列：在 WebMessageReceived 回调里同步 PostWebMessageAsJson 会被 WebView2 丢掉，
//   所以「页面问 → 宿主答」这类消息先塞进来，由 kMainTimerOutbox 下一个 tick 再发。
static std::vector<std::string> g_outboxPage;
static std::vector<std::string> g_outboxRv;

// ★ 2026-09-19（实测）：宿主在「收到页面消息」的回调里**同步** PostWebMessageAsJson，
//   页面那头收不到（WebView2 会丢）。凡属「页面问 → 宿主答」的消息一律走这两个延迟版本。
static void PostToPageSoon(const std::string& json) {
  g_outboxPage.push_back(json);
  if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kMainTimerOutbox, 1, nullptr);
}
static void PostToRvPageSoon(const std::string& json) {
  g_outboxRv.push_back(json);
  if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kMainTimerOutbox, 1, nullptr);
}

/** 把一段文本安全地嵌进 JSON 字符串（外部进来的存档不能信任，必须转义）。 */
static std::string JsonQuote(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"':  o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n";  break;
      case '\r': o += "\\r";  break;
      case '\t': o += "\\t";  break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  o += "\"";
  return o;
}

/** 取 JSON 字符串数组 "key":["a","b"] —— 引擎命令批用它传（避免把 \n 塞进单个字符串里
 *  再去做转义解码）。解码 \n / \t / \" / \\ 四种就够（命令里不会有别的）。 */
static std::vector<std::string> JsonStrArray(const std::string& s, const char* key) {
  std::vector<std::string> out;
  size_t p = s.find(key);
  if (p == std::string::npos) return out;
  p = s.find('[', p);
  if (p == std::string::npos) return out;
  for (++p; p < s.size() && s[p] != ']';) {
    if (s[p] != '"') { ++p; continue; }
    std::string cur;
    for (++p; p < s.size() && s[p] != '"'; ++p) {
      if (s[p] == '\\' && p + 1 < s.size()) {
        char c = s[++p];
        if (c == 'n') cur += '\n';
        else if (c == 't') cur += '\t';
        else if (c == 'r') cur += '\r';
        else if (c == 'u') p += 4;              // 命令里不会出现，跳过
        else cur += c;
      } else cur += s[p];
    }
    if (p < s.size()) ++p;
    out.push_back(cur);
  }
  return out;
}

/** 从一段 JSON 里取某个 "key":"..." 的字符串值（只用于我们自己的短消息，够用即可）。 */
static std::string JsonStrAfter(const std::string& s, const char* key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return "";
  p += strlen(key);
  if (p >= s.size() || s[p] != '"') return "";
  std::string o;
  for (++p; p < s.size() && s[p] != '"'; ++p) {
    if (s[p] == '\\' && p + 1 < s.size()) ++p;
    o += s[p];
  }
  return o;
}

/** 把 \uXXXX 编成 UTF-8（历史 txt 里全是中文，WebView2 有可能把它转义着发过来）。 */
static void AppendUtf8ForCodePoint(std::string& o, unsigned cp) {
  if (cp < 0x80) {
    o += (char)cp;
  } else if (cp < 0x800) {
    o += (char)(0xC0 | (cp >> 6));
    o += (char)(0x80 | (cp & 0x3F));
  } else {
    o += (char)(0xE0 | (cp >> 12));
    o += (char)(0x80 | ((cp >> 6) & 0x3F));
    o += (char)(0x80 | (cp & 0x3F));
  }
}

/** **严格**的 JSON 字符串解码（\n \t \r \" \\ \/ \uXXXX 一律还原成真字符）。
 *  ★ 为什么不能复用 JsonStrAfter：那个是「见到反斜杠就跳过去、把下一个字符原样收下」的简易版 ——
 *    对 base64 这种没有转义的负载够用，但历史 txt 里**真的有换行与制表符**，
 *    简易版会把 "\n" 变成字母 n、"\t" 变成字母 t：导出的文件会变成一整行「名字t代码」，
 *    导入更是把每一局粘成一行。所以 txt 的负载必须走这个严格版。 */
static std::string JsonStrAfterDecoded(const std::string& s, const char* key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return "";
  p += strlen(key);
  if (p >= s.size() || s[p] != '"') return "";
  std::string o;
  for (++p; p < s.size() && s[p] != '"'; ++p) {
    if (s[p] != '\\') { o += s[p]; continue; }
    if (++p >= s.size()) break;
    switch (s[p]) {
      case 'n':  o += '\n'; break;
      case 't':  o += '\t'; break;
      case 'r':  o += '\r'; break;
      case 'b':  o += '\b'; break;
      case 'f':  o += '\f'; break;
      case '/':  o += '/';  break;
      case '"':  o += '"';  break;
      case '\\': o += '\\'; break;
      case 'u': {
        unsigned cp = 0;
        for (int k = 0; k < 4 && p + 1 < s.size(); k++) {
          char c = s[++p];
          cp <<= 4;
          if (c >= '0' && c <= '9') cp |= (unsigned)(c - '0');
          else if (c >= 'a' && c <= 'f') cp |= (unsigned)(c - 'a' + 10);
          else if (c >= 'A' && c <= 'F') cp |= (unsigned)(c - 'A' + 10);
        }
        AppendUtf8ForCodePoint(o, cp);
        break;
      }
      default: o += s[p]; break;
    }
  }
  return o;
}

/** 从一段 JSON 里取某个 "key":123 的数字值（页面报的局数之类，够用即可）。 */
static int JsonIntAfter(const std::string& s, const char* key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return -1;
  p += strlen(key);
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) ++p;
  return atoi(s.c_str() + p);
}

// ---- 启动遮罩（「加载中…」）：状态 + 入口声明 ----
// ★ 2026-09-19（用户要求）：「不管是复盘界面，还是五子棋练习器，启动时要瞬间显示窗口，
//   如果还是黑屏，在黑屏上显示：加载中…」。
//   做法：窗口建出来就**立刻显示**，但 WebView2 控制器先不放出来（只是创建时
//   put_IsVisible(FALSE)）—— 这段时间由本进程用 GDI 在客户区画「底色 + 居中 加载中…」
//   （PaintSplash 走 WM_PAINT），页面报到（ready）之后才放出来。于是「窗口出现 → 内容出现」
//   中间一帧黑/白都没有。底色与文案取自上一轮页面报上来的值（%TEMP%\GomokuTrainer.ui），
//   所以深色主题的用户连遮罩都是深色的；3s 兜底定时器保证控制器一定会被放出来。
//   函数体在「复盘窗口」段之前（见下面那一节），MsgHandler / CtlHandler / wWinMain
//   都要提前用到，所以**状态与原型先在这里声明**。
static bool g_uiDark = true;
static COLORREF g_uiBg = RGB(0x26, 0x27, 0x2a);   // 深色 --bg（本机就是深色主题，故为默认）
static COLORREF g_uiFg = RGB(0x9a, 0xa0, 0xa6);   // 深色 --sub
static std::wstring g_uiText = L"加载中…";
static bool g_mainPageShown = false;              // 主窗口页面报过到（遮罩可以撤了）
static const UINT_PTR kMainTimerReload = 5;       // 页面迟迟不报到 → 重新导航（自愈；非等待）
static const UINT_PTR kMainTimerEval = 8;         // 诊断：GB_TEST_DIAG=1 时回读页面状态（排查 ready 断链）
static int g_mainReloads = 0;                    // 已经自愈过几次（最多 2 次）
static std::wstring UiFile();
/** 拼出 JSON 里的 "key": 前缀 —— 源码里就不用写转义引号了。 */
static std::string JKey(const char* name) {
  return std::string(1, '"') + name + std::string(1, '"') + std::string(1, ':');
}
static void LoadUiPrefs();
static void SaveUiPrefs(const std::string& s);
static void ApplyDarkTitleBar(HWND h, bool dark);
static void SetWebviewBg(ICoreWebView2Controller* ctl, COLORREF c);
static void RevealMainPage();
static void RevealRvPage();
static void PaintSplash(HWND h, bool pageShown, const wchar_t* brand);

/** 从一段 JSON 里取出某个 key 的**内嵌对象**（原样返回，含两侧花括号）。
 *  只用于我们自己发的报文（页面侧构造、record 在最后一位），但仍然按括号配平来切 ——
 *  免得记录里恰好出现 '}' 的字符串（保险起见连字符串状态也判）。 */
static std::string JsonSubObject(const std::string& s, const char* key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return "";
  p = s.find('{', p + strlen(key));
  if (p == std::string::npos) return "";
  int depth = 0;
  bool inStr = false, esc = false;
  for (size_t i = p; i < s.size(); ++i) {
    char c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '"') inStr = false;
      continue;
    }
    if (c == '"') inStr = true;
    else if (c == '{') depth++;
    else if (c == '}') { if (--depth == 0) return s.substr(p, i - p + 1); }
  }
  return "";
}

// ---------------------------------------------------------------- 保存局面（系统「另存为」）
// ★ 用户要求（2026-09-19）：「点击保存局面，会有一个系统里面的资源管理器弹出来，提示用户要
//   保存到哪里，不要默认保存」。页面侧办不到这件事（浏览器下载只能落进默认下载目录），
//   所以页面把棋盘 PNG 的 dataURL 送上来，由宿主弹 Win32 的「另存为」对话框并写盘。
//   GetSaveFileNameW 在 Vista+ 上走的就是现代资源管理器风格的对话框（OFN_EXPLORER）。
static std::vector<unsigned char> Base64Decode(const std::string& in) {
  static int8_t tbl[256];
  static bool built = false;
  if (!built) {
    for (int i = 0; i < 256; i++) tbl[i] = -1;
    const char* A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) tbl[(unsigned char)A[i]] = (int8_t)i;
    built = true;
  }
  std::vector<unsigned char> out;
  int val = 0, bits = 0;
  for (size_t i = 0; i < in.size(); i++) {
    unsigned char c = (unsigned char)in[i];
    if (c == '=') break;
    int8_t d = tbl[c];
    if (d < 0) continue;                       // 换行/空白一律跳过
    val = (val << 6) | d;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back((unsigned char)((val >> bits) & 0xFF)); }
  }
  return out;
}

/** 弹系统「另存为」对话框，返回用户选的完整路径；取消返回空串。
 *  hwndOwner 用当前有焦点的那个窗口（复盘窗 / 主窗），对话框才会正确居中在它上面。
 *  filter / defExt / title 由调用方给 —— 存 PNG 与存历史 txt 共用这一支。 */
static std::wstring PickSavePathAs(const std::wstring& suggested, HWND owner,
                                   const wchar_t* filter, const wchar_t* defExt,
                                   const wchar_t* title) {
  wchar_t buf[MAX_PATH] = {0};
  wcsncpy(buf, suggested.c_str(), MAX_PATH - 1);
  OPENFILENAMEW ofn = {};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = owner ? owner : g_hwnd;
  ofn.lpstrFilter = filter;
  ofn.lpstrFile = buf;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrDefExt = defExt;
  ofn.lpstrTitle = title;
  // OFN_NOCHANGEDIR：绝对不能让对话框把进程的当前目录改掉
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_NOCHANGEDIR;
  if (!GetSaveFileNameW(&ofn)) return L"";
  return std::wstring(buf);
}
static std::wstring PickSavePath(const std::wstring& suggested, HWND owner) {
  return PickSavePathAs(suggested, owner,
                        L"PNG 图片 (*.png)\0*.png\0所有文件 (*.*)\0*.*\0", L"png", L"保存局面图片");
}
/** 弹系统「打开」对话框选一个 txt（导入历史），返回路径；取消返回空串。 */
static std::wstring PickOpenTxtPath(HWND owner) {
  wchar_t buf[MAX_PATH] = {0};
  OPENFILENAMEW ofn = {};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = owner ? owner : g_hwnd;
  ofn.lpstrFilter = L"文本文件 (*.txt)\0*.txt\0所有文件 (*.*)\0*.*\0";
  ofn.lpstrFile = buf;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrDefExt = L"txt";
  ofn.lpstrTitle = L"导入历史（txt 局面代码）";
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_NOCHANGEDIR;
  if (!GetOpenFileNameW(&ofn)) return L"";
  return std::wstring(buf);
}
/** 测试钩子用的布尔开关（GB_TEST_xxx=1）。 */
static bool TestFlag(const char* name) {
  char v[8] = {0};
  return GetEnvironmentVariableA(name, v, sizeof(v)) && v[0] == '1';
}

/** 页面送来 {type:'savePng', name, data:'data:image/png;base64,…'} → 落盘。 */
static void SavePngFromPage(const std::string& s, HWND owner) {
  std::string name = JsonStrAfter(s, "\"name\":");
  std::string data = JsonStrAfter(s, "\"data\":");
  if (name.empty()) name = "gomoku.png";
  size_t p = data.find("base64,");
  std::vector<unsigned char> png = (p == std::string::npos)
      ? std::vector<unsigned char>() : Base64Decode(data.substr(p + 7));
  if (png.empty()) { LogMsg("[save] png payload is empty - nothing written"); return; }

  std::wstring path;
  char tv[1024] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_SAVE_PNG", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);                     // 测试钩子：不弹对话框，直接写这个路径
  } else {
    path = PickSavePath(Utf8ToWide(name), owner);
  }
  if (path.empty()) { LogMsg("[save] cancelled by user"); return; }

  FILE* f = _wfopen(path.c_str(), L"wb");
  if (!f) {
    LogMsg("[save] cannot open for write: " + WideToUtf8(path));
    return;
  }
  fwrite(png.data(), 1, png.size(), f);
  fclose(f);
  LogMsg("[save] png written: " + WideToUtf8(path) + " (" + std::to_string(png.size()) + " bytes)");
}

// ---------------------------------------------------------------- 历史导出 / 导入（txt）
// ★ 2026-09-19（用户要求）：「历史记录中的历史可以导出导入通过 txt 中的代码」。
//   页面侧同样**做不到**「让用户挑路径 / 挑文件」（WebView2 里既没路径也没文件系统），
//   所以和「保存局面」一个套路：页面把整段文本递上来，宿主弹 Win32 对话框并写盘；
//   导入则反过来 —— 宿主弹「打开」读回文件，再把 {type:'histTxt', text} 推给页面解析。
//   txt 的格式（一行一局：<名字>\t<局面代码>，# 注释）由**页面**定义，宿主只当搬运工。
struct TxtSaveResult { bool ok; int n; std::wstring path; };

/** 页面送来 {type:'saveTxt', name, data, n} → 弹「另存为」写 .txt。 */
static TxtSaveResult SaveTxtFromPage(const std::string& s, HWND owner) {
  TxtSaveResult r = { false, 0, L"" };
  // ★ 这里必须用严格解码：txt 全文里全是真换行与制表符（见 JsonStrAfterDecoded 的说明）
  std::string name = JsonStrAfterDecoded(s, "\"name\":");
  std::string data = JsonStrAfterDecoded(s, "\"data\":");
  int n = JsonIntAfter(s, "\"n\":");
  r.n = (n < 0) ? 0 : n;
  if (name.empty()) name = "gomoku-history.txt";

  std::wstring path;
  char tv[1024] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_SAVE_TXT", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);                    // 测试钩子：不弹对话框，直接写这个路径
  } else {
    path = PickSavePathAs(Utf8ToWide(name), owner,
                          L"文本文件 (*.txt)\0*.txt\0所有文件 (*.*)\0*.*\0",
                          L"txt", L"导出历史（txt）");
  }
  if (path.empty()) { LogMsg("[hist] export cancelled by user"); return r; }

  FILE* f = _wfopen(path.c_str(), L"wb");
  if (!f) { LogMsg("[hist] cannot open for write: " + WideToUtf8(path)); return r; }
  // UTF-8 BOM：中文记事本靠它认出编码，不然打开是一片乱码（页面解析时会把 BOM 去掉）
  const unsigned char bom[3] = { 0xEF, 0xBB, 0xBF };
  fwrite(bom, 1, sizeof(bom), f);
  fwrite(data.data(), 1, data.size(), f);
  fclose(f);
  r.ok = true;
  r.path = path;
  LogMsg("[hist] txt written: " + WideToUtf8(path) + " (" + std::to_string(data.size()) +
         " bytes, " + std::to_string(r.n) + " games)");
  return r;
}

/** 读一个 txt（导入历史）→ 拼出 {type:'histTxt', text} 报文；用户取消 / 读不到 → 返回空串。 */
static std::string ReadTxtMessage(HWND owner) {
  std::wstring path;
  char tv[1024] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_OPEN_TXT", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);                    // 测试钩子：不弹对话框，直接读这个文件
  } else {
    path = PickOpenTxtPath(owner);
  }
  if (path.empty()) { LogMsg("[hist] import cancelled by user"); return ""; }

  FILE* f = _wfopen(path.c_str(), L"rb");
  if (!f) { LogMsg("[hist] cannot read: " + WideToUtf8(path)); return ""; }
  std::string txt;
  char buf[4096];
  size_t got;
  while ((got = fread(buf, 1, sizeof(buf), f)) > 0) txt.append(buf, got);
  fclose(f);
  if (txt.size() > 4u * 1024 * 1024) txt.resize(4u * 1024 * 1024);   // 别让一个巨型文件撑爆报文
  LogMsg("[hist] txt read: " + WideToUtf8(path) + " (" + std::to_string(txt.size()) + " bytes)");
  return "{\"type\":\"histTxt\",\"text\":" + JsonQuote(txt) + "}";
}

// ---------------------------------------------------------------- 识图：抓屏编码 + 子进程识别（2026-09-21）
// 页面侧做不到「读屏幕 / 读文件系统」，所以识图窗的两条路都压在宿主身上：
//   · 屏幕截图：中空选框圈定区域 → GDI BitBlt 抓该矩形，GDI+ 编 PNG，
//     base64 后回投识图页（dataURL 直接进 <img> 预览）；
//   · 识别：把图片**原始字节**写临时文件，喂随包自带的 GomokuVision.exe
//     （OpenCV 静态链接、零 DLL）的离线入口 --recognize-image / --scan-image，
//     stdout 的 JSON 原样回投页面 —— 与 test-vision-service 的对拍完全同一条链路。
static void GdiplusEnsure() {
  static bool done = false;
  if (!done) {
    Gdiplus::GdiplusStartupInput si;
    ULONG_PTR tok = 0;
    GdiplusStartup(&tok, &si, nullptr);
    done = true;                     // 一次性初始化；失败也就退回「截屏失败」提示
  }
}

static bool FindPngEncoderClsid(CLSID* out) {
  UINT num = 0, size = 0;
  // ★ 本 SDK 把 flat API 包进 namespace Gdiplus::DllExports（嵌套！）—— 按全限定名调用
  if (Gdiplus::DllExports::GdipGetImageEncodersSize(&num, &size) != Gdiplus::Ok || !num || !size) return false;
  std::vector<char> buf(size);
  Gdiplus::ImageCodecInfo* ci = (Gdiplus::ImageCodecInfo*)buf.data();
  if (Gdiplus::DllExports::GdipGetImageEncoders(num, size, ci) != Gdiplus::Ok) return false;
  for (UINT i = 0; i < num; i++) {
    if (wcscmp(ci[i].MimeType, L"image/png") == 0) { *out = ci[i].Clsid; return true; }
  }
  return false;
}

static std::string Base64Encode(const std::vector<unsigned char>& in) {
  static const char* A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((in.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < in.size()) {
    unsigned v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
    out += A[(v >> 18) & 63]; out += A[(v >> 12) & 63]; out += A[(v >> 6) & 63]; out += A[v & 63];
    i += 3;
  }
  if (i + 1 == in.size()) {
    unsigned v = in[i] << 16;
    out += A[(v >> 18) & 63]; out += A[(v >> 12) & 63]; out += "==";
  } else if (i + 2 == in.size()) {
    unsigned v = (in[i] << 16) | (in[i + 1] << 8);
    out += A[(v >> 18) & 63]; out += A[(v >> 12) & 63]; out += A[(v >> 6) & 63]; out += '=';
  }
  return out;
}

/** 把一张 HBITMAP 编成 PNG 字节（GDI+ 经临时文件回读）。失败返回空。 */
static std::vector<unsigned char> EncodePngFromHbitmap(HBITMAP hb) {
  std::vector<unsigned char> png;
  GdiplusEnsure();
  CLSID clsid;
  if (FindPngEncoderClsid(&clsid)) {
    // C++ 包装类（flat API 的 GpBitmap/GpImage 类型在这个 SDK 头里不认，别绕回去）
    Gdiplus::Bitmap bmp(hb, nullptr);
    if (bmp.GetLastStatus() == Gdiplus::Ok) {
      wchar_t tmp[MAX_PATH] = { 0 };
      GetTempPathW(MAX_PATH, tmp);
      std::wstring path = Join(std::wstring(tmp), L"gbvis-shot.png");
      DeleteFileW(path.c_str());
      if (bmp.Save(path.c_str(), &clsid, nullptr) == Gdiplus::Ok) {
        FILE* f = _wfopen(path.c_str(), L"rb");
        if (f) {
          char buf[65536];
          size_t got;
          while ((got = fread(buf, 1, sizeof(buf), f)) > 0)
            png.insert(png.end(), buf, buf + got);
          fclose(f);
        }
        DeleteFileW(path.c_str());
      }
    }
  }
  return png;
}

/** 抓屏幕上一个矩形（**屏幕坐标**，GetDC(nullptr) 的 DC 原点=主屏左上、覆盖整个虚拟屏，
 *  所以副屏的负坐标也直接用屏幕坐标）→ PNG 字节。
 *  ★ 2026-09-21（用户反馈「不可以截图、满屏斜纹故障」）：上一轮试的 DXGI Desktop
 *  Duplication 实测会拿到花屏帧，整条退掉；回到与五子棋助手同款的
 *  **GDI BitBlt 一次成图**（助手链路全程 GDI，从未出过稳定性问题）。
 *  稳定性改由新「中空选框」负责：不再有整屏冻结帧，也就没有可被污染的中间画面。 */
static std::vector<unsigned char> CaptureRectPng(RECT rc) {
  int w = rc.right - rc.left, h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0) return std::vector<unsigned char>();
  HDC sdc = GetDC(nullptr);
  HDC mdc = CreateCompatibleDC(sdc);
  HBITMAP hb = CreateCompatibleBitmap(sdc, w, h);
  HGDIOBJ old = SelectObject(mdc, hb);
  BitBlt(mdc, 0, 0, w, h, sdc, rc.left, rc.top, SRCCOPY);
  SelectObject(mdc, old);
  DeleteDC(mdc);
  ReleaseDC(nullptr, sdc);
  std::vector<unsigned char> png = EncodePngFromHbitmap(hb);
  DeleteObject(hb);
  return png;
}

// ---- 截图流程状态（中空选框；全在 UI 线程）----
static HWND g_visSelHwnd = nullptr;      // 中空选框窗口
static bool g_uiLangEn = false;          // 弹窗/选框文字跟随页面语言（SaveUiPrefs 里更新）
static std::wstring VshT(const wchar_t* zh, const wchar_t* en) {
  return std::wstring(g_uiLangEn ? en : zh);
}

// ★ 选框尺寸随系统 DPI 缩放（2026-09-21 用户：自适应屏幕分辨率）——
//   高分屏（150%/200%）上所有几何量按 DPI 等比放大，键、字、边框、把手都不缩成一粒。
static int VsDpi() {
  UINT d = GetDpiForSystem();
  return d >= 96 ? (int)d : 96;
}
static int VsS(int v) { return (int)((double)v * VsDpi() / 96.0 + 0.5); }

// ============================================================ 窗口尺寸随分辨率/缩放走
// ★★ 2026-09-28（用户要求）：「窗口的最小宽度应该是对应比例，根据不同电脑的分辨率而规定的
//    布局和尺寸，既能适应全高清又能适应 4K 超高清屏，并且保证棋盘下面那排按键都显示得下、
//    正好不堆叠」。
//
//   关键事实：本进程是 **Per-Monitor-V2 DPI 感知**（见 wWinMain 的 SetProcessDpiAwarenessContext），
//   而 WebView2 里的网页**按显示器 DPI 缩放**渲染 —— 1 CSS px = dpi/96 物理像素。
//   所以「底栏正好不堆叠」这个**内容侧**的临界值是用 **CSS px** 量出来的（无头 Edge 实测
//   680×600，见 tools/measure-bottombar-minwidth.html），换到窗口的 ptMinTrackSize（**物理像素**）
//   就必须乘 dpi/96：
//     · 1080p @100%  → 680 物理像素；
//     · 4K   @175%  → 1190 物理像素（＝同一个 680 CSS px，布局一模一样）。
//   写死 680 物理像素的话，高分屏上只有 680/1.75 ≈ 389 CSS px 的内容宽度 —— 底栏（需 424）
//   一拖窄就换行/出横向滚动条，正是用户截图里的「挤堆」。
//
//   旧代码还有**第二处**同类问题：默认窗口尺寸写死 1180×780 物理像素，在 4K@175% 上首启
//   只有 674×446 CSS px（比底栏临界还窄）—— 第一次打开就是挤的。现在一起按 DPI 换算。
static const int kMainMinCssW = 680;    // 主窗最小宽（CSS px）：底栏「正好不堆叠」的实测临界 + 余量
static const int kMainMinCssH = 600;    // 主窗最小高（CSS px）
static const int kMainDefCssW = 1280;   // 主窗默认宽（CSS px，首次启动 / 没有存档时）
static const int kMainDefCssH = 820;    // 主窗默认高（CSS px）
static const int kVisMinCssW  = 900;    // 识图窗最小尺寸（CSS px，九轮定稿：底部一行 5 键 + 识别框加高）
static const int kVisMinCssH  = 660;

/** 当前窗口所在显示器的 DPI（物理像素 / CSS 像素 × 96）。hwnd 为空 = 系统 DPI（建窗前用）。 */
static int GbDpiFor(HWND h) {
  UINT d = h ? GetDpiForWindow(h) : 0;
  if (!d) d = GetDpiForSystem();
  return d >= 96 ? (int)d : 96;
}
/** CSS px → 当前显示器的物理像素。 */
static int GbPx(HWND h, int css) { return MulDiv(css, GbDpiFor(h), 96); }
/** 把尺寸夹到工作区内：极小屏（<720p / 高缩放）上不能让「最小值比屏还大」把窗口卡死。 */
static void GbClampToWorkArea(HWND h, int& w, int& ht) {
  RECT wa = { 0, 0, 0, 0 };
  if (h) {
    MONITORINFO mi = {};
    mi.cbSize = sizeof(mi);
    HMONITOR mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    if (mon && GetMonitorInfoW(mon, &mi)) wa = mi.rcWork;
  }
  if (wa.right <= wa.left || wa.bottom <= wa.top) SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
  int aw = wa.right - wa.left, ah = wa.bottom - wa.top;
  if (aw > 0 && w > aw) w = aw;
  if (ah > 0 && ht > ah) ht = ah;
}

static const wchar_t* BrandFontFace();   // 商用安全字体挑选器（定义在后面：思源黑体 SIL OFL 优先）

// 弹窗/选框的配色 —— 与训练器页面同款（深浅跟随主窗设置 + 天蓝强调色）
static COLORREF VisUiBg()     { return g_uiDark ? RGB(38, 39, 42)    : RGB(246, 246, 244); }
static COLORREF VisUiBtn()    { return g_uiDark ? RGB(58, 59, 63)    : RGB(255, 255, 255); }
static COLORREF VisUiBtnHov() { return g_uiDark ? RGB(72, 73, 78)    : RGB(226, 243, 253); }
static COLORREF VisUiFg()     { return g_uiDark ? RGB(230, 231, 234) : RGB(45, 47, 50); }
static COLORREF VisUiBorder() { return g_uiDark ? RGB(70, 71, 76)    : RGB(210, 210, 206); }
static COLORREF VisSky()      { return RGB(79, 195, 247); }   // 天蓝（标题栏/边框/把手/强调）

/** 抓一个矩形并回投识图页（dataURL）。抓完负责恢复窗口。 */
static void VisShotDeliver(RECT rc) {
  std::vector<unsigned char> png = CaptureRectPng(rc);
  if (png.empty()) {
    LogMsg("[vis] screenshot failed (no pixels captured)");
    PostToVisPageSoon("{\"type\":\"visShotFail\"}");
    return;
  }
  LogMsg("[vis] screenshot captured (" + std::to_string(png.size()) + " bytes)");
  PostToVisPageSoon("{\"type\":\"visShotData\",\"data\":\"data:image/png;base64," +
                    Base64Encode(png) + "\"}");
}

// ---- 自由截取「中空选框」窗口（★ 2026-09-21 用户定稿：复用桌面端五子棋助手「手动调节」
//      的选框办法；助手的淡紫在这边按用户要求换成**天蓝**）----
// 形态：矩形窗口**内部 alpha=0**，直接透出底下的屏幕内容（UpdateLayeredWindow 逐像素合成，
// 与覆盖层同一条已跑通的路径）；顶部一条天蓝标题栏 +「截图」「关闭」两键；
// 拖标题栏挪位置、拉四边/四角改大小；点「截图」把框住的区域抓成 PNG 回投识图页，
// 「关闭」或 ESC 收框取消。
// 稳定性的关键（上一轮「满屏斜纹 + 截不了图」的教训）：
//   1. 不再有整屏 BitBlt 冻结帧 —— 屏幕始终是活的，不存在可被污染的中间画面；
//   2. 整窗 WDA_EXCLUDEFROMCAPTURE —— 确认时对屏幕抓一次图，选框自己不会进图；
//   3. 训练器三窗在弹框前就已最小化，恢复动作发生在抓图**之后**。
#define VSEL_TITLE_H (VsS(34))          // 标题栏高度（2026-09-21 收官：用户要求压到原来的 0.6，56→34）
#define VSEL_GRIP    (VsS(18))          // 四边/四角把手的命中宽度（用户：命中区大一点光标才好变）
#define VSEL_BTN_W   (VsS(96))          // 「截图」键宽
#define VSEL_CLOSE_W (VsS(78))          // 「关闭」键宽
#define VSEL_AUTO_W  (VsS(92))          // 「自动」键宽（自动贴棋盘开关）
#define VSEL_BTN_GAP (VsS(10))          // 键间距
#define VSEL_EDGE    (VsS(10))          // 按键与右边缘的间距

enum { VSEL_NONE = 0, VSEL_MOVE, VSEL_L, VSEL_R, VSEL_T, VSEL_B,
       VSEL_TL, VSEL_TR, VSEL_BL, VSEL_BR,
       VSEL_BTN_SHOT = 100, VSEL_BTN_CLOSE = 101, VSEL_BTN_AUTO = 102 };

// 「自动贴棋盘」开关（2026-09-21 晚用户定稿：默认开）—— 后台轮询找盘、命中即贴
static bool g_vselAuto = true;
static RECT g_vselBtnAuto = { 0, 0, 0, 0 };
static std::atomic<bool> g_vselAutoBusy(false);
#define VSEL_WM_SNAP (WM_APP + 9)        // 找盘线程 → 选框窗：贴到 board_rect

static HBITMAP g_vselBmp = nullptr;      // 选框窗口缓存位图（尺寸变化时重建）
static unsigned char* g_vselBits = nullptr;
static int g_vselBmpW = 0, g_vselBmpH = 0;
static RECT g_vselBtnShot = { 0, 0, 0, 0 }, g_vselBtnClose = { 0, 0, 0, 0 };
static int g_vselBtnSpan = 0;           // 三键实测总跨度（英文键更宽 → 窄框最小宽度跟着它走）
static int g_vselDrag = VSEL_NONE;       // 当前拖拽模式
static double g_vselStep = 0;            // 最近一轮 scan 的格距（贴框外扩口径用，0=未知）
static int g_vselHoverBtn = VSEL_NONE;   // 悬停键（重绘出高亮）
static int g_vselPressBtn = VSEL_NONE;   // 按下键
static POINT g_vselDragPt = { 0, 0 };    // 拖拽起点（屏幕物理像素）
static RECT g_vselDragRect = { 0, 0, 0, 0 };  // 拖拽开始时的窗口矩形

#ifndef GET_X_LPARAM
#define GET_X_LPARAM(lp) ((int)(short)LOWORD(lp))
#endif
#ifndef GET_Y_LPARAM
#define GET_Y_LPARAM(lp) ((int)(short)HIWORD(lp))
#endif

static void VselClose() {
  if (g_visSelHwnd && IsWindow(g_visSelHwnd)) DestroyWindow(g_visSelHwnd);
  g_visSelHwnd = nullptr;
  if (g_vselBmp) { DeleteObject(g_vselBmp); g_vselBmp = nullptr; }
  g_vselBits = nullptr; g_vselBmpW = 0; g_vselBmpH = 0;
  g_vselDrag = VSEL_NONE; g_vselHoverBtn = VSEL_NONE; g_vselPressBtn = VSEL_NONE;
}

/** 命中测试：客户区坐标 → 拖拽模式 / 按键（与助手 SelHit 同构）。 */
static int VselHit(HWND h, int mx, int my) {
  RECT rc; GetClientRect(h, &rc);
  int W = rc.right, H = rc.bottom;
  if (my >= 0 && my < VSEL_TITLE_H) {
    if (mx >= g_vselBtnAuto.left && mx < g_vselBtnAuto.right &&
        my >= g_vselBtnAuto.top && my < g_vselBtnAuto.bottom) return VSEL_BTN_AUTO;
    if (mx >= g_vselBtnShot.left && mx < g_vselBtnShot.right &&
        my >= g_vselBtnShot.top && my < g_vselBtnShot.bottom) return VSEL_BTN_SHOT;
    if (mx >= g_vselBtnClose.left && mx < g_vselBtnClose.right &&
        my >= g_vselBtnClose.top && my < g_vselBtnClose.bottom) return VSEL_BTN_CLOSE;
    return VSEL_MOVE;                                 // 标题栏其余部分 = 拖动整窗
  }
  bool L = (mx < VSEL_GRIP), R = (mx >= W - VSEL_GRIP);
  bool T = (my < VSEL_TITLE_H + VSEL_GRIP), B = (my >= H - VSEL_GRIP);
  if (L && T) return VSEL_TL;
  if (R && T) return VSEL_TR;
  if (L && B) return VSEL_BL;
  if (R && B) return VSEL_BR;
  if (L) return VSEL_L;
  if (R) return VSEL_R;
  if (T) return VSEL_T;
  if (B) return VSEL_B;
  return VSEL_NONE;                                   // 中空区：不响应（透出屏幕）
}

static void VselCursor(int hit) {
  LPCWSTR c = IDC_ARROW;
  switch (hit) {
    case VSEL_MOVE: c = IDC_SIZEALL; break;
    case VSEL_L: case VSEL_R: c = IDC_SIZEWE; break;
    case VSEL_T: case VSEL_B: c = IDC_SIZENS; break;
    case VSEL_TL: case VSEL_BR: c = IDC_SIZENWSE; break;
    case VSEL_TR: case VSEL_BL: c = IDC_SIZENESW; break;
    default: break;
  }
  SetCursor(LoadCursor(nullptr, c));
}

static void VselRoundPath(Gdiplus::GraphicsPath& p, float x, float y, float w, float h, float r) {
  if (r > w / 2.0f) r = w / 2.0f;
  if (r > h / 2.0f) r = h / 2.0f;
  p.AddArc(x, y, r * 2, r * 2, 180, 90);
  p.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
  p.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
  p.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
  p.CloseFigure();
}

static void VselPaint(HWND h) {
  RECT rc;
  GetClientRect(h, &rc);
  int W = rc.right - rc.left, H = rc.bottom - rc.top;
  if (W <= 0 || H <= 0) return;
  if (!g_vselBmp || g_vselBmpW != W || g_vselBmpH != H) {
    if (g_vselBmp) DeleteObject(g_vselBmp);
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = W;
    bi.bmiHeader.biHeight = -H;               // 自上而下，与屏幕 y 轴同向
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    HDC screen = GetDC(nullptr);
    g_vselBmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, (void**)&g_vselBits, nullptr, 0);
    ReleaseDC(nullptr, screen);
    g_vselBmpW = W; g_vselBmpH = H;
  }
  if (!g_vselBmp || !g_vselBits) return;

  Gdiplus::Bitmap gb(W, H, W * 4, PixelFormat32bppPARGB, g_vselBits);
  Gdiplus::Graphics g(&gb);
  g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
  // ★ 中空：整窗先擦成全透明，只画标题栏和一圈边框 —— 中间什么都盖不住。
  g.Clear(Gdiplus::Color(0, 0, 0, 0));

  const Gdiplus::Color sky(255, GetRValue(VisSky()), GetGValue(VisSky()), GetBValue(VisSky()));
  {   // 标题栏：一条天蓝（助手是淡紫，这边按用户要求换天蓝）
    Gdiplus::SolidBrush tb(Gdiplus::Color(236, sky.GetRed(), sky.GetGreen(), sky.GetBlue()));
    g.FillRectangle(&tb, 0.0f, 0.0f, (Gdiplus::REAL)W, (Gdiplus::REAL)VSEL_TITLE_H);
    Gdiplus::Pen ul(Gdiplus::Color(120, 255, 255, 255), 1.0f);
    g.DrawLine(&ul, 0.0f, (Gdiplus::REAL)VSEL_TITLE_H - 0.5f,
               (Gdiplus::REAL)W, (Gdiplus::REAL)VSEL_TITLE_H - 0.5f);
  }
  // 三个按键（靠右：自动 / 截图 / 关闭 —— 2026-09-21 晚新增「自动贴棋盘」开关，
  // 默认开启：后台每 ~1.2s 找一次屏幕上的棋盘，命中即贴）
  // ★ 2026-09-21 收官补丁（用户要求「按键和标题适配英文模式」）：键宽不再写死 ——
  //   先量出当前语言的字宽，再定键宽（「Auto Off」/「Close」比中文长，写死会把字挤到边上），
  //   中文仍按原基准宽（只放大不缩小，观感不变）。量出来的总跨度记进 g_vselBtnSpan，
  //   窄框最小宽度也跟着它走（英文模式下框不会再被拖到三键互相压）。
  {
    // ★ 2026-09-21 收官（用户）：框栏压到原来的 0.6（56→34），按键**只压高度** 44→26，
    //   字号保持不变 —— 省屏幕空间但文字依然好认
    int bh = VsS(26), by = (VSEL_TITLE_H - VsS(26)) / 2;
    Gdiplus::FontFamily ff(BrandFontFace());   // 商用安全字体（思源黑体 SIL OFL 优先，不打包字体文件）
    Gdiplus::Font f(&ff, (Gdiplus::REAL)VsS(16), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetAlignment(Gdiplus::StringAlignmentCenter);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    bool autoOn = g_vselAuto;
    // ★ 英文一律用**短词**（2026-09-21 用户要求）：Auto / Off · Shot · Close。
    //   开关的两种状态靠颜色区分（开 = 浅蓝绿底深青字，关 = 灰蓝底白字），不再靠长文案。
    std::wstring ltAuto[2] = { VshT(L"自动 开", L"Auto"), VshT(L"自动 关", L"Off") };
    std::wstring lt[3] = {
      autoOn ? ltAuto[0] : ltAuto[1],
      VshT(L"截图", L"Shot"),
      VshT(L"关闭", L"Close"),
    };
    int base[3] = { VSEL_AUTO_W, VSEL_BTN_W, VSEL_CLOSE_W };
    int bw[3];
    for (int i = 0; i < 3; ++i) {
      Gdiplus::RectF m;
      g.MeasureString(lt[i].c_str(), -1, &f, Gdiplus::PointF(0, 0), &sf, &m);
      bw[i] = (int)(m.Width + 0.999f) + VsS(22);      // 字宽 + 两侧内边距
      if (bw[i] < base[i]) bw[i] = base[i];
    }
    {   // 「自动」键按「开/关两种状态里更宽的那个」定宽 —— 切换时按键不左右跳
      int wMax = 0;
      for (int i = 0; i < 2; ++i) {
        Gdiplus::RectF m;
        g.MeasureString(ltAuto[i].c_str(), -1, &f, Gdiplus::PointF(0, 0), &sf, &m);
        int w = (int)(m.Width + 0.999f) + VsS(22);
        if (w > wMax) wMax = w;
      }
      if (wMax > bw[0]) bw[0] = wMax;
    }
    int gap = VSEL_BTN_GAP;
    int span = VSEL_EDGE + bw[0] + bw[1] + bw[2] + gap * 2;
    g_vselBtnSpan = span;
    if (span > W - VsS(4)) {                          // 框被拖窄：先收间距，再允许贴左
      gap = VsS(4);
      span = VSEL_EDGE + bw[0] + bw[1] + bw[2] + gap * 2;
    }
    int bx3 = W - VSEL_EDGE - bw[2];
    int bx2 = bx3 - gap - bw[1];
    int bx1 = bx2 - gap - bw[0];
    g_vselBtnAuto  = { bx1, by, bx1 + bw[0], by + bh };
    g_vselBtnShot  = { bx2, by, bx2 + bw[1], by + bh };
    g_vselBtnClose = { bx3, by, bx3 + bw[2], by + bh };
    struct BtnDef { RECT r; int id; int rr, gg, bb; const std::wstring* t; int tr, tg, tb; };
    BtnDef defs[3] = {
      // ★「自动」键浅蓝绿涂色（用户 2026-09-21）：开 = 浅蓝绿底 + 深青字；关 = 灰蓝底白字
      { g_vselBtnAuto,  VSEL_BTN_AUTO,  autoOn ? 72 : 96, autoOn ? 201 : 118, autoOn ? 186 : 136,
        &lt[0], autoOn ? 10 : 255, autoOn ? 62 : 255, autoOn ? 56 : 255 },
      { g_vselBtnShot,  VSEL_BTN_SHOT,  2, 136, 209, &lt[1], 255, 255, 255 },
      { g_vselBtnClose, VSEL_BTN_CLOSE, 214, 96,  96, &lt[2], 255, 255, 255 },
    };
    for (int i = 0; i < 3; ++i) {
      const BtnDef& d = defs[i];
      bool hov = (g_vselHoverBtn == d.id), prs = (g_vselPressBtn == d.id);
      int r = d.rr, gg = d.gg, bb = d.bb;
      if (hov && !prs) { r += 20; gg += 20; bb += 12; }
      if (prs)         { r -= 26; gg -= 26; bb -= 20; }
      if (r < 0) r = 0; if (gg < 0) gg = 0; if (bb < 0) bb = 0;
      if (r > 255) r = 255; if (gg > 255) gg = 255; if (bb > 255) bb = 255;
      Gdiplus::GraphicsPath p;
      VselRoundPath(p, (float)d.r.left, (float)d.r.top,
                    (float)(d.r.right - d.r.left), (float)(d.r.bottom - d.r.top), (float)VsS(5));
      Gdiplus::SolidBrush fb(Gdiplus::Color(255, (BYTE)r, (BYTE)gg, (BYTE)bb));
      g.FillPath(&fb, &p);
      Gdiplus::SolidBrush tb(Gdiplus::Color(255, (BYTE)d.tr, (BYTE)d.tg, (BYTE)d.tb));
      g.DrawString(d.t->c_str(), -1, &f,
                   Gdiplus::RectF((float)d.r.left, (float)d.r.top,
                                  (float)(d.r.right - d.r.left), (float)(d.r.bottom - d.r.top)),
                   &sf, &tb);
    }
  }
  // 标题文字（深藏青：天蓝底上对比够）——**画在三个键之后**（键的矩形算好后才知道还剩
  // 多少地方）。★ 英文适配（2026-09-21 用户）：按「长 → 短」逐档量宽，哪一档放得下画哪一档，
  // 全放不下就不画 —— 绝不压到键上，也绝不留半句被截断的英文。
  {
    Gdiplus::FontFamily ff(BrandFontFace());
    Gdiplus::Font f(&ff, (Gdiplus::REAL)VsS(17), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::SolidBrush b(Gdiplus::Color(255, 10, 54, 74));
    // ★ 英文短句（2026-09-21 用户要求）：「Drag · Shot」/「Shot」，不再一长串
    const wchar_t* cands[3] = {
      g_uiLangEn ? L"Drag · Shot" : L"拖到棋盘 · 点截图",
      g_uiLangEn ? L"Shot"        : L"拖到棋盘",
      g_uiLangEn ? L""            : L"截图",
    };
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::REAL room = (Gdiplus::REAL)(g_vselBtnAuto.left - VsS(8));
    for (int i = 0; i < 3; ++i) {
      if (!cands[i][0]) break;                       // 短档也没了 → 不画标题
      Gdiplus::RectF msz;
      g.MeasureString(cands[i], -1, &f, Gdiplus::PointF(0, 0), &sf, &msz);
      if (VsS(12) + msz.Width <= room) {
        g.DrawString(cands[i], -1, &f, Gdiplus::PointF((Gdiplus::REAL)VsS(12),
                     (Gdiplus::REAL)(VSEL_TITLE_H / 2)), &sf, &b);
        break;
      }
    }
  }
  // 边框（围绕标题栏以下的中空区）+ 四角把手（天蓝，2026-09-21 晚加粗加大）
  {
    Gdiplus::Pen pen(sky, (Gdiplus::REAL)VsS(3));
    g.DrawRectangle(&pen, 1.0f, (Gdiplus::REAL)VSEL_TITLE_H + 1.0f,
                    (Gdiplus::REAL)(W - 2), (Gdiplus::REAL)(H - VSEL_TITLE_H - 2));
    Gdiplus::SolidBrush hb(sky);
    const int hs = VsS(12);     // 四角把手
    float pts[4][2] = {
      {1.0f, (float)VSEL_TITLE_H + 1.0f},
      {(float)(W - 1 - hs), (float)VSEL_TITLE_H + 1.0f},
      {1.0f, (float)(H - 1 - hs)},
      {(float)(W - 1 - hs), (float)(H - 1 - hs)},
    };
    for (int i = 0; i < 4; ++i) g.FillRectangle(&hb, pts[i][0], pts[i][1], (float)hs, (float)hs);
  }
  HDC sdc = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(sdc);
  HGDIOBJ old = SelectObject(mem, g_vselBmp);
  POINT src = { 0, 0 };
  SIZE sz = { W, H };
  BLENDFUNCTION bf = { AC_SRC_OVER, 0, 255, AC_SRC_ALPHA };
  UpdateLayeredWindow(h, sdc, nullptr, &sz, mem, &src, 0, &bf, ULW_ALPHA);
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(nullptr, sdc);
}

/** 点「截图」：把当前框住的区域（不含标题栏）抓成 PNG 回投。抓完收框、恢复窗口。 */
static void VselShot(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + VSEL_TITLE_H;          // 标题栏不算进截图
  RECT rc = { wr.left, top, wr.right, wr.bottom };
  if (rc.right - rc.left < 24 || rc.bottom - rc.top < 24) return;   // 框太小：当误触不抓
  LogMsg("[vis] hollow select confirm: screen (" + std::to_string(rc.left) + "," +
         std::to_string(rc.top) + ") " + std::to_string(rc.right - rc.left) + "x" +
         std::to_string(rc.bottom - rc.top));
  // ★ 用户定稿（2026-09-21 晚）：截完**框保留** —— 挪个位置接着截，只有「关闭」/ESC 才收框；
  //   选框自己是 WDA 排除的，留在屏上也不会被拍进图里。
  VisShotDeliver(rc);
}

// ---- 「自动贴棋盘」（2026-09-21 晚用户定稿：默认开启）----
// 每 ~1.2s（WM_TIMER）在后台抓一张虚拟屏 → GomokuVision --scan-image 离线找盘 →
// 命中就把选框挪到 board_rect 上（标题栏在盘上方、四周外扩 = 半格 + 1/30，见 VSEL_WM_SNAP），
// 复刻五子棋助手「自动贴住棋盘」的手感。找盘跑后台线程：识别一次 0.3~1s，不能占 UI 线程（框要随时能拖）；
// 线程里只碰 GDI/文件/子进程，不碰 GDI+ 绘制。失败（没盘/找不到引擎）就静默等下一轮。
static std::wstring FindVisionExe();                       // 定义在下方（识图离线识别同款）

/** 从 --scan-image 的 stdout 抠 found + board_rect {x,y,w,h}（图像像素，原点=虚拟屏左上）。
 *  顺带抠 geometry.spacing（格距）→ stepOut，供贴框按「半格 + 1/30」同款口径外扩；
 *  scan 没给 spacing 时 stepOut=0，贴框端按 15 路盘 w/14 估算。 */
static bool VselScanRect(const std::string& s, RECT& out, double& stepOut) {
  stepOut = 0;
  size_t i = s.find("\"found\"");
  if (i == std::string::npos) return false;
  i = s.find(':', i);
  if (i == std::string::npos) return false;
  ++i;
  while (i < s.size() && s[i] == ' ') ++i;
  if (s.compare(i, 4, "true") != 0) return false;
  size_t b = s.find("\"board_rect\"");
  if (b == std::string::npos) return false;
  b = s.find('{', b);
  size_t e = s.find('}', b == std::string::npos ? 0 : b);
  if (b == std::string::npos || e == std::string::npos) return false;
  std::string seg = s.substr(b, e - b + 1);
  double v[4] = { 0, 0, 0, 0 };
  const char* keys[4] = { "x", "y", "w", "h" };
  for (int k = 0; k < 4; ++k) {
    std::string kk = std::string("\"") + keys[k] + "\"";
    size_t p = seg.find(kk);
    if (p == std::string::npos) return false;
    p = seg.find(':', p + kk.size());
    if (p == std::string::npos) return false;
    char* end = nullptr;
    v[k] = strtod(seg.c_str() + p + 1, &end);
    if (end == seg.c_str() + p + 1) return false;
  }
  if (v[2] < 150 || v[3] < 150) return false;          // 太小：不是可用的棋盘
  double aspect = v[2] / v[3];
  if (aspect < 0.5 || aspect > 2.0) return false;      // 长宽比不像方盘
  size_t sp = s.find("\"spacing\"");
  if (sp != std::string::npos) {
    size_t p = s.find(':', sp + 9);
    if (p != std::string::npos) {
      char* end = nullptr;
      double sv = strtod(s.c_str() + p + 1, &end);
      if (end != s.c_str() + p + 1 && sv > 4 && sv < (double)(v[2] + v[3])) stepOut = sv;
    }
  }
  out.left = (LONG)(v[0] + 0.5);
  out.top = (LONG)(v[1] + 0.5);
  out.right = (LONG)(v[0] + v[2] + 0.5);
  out.bottom = (LONG)(v[1] + v[3] + 0.5);
  return true;
}

/** 后台找盘一轮：虚拟屏截图 → 临时 PNG → GomokuVision --scan-image → 命中回投。 */
static void VselAutoScan(HWND h) {
  if (g_vselAutoBusy.exchange(true)) return;
  std::thread([h] {
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    RECT rc = { vx, vy, vx + vw, vy + vh };
    std::vector<unsigned char> png = CaptureRectPng(rc);
    do {
      if (png.empty()) break;
      std::wstring exe = FindVisionExe();
      if (exe.empty()) break;
      wchar_t tmp[MAX_PATH] = { 0 };
      GetTempPathW(MAX_PATH, tmp);
      std::wstring imgPath = Join(std::wstring(tmp),
                                  L"gbvis-snap-" + std::to_wstring(GetCurrentProcessId()) + L".png");
      {
        FILE* f = _wfopen(imgPath.c_str(), L"wb");
        if (!f) break;
        fwrite(png.data(), 1, png.size(), f);
        fclose(f);
      }
      std::wstring cmd = L"\"" + exe + L"\" --scan-image \"" + imgPath + L"\"";
      std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end()); cmdBuf.push_back(0);
      SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
      HANDLE rd = nullptr, wr = nullptr;
      if (!CreatePipe(&rd, &wr, &sa, 0)) { DeleteFileW(imgPath.c_str()); break; }
      SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
      STARTUPINFOW si = {};
      si.cb = sizeof(si);
      si.dwFlags = STARTF_USESTDHANDLES;
      si.hStdOutput = wr; si.hStdError = wr;
      PROCESS_INFORMATION pi = {};
      std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\/"));
      // 环境块必须传 nullptr（自建环境块在本机必 ERROR_INVALID_PARAMETER，见引擎 spawn 根因）
      BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                               CREATE_NO_WINDOW, nullptr, cwd.c_str(), &si, &pi);
      CloseHandle(wr);
      if (!ok) { CloseHandle(rd); DeleteFileW(imgPath.c_str()); break; }
      CloseHandle(pi.hThread);
      std::string out;
      char buf[4096];
      DWORD n = 0;
      while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
      CloseHandle(rd);
      if (WaitForSingleObject(pi.hProcess, 15000) != WAIT_OBJECT_0)
        TerminateProcess(pi.hProcess, 1);
      CloseHandle(pi.hProcess);
      DeleteFileW(imgPath.c_str());
      RECT br;
      double step = 0;
      if (VselScanRect(out, br, step)) {
        g_vselStep = step;                   // 贴框端取用（advisory：晚一轮无害）
        br.left += vx; br.right += vx; br.top += vy; br.bottom += vy;   // 图像 → 屏幕坐标
        RECT* rp = new RECT(br);
        if (!PostMessageW(h, VSEL_WM_SNAP, 0, (LPARAM)rp)) delete rp;   // 框刚被关 → 自回收
      }
    } while (0);
    g_vselAutoBusy = false;
  }).detach();
}

static LRESULT CALLBACK VselProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SETCURSOR:
      if (LOWORD(lp) == HTCLIENT) {
        POINT pt; GetCursorPos(&pt); ScreenToClient(h, &pt);
        VselCursor(VselHit(h, pt.x, pt.y));
        return TRUE;
      }
      break;
    case WM_MOUSEMOVE: {
      int mx = GET_X_LPARAM(lp), my = GET_Y_LPARAM(lp);
      if (g_vselDrag != VSEL_NONE && g_vselDrag != VSEL_BTN_SHOT && g_vselDrag != VSEL_BTN_CLOSE) {
        POINT pt; GetCursorPos(&pt);
        int dx = pt.x - g_vselDragPt.x, dy = pt.y - g_vselDragPt.y;
        RECT r = g_vselDragRect;
        switch (g_vselDrag) {
          case VSEL_MOVE: r.left += dx; r.right += dx; r.top += dy; r.bottom += dy; break;
          case VSEL_L: r.left  += dx; break;
          case VSEL_R: r.right += dx; break;
          case VSEL_T: r.top   += dy; break;
          case VSEL_B: r.bottom += dy; break;
          case VSEL_TL: r.left += dx; r.top += dy; break;
          case VSEL_TR: r.right += dx; r.top += dy; break;
          case VSEL_BL: r.left += dx; r.bottom += dy; break;
          case VSEL_BR: r.right += dx; r.bottom += dy; break;
          default: break;
        }
        // ★ 最小宽度必须容得下三个功能键（自动 92 + 截图 96 + 关闭 78 + 间距×2 + 边距
        //   ≈ 296 @100%），再窄三个键就叠到一起了（2026-09-21 用户：最窄不堆叠三个功能键）
        int minW = VsS(330), minH = VSEL_TITLE_H + VsS(60);
        // ★ 英文模式下三键更宽（「Auto Off」/「Close」）→ 最小宽度按实测跨度走，
        //   免得框被拖到三个键互相压（2026-09-21 用户：适配英文）。
        if (g_vselBtnSpan > 0 && g_vselBtnSpan + VsS(30) > minW) minW = g_vselBtnSpan + VsS(30);
        if (r.right - r.left < minW) {
          if (g_vselDrag == VSEL_L || g_vselDrag == VSEL_TL || g_vselDrag == VSEL_BL)
            r.left = r.right - minW;
          else r.right = r.left + minW;
        }
        if (r.bottom - r.top < minH) {
          if (g_vselDrag == VSEL_T || g_vselDrag == VSEL_TL || g_vselDrag == VSEL_TR)
            r.top = r.bottom - minH;
          else r.bottom = r.top + minH;
        }
        SetWindowPos(h, nullptr, r.left, r.top, r.right - r.left, r.bottom - r.top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        VselPaint(h);
        return 0;
      }
      int hit = VselHit(h, mx, my);
      int hov = (hit == VSEL_BTN_SHOT || hit == VSEL_BTN_CLOSE || hit == VSEL_BTN_AUTO) ? hit : VSEL_NONE;
      if (hov != g_vselHoverBtn) { g_vselHoverBtn = hov; VselPaint(h); }
      VselCursor(hit);
      return 0;
    }
    case WM_LBUTTONDOWN: {
      int hit = VselHit(h, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
      if (hit == VSEL_BTN_SHOT || hit == VSEL_BTN_CLOSE || hit == VSEL_BTN_AUTO) {
        g_vselPressBtn = hit; VselPaint(h);
        SetCapture(h);
        return 0;
      }
      if (hit == VSEL_NONE) return 0;
      g_vselDrag = hit;
      GetCursorPos(&g_vselDragPt);
      GetWindowRect(h, &g_vselDragRect);
      SetCapture(h);
      return 0;
    }
    case WM_LBUTTONUP: {
      ReleaseCapture();
      if (g_vselPressBtn != VSEL_NONE) {
        int hit = VselHit(h, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
        int pressed = g_vselPressBtn;
        g_vselPressBtn = VSEL_NONE;
        if (hit == pressed) {
          if (pressed == VSEL_BTN_AUTO) {
            g_vselAuto = !g_vselAuto;        // 「自动贴棋盘」开关（默认开）
            LogMsg(std::string("[vis] auto snap ") + (g_vselAuto ? "on" : "off"));
            if (g_vselAuto) VselAutoScan(h); // 重新打开：立刻找一轮，不等下个 tick
            VselPaint(h);
            return 0;
          }
          if (pressed == VSEL_BTN_SHOT) {
            VselShot(h);                     // 截图：抓框住区域并收框
          } else {
            LogMsg("[vis] hollow select closed");
            VselClose();
            PostToVisPageSoon("{\"type\":\"visShotCancel\"}");
          }
          return 0;
        }
        VselPaint(h);
        return 0;
      }
      g_vselDrag = VSEL_NONE;
      return 0;
    }
    case WM_TIMER:
      if (wp == 1 && g_vselAuto && g_vselDrag == VSEL_NONE) VselAutoScan(h);
      return 0;
    case VSEL_WM_SNAP: {
      // 后台找盘命中：贴到棋盘上（标题栏在盘上方、四周外扩）。用户正在拖就不抢。
      RECT* rp = (RECT*)lp;
      if (!rp) return 0;
      RECT b = *rp;
      delete rp;
      if (!g_vselAuto || g_vselDrag != VSEL_NONE) return 0;
      // ★ 用户定稿（2026-09-21 晚）：贴框时向外多扩约「棋盘尺寸的 1/30」——
      //   紧贴棋盘外框截图会把最外一排棋子切掉半个，识别端再强也读不回缺失的半颗。
      //   ★★ 2026-09-22 深夜修（用户：「1/30 应用到了识图的框的里面」）：board_rect 是
      //   **最外两条格线中心**的包围盒（实测与 geometry 首末线完全重合），木边和外圈棋子
      //   都在它**外面** —— 只外扩 1/30（≈0.47 格距）时框边正好压在外圈棋子边缘，
      //   看上去就是「贴进棋盘里面」。改成与识别端吸附裁剪**完全同口径**
      //   （gbrecognize.cpp：pad = 半格 + 平均边长/30）—— 框落木边之外再外扩 1/30。
      //   step 来自 scan 的 geometry.spacing（缺失按 15 路盘 w/14 估）；原下限 6px 保留。
      LONG bw = b.right - b.left, bh = b.bottom - b.top;
      double step = (g_vselStep > 0) ? g_vselStep : (double)bw / 14.0;
      int pad = (int)(step * 0.5 + ((bw + bh) * 0.5) / 30.0 + 0.5);
      if (pad < 6) pad = 6;
      LONG x = b.left - pad, y = b.top - pad - VSEL_TITLE_H;
      LONG w = bw + pad * 2;
      LONG hh = bh + pad * 2 + VSEL_TITLE_H;
      int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
      int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
      if (y < vy) y = vy;                      // 别把标题栏顶出虚拟屏
      if (x < vx) { w -= (vx - x); x = vx; }   // 外扩后别伸出虚拟屏（抓到黑边）
      if (y + hh > vy + vh) hh = vy + vh - y;
      if (x + w > vx + vw) w = vx + vw - x;
      RECT cur;
      GetWindowRect(h, &cur);
      int dx = cur.left - x, dy = cur.top - y;
      int dw = (cur.right - cur.left) - (int)w, dh = (cur.bottom - cur.top) - (int)hh;
      if (dx > -6 && dx < 6 && dy > -6 && dy < 6 &&
          dw > -6 && dw < 6 && dh > -6 && dh < 6)
        return 0;                              // 已贴好：不动（防每轮重绘抖一下）
      MoveWindow(h, x, y, w, hh, TRUE);
      VselPaint(h);
      LogMsg("[vis] auto snap -> board rect");
      return 0;
    }
    case WM_KEYDOWN:
      if (wp == VK_ESCAPE) {
        LogMsg("[vis] hollow select cancelled (esc)");
        VselClose();
        PostToVisPageSoon("{\"type\":\"visShotCancel\"}");
      }
      return 0;
    case WM_SIZE:
      VselPaint(h);
      return 0;
    // ★ 被外部喊关（识图界面关了 / 主窗退出）：走 VselClose 统一收尾（位图、状态、句柄）
    case WM_CLOSE:
      VselClose();
      return 0;
    case WM_DESTROY:
      KillTimer(h, 1);
      g_visSelHwnd = nullptr;
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

/** 开中空选框并跑模态消息循环（框关了才回来）。 */
static void RunVisHollowSelect() {
  // ★ 根因修复（2026-09-21 晚）：GDI+ 此前只在「编码 PNG」时才初始化；没初始化时
  //   Graphics/FillPath 静默失败 → UpdateLayeredWindow 铺出全透明一张图 = 框「永远不出现」。
  GdiplusEnsure();
  static const wchar_t* kCls = L"GbCalcVisHollow";
  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = VselProc;
  wc.hInstance = g_hInst;
  wc.lpszClassName = kCls;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassExW(&wc);
  RECT wa = { 0, 0, 0, 0 };
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
  int w = VsS(480), h = VsS(360) + VSEL_TITLE_H;     // 初始 480×360@100%（随 DPI 缩放，屏幕居中）
  int x = wa.left + (wa.right - wa.left - w) / 2;
  int y = wa.top + (wa.bottom - wa.top - h) / 2;
  g_visSelHwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                                 kCls, nullptr, WS_POPUP, x, y, w, h,
                                 nullptr, nullptr, g_hInst, nullptr);
  if (!g_visSelHwnd) {
    LogMsg("[vis] failed to create hollow select window");
    PostToVisPageSoon("{\"type\":\"visShotFail\"}");
    return;
  }
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x11
#endif
  // 选框自己绝不能出现在截到的图里 —— 否则天蓝边框会被当成棋盘线污染截图（与助手同一道保险）；
  // 像素测试用 GB_TEST_CAPTURABLE=1 放行（项目统一约定）。
  {
    char cap[8] = { 0 };
    if (GetEnvironmentVariableA("GB_TEST_CAPTURABLE", cap, sizeof(cap)) && cap[0] == '1') {
      LogMsg("[vis] (test) self-capture allowed -> hollow select left capturable on purpose");
    } else {
      SetWindowDisplayAffinity(g_visSelHwnd, WDA_EXCLUDEFROMCAPTURE);
    }
  }
  ShowWindow(g_visSelHwnd, SW_SHOWNORMAL);
  VselPaint(g_visSelHwnd);
  SetTimer(g_visSelHwnd, 1, 1200, nullptr);   // 「自动贴棋盘」轮询（WM_DESTROY 里杀掉）
  LogMsg("[vis] hollow select opened (drag title to move, edges to resize, ESC to cancel)");
  MSG msg;
  while (IsWindow(g_visSelHwnd) && GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  LogMsg("[vis] hollow select loop ended");
}

/** 「屏幕截图」的入口（识图页 visShot 消息 → 主窗 kMsgVisShot，UI 线程调用）。
 *  ★ 2026-09-21（用户定稿）：点「截图」直接上中空选框，**不再最小化三窗** ——
 *  框平时悬空不挡操作（可照常操控别的软件），点「截图」才抓图；截完框保留、
 *  可挪着连截，「关闭」/ESC 收框。 */
static void StartVisShotFlow() {
  LogMsg("[vis] screenshot requested (hollow select)");
  if (g_visSelHwnd && IsWindow(g_visSelHwnd)) return;   // 框已开着 → 不重复弹
  RunVisHollowSelect();
}

/** 找随包的识别引擎：先看 exe 同目录（发布布局），再向上 3 层找开发树的
 *  desktop-vision/build/GomokuVision.exe。找不到返回空串。 */
static std::wstring FindVisionExe() {
  std::wstring c = Join(ExeDir(), L"GomokuVision.exe");
  if (FileExists(c)) return c;
  std::wstring up = ExeDir();
  for (int i = 0; i < 3; ++i) {
    size_t p = up.find_last_of(L"\\/");
    if (p == std::wstring::npos) break;
    up = up.substr(0, p);
    std::wstring c2 = Join(Join(up, L"desktop-vision"), L"build\\GomokuVision.exe");
    if (FileExists(c2)) return c2;
  }
  return L"";
}

/** ★★ 廿四轮（用户要求）：「不管是在识别的图片，还是在抽屉里面，双击这个图片会引起
 *  系统里面的默认图片软件打开这个图片」——
 *  页面送来 {type:'openImage', idx, ext, data:'data:image/…;base64,…'} → 落盘 → 默认看图软件打开。
 *
 *  为什么非借宿主不可：页面手里只有 dataURL（上传/屏幕截图/识别得到的字节），WebView2 里
 *  既没有文件系统，也没有「打开方式」入口；ShellExecuteW("open") 才是让**系统**按扩展名
 *  挑默认看图软件的那条路。
 *
 *  文件落在 %TEMP%\gbvis-open-<idx>.<ext>：**按序号命名**（不是每次新名字），
 *  同一张反复双击只是覆盖重开，不会在 %TEMP% 里越堆越多。
 *  测试钩子 GB_TEST_OPEN_IMAGE=1：只落盘 + 记日志、不真的拉起看图软件
 *  （端到端测试据此验「字节确实到了宿主手里、文件内容与页面那张一致」）。 */
static void OpenImageFromPage(const std::string& s) {
  std::string data = JsonStrAfter(s, "\"data\":");
  std::string ext = JsonStrAfter(s, "\"ext\":");
  int idx = JsonIntAfter(s, "\"idx\":");
  for (size_t i = 0; i < ext.size(); i++) {         // 手写小写化（不依赖 <cctype> 是否被间接引入）
    char ch = ext[i];
    if (ch >= 'A' && ch <= 'Z') ext[i] = (char)(ch - 'A' + 'a');
  }
  if (ext.empty() || ext.size() > 5 ||
      ext.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789") != std::string::npos) {
    ext = "png";                                  // 扩展名只用来挑默认程序，异常值一律 png
  }
  size_t p = data.find("base64,");
  std::vector<unsigned char> bytes = (p == std::string::npos)
      ? std::vector<unsigned char>() : Base64Decode(data.substr(p + 7));
  if (bytes.empty()) { LogMsg("[vis] openImage: empty payload - nothing to open"); return; }

  wchar_t tmp[MAX_PATH] = { 0 };
  GetTempPathW(MAX_PATH, tmp);
  std::wstring path = Join(std::wstring(tmp), L"gbvis-open-" +
                           std::to_wstring(idx > 0 ? idx : 1) + L"." + Utf8ToWide(ext));
  {
    FILE* f = _wfopen(path.c_str(), L"wb");
    if (!f) { LogMsg("[vis] openImage: cannot write " + WideToUtf8(path)); return; }
    fwrite(bytes.data(), 1, bytes.size(), f);
    fclose(f);
  }
  if (TestFlag("GB_TEST_OPEN_IMAGE")) {
    LogMsg("[vis] openImage (test hook: not launching) -> " + WideToUtf8(path) +
           " (" + std::to_string(bytes.size()) + " bytes)");
    return;
  }
  HINSTANCE r = ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  LogMsg("[vis] openImage -> " + WideToUtf8(path) + " (" + std::to_string(bytes.size()) +
         " bytes), hinst=" + std::to_string((long long)(INT_PTR)r));
}

/** 识图页 {type:'visRecognize'} 的兑现（后台线程）：
 *  dataURL → 原始字节写 %TEMP%\gbvis-req.img → GomokuVision.exe --recognize-image /
 *  --scan-image → 收 stdout 的 JSON → 原样回投识图页。 */
static void RunVisionForVis(std::string req) {
  std::string mode = JsonStrAfter(req, "\"mode\":");
  std::string data = JsonStrAfter(req, "\"data\":");
  std::string seq = JsonStrAfter(req, "\"seq\":");     // 页面的防过期序号（翻页后旧结果要丢）
  // ★ 2026-09-22 三轮（用户要求）：「不能一直一直用自动吸附」—— 页面开关关掉时带 nosnap:true，
  //   透传 --nosnap 给引擎（跳过 snapBoardRects 裁小图重读，直接信整图直读结果）。
  std::string nosnap = JsonStrAfter(req, "\"nosnap\":");
  bool skipSnap = nosnap.find("true") != std::string::npos;
  for (size_t i = 0; i < seq.size();) {                // 只留数字，其余当没带
    if (seq[i] < '0' || seq[i] > '9') { seq.erase(i, 1); continue; }
    ++i;
  }
  if (mode != "scan") mode = "image";
  LogMsg("[vis] recognize requested (mode=" + mode + ", payload=" +
         std::to_string(data.size()) + " chars)");
  auto fail = [&](const char* why) {
    LogMsg(std::string("[vis] recognize failed: ") + why);
    PostToVisPageSoon("{\"type\":\"visResult\",\"mode\":\"" + mode +
                      (seq.empty() ? "" : "\",\"seq\":" + seq) +
                      "\",\"result\":{\"ok\":false,\"err\":" + JsonQuote(why) + "}}");
  };
  size_t p = data.find("base64,");
  std::vector<unsigned char> bytes = (p == std::string::npos)
      ? std::vector<unsigned char>() : Base64Decode(data.substr(p + 7));
  if (bytes.empty()) { fail("bad image payload"); return; }

  std::wstring exe = FindVisionExe();
  if (exe.empty()) { fail("GomokuVision.exe not found"); return; }

  wchar_t tmp[MAX_PATH] = { 0 };
  GetTempPathW(MAX_PATH, tmp);
  std::wstring imgPath = Join(std::wstring(tmp), L"gbvis-req.img");
  {
    FILE* f = _wfopen(imgPath.c_str(), L"wb");
    if (!f) { fail("cannot write temp image"); return; }
    fwrite(bytes.data(), 1, bytes.size(), f);
    fclose(f);
  }
  // ★ 喂的是**原始文件字节**（与浏览器 / HTTP 链路同一口径）—— 写盘后由引擎自己读，
  //   千万别在宿主里 imread→imencode 绕一圈（那段路上误报会变多，见 test-vision-service 注释）。
  std::wstring cmd = L"\"" + exe + L"\" " +
                     (mode == "scan" ? L"--scan-image" : L"--recognize-image") +
                     L" \"" + imgPath + L"\"" +
                     (skipSnap ? L" --nosnap" : L"");
  std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end()); cmdBuf.push_back(0);

  SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) { fail("cannot create pipe"); return; }
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);     // 读端不许被子进程继承
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr;
  si.hStdError = wr;
  PROCESS_INFORMATION pi = {};
  std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\/"));
  // ★ 环境块必须传 nullptr（自建环境块在本机必 ERROR_INVALID_PARAMETER，见引擎 spawn 根因）
  BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW, nullptr, cwd.c_str(), &si, &pi);
  CloseHandle(wr);                       // 写端先关，管道 EOF 才能在子进程退出后到达
  if (!ok) { CloseHandle(rd); fail("spawn failed"); DeleteFileW(imgPath.c_str()); return; }
  CloseHandle(pi.hThread);

  std::string out;
  char buf[4096];
  DWORD n = 0;
  while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
  CloseHandle(rd);
  // 引擎实测 <1s（离线对拍 0.3~1.0s）；10s 还不出结果当它挂了（2026-09-21 从 20s 收紧）
  DWORD wait = WaitForSingleObject(pi.hProcess, 10000);
  if (wait != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hProcess);
  DeleteFileW(imgPath.c_str());

  // stdout 里只有一行 JSON（离线入口 printf 的就是它）；顺手去掉首尾空白
  while (!out.empty() && (unsigned char)out.front() <= ' ') out.erase(0, 1);
  while (!out.empty() && (unsigned char)out.back() <= ' ') out.pop_back();
  if (out.empty() || out[0] != '{') { fail("no recognizer output"); return; }
  LogMsg("[vis] recognize ok (" + std::to_string(out.size()) + " bytes, mode=" + mode + ")");
  PostToVisPageSoon("{\"type\":\"visResult\",\"mode\":\"" + mode +
                    (seq.empty() ? "" : "\",\"seq\":" + seq) +
                    "\",\"result\":" + out + "}");
}


// ---------------------------------------------------------------- 系统剪贴板
// 页面里的 navigator.clipboard 在 WebView2 下经常被权限直接拒绝 —— 用户点「粘贴」毫无反应。
// 所以复制 / 粘贴都走宿主：粘贴 = 宿主读 Win32 剪贴板再回推给页面；复制 = 宿主直接写剪贴板。
static std::wstring ReadClipboardText() {
  std::wstring out;
  if (!OpenClipboard(g_hwnd)) return out;
  HANDLE h = GetClipboardData(CF_UNICODETEXT);
  if (h) {
    const wchar_t* p = (const wchar_t*)GlobalLock(h);
    if (p) { out.assign(p); GlobalUnlock(h); }
  }
  CloseClipboard();
  return out;
}
static bool WriteClipboardText(const std::wstring& s) {
  if (!OpenClipboard(g_hwnd)) return false;
  EmptyClipboard();
  size_t bytes = (s.size() + 1) * sizeof(wchar_t);
  HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!h) { CloseClipboard(); return false; }
  void* p = GlobalLock(h);
  if (p) {
    memcpy(p, s.c_str(), bytes);
    GlobalUnlock(h);
    SetClipboardData(CF_UNICODETEXT, h);
  } else {
    GlobalFree(h);
  }
  CloseClipboard();
  return true;
}

// ---------------------------------------------------------------- 引擎（页面内 AI）
// ★ 2026-09-19 架构改造（用户要求「AI 嵌进练习器，去掉 Web GomokuEngine 与 :8964 连接方式」）：
//   AI = rapfi（C++ 编译的 SIMD wasm + pthreads）直接跑在页面 Worker 里（ui/engine-ai.js）。
//   多线程能力由 WebView2(Chromium) 的 SharedArrayBuffer/pthreads 提供 —— 载荷与原独立引擎
//   完全同源、线程/哈希配比不变，只是去掉了 Node 进程与 HTTP 一跳；算力路径上做的是减法。
//   宿主职责：① 所有响应带 COOP/COEP（crossOriginIsolated = SAB 的前提）；
//            ② /ai/* 从 exe 旁 resources/ 供给 rapfi 资源；③ 子进程提权（见 BoostWebViewPriority）。
static int        g_threads = 0;      // 页面上报的线程档位（Worker 自己消化，这里只记录）
static int        g_hashMB = 0;       // 页面上报的哈希档位（同上）

/** 核心数上限：总核数减去 1/2/4（机器越强留越多给系统），默认是总核的一半。 */
static int CpuCount() {
  SYSTEM_INFO si; GetNativeSystemInfo(&si);
  int n = (int)si.dwNumberOfProcessors;
  return n > 0 ? n : 4;
}
static int ThreadsDefault() {
  int n = CpuCount();
  int t = n / 2;
  if (t < 1) t = 1;
  return t;
}
static int ThreadsMax() {
  int n = CpuCount();
  int sub = (n >= 16) ? 4 : ((n >= 8) ? 2 : 1);
  int t = n - sub;
  if (t < 1) t = 1;
  return t;
}

/** 物理内存总量（MB）。页面拿它决定哈希档位：<8GB 时 6GB 档要变灰不可选。 */
static int MemTotalMB() {
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms) && ms.ullTotalPhys > 0)
    return (int)(ms.ullTotalPhys / (1024ull * 1024ull));
  return 4096;
}

/** 把本进程的 WebView2 子进程（msedgewebview2.exe）提到 High 优先级 ——
 *  对齐原独立引擎 boot 时的提权（engine-server 的 PriorityClass='High'），
 *  短步时搜索线程抢得到 CPU。best-effort：失败静默。 */
static void BoostWebViewPriority() {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  DWORD me = GetCurrentProcessId();
  PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
  int boosted = 0;
  if (Process32FirstW(snap, &pe)) {
    do {
      if (pe.th32ParentProcessID == me && wcscmp(pe.szExeFile, L"msedgewebview2.exe") == 0) {
        HANDLE h = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pe.th32ProcessID);
        if (h) {
          if (SetPriorityClass(h, HIGH_PRIORITY_CLASS)) boosted++;
          CloseHandle(h);
        }
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  if (boosted > 0) LogMsg("[ai] boosted " + std::to_string(boosted) + " webview child process(es) to High priority");
}

// ---------------------------------------------------------------- 存档接入（:8972 + 落盘 inbox）

static std::string g_inboxSeen;

/** 极简 HTTP：只认 POST /history（书签页存档）。带 CORS，跨源可直接 POST。 */
static void HttpHistoryServer() {
  WSADATA wsd;
  if (WSAStartup(MAKEWORD(2, 2), &wsd) != 0) { LogMsg("[inbox] WSAStartup failed"); return; }
  SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (ls == INVALID_SOCKET) return;
  int one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof(one));
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(8972);
  if (bind(ls, (sockaddr*)&addr, sizeof(addr)) != 0 || listen(ls, 8) != 0) {
    LogMsg("[inbox] :8972 bind/listen failed (port busy?)");
    closesocket(ls);
    return;
  }
  LogMsg("[inbox] history endpoint listening on http://127.0.0.1:8972/history");
  while (g_running.load()) {
    SOCKET cs = accept(ls, nullptr, nullptr);
    if (cs == INVALID_SOCKET) break;
    std::string req;
    char buf[4096];
    int n = recv(cs, buf, sizeof(buf) - 1, 0);
    if (n > 0) { buf[n] = 0; req = buf; }
    // 找请求头结束位置，取 body
    size_t he = req.find("\r\n\r\n");
    std::string body;
    if (he != std::string::npos) body = req.substr(he + 4);
    size_t cl = std::string::npos;
    {
      std::string low = req;
      for (auto& c : low) if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
      size_t p = low.find("content-length:");
      if (p != std::string::npos) cl = (size_t)atoi(low.c_str() + p + 15);
    }
    while (cl != std::string::npos && body.size() < cl) {
      int k = recv(cs, buf, sizeof(buf) - 1, 0);
      if (k <= 0) break;
      buf[k] = 0; body += buf;
    }
    std::string resp;
    if (req.rfind("POST", 0) == 0 && !body.empty()) {
      // 原样转给页面：页面负责校验与入库（上限 150 局）
      std::string msg = "{\"type\":\"historyInbox\",\"text\":";
      msg += JsonQuote(body);
      msg += "}";
      PostToPage(msg);
      LogMsg("[inbox] HTTP /history " + std::to_string(body.size()) + " bytes");
      resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
             "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST,OPTIONS\r\n"
             "Access-Control-Allow-Headers: Content-Type\r\n"
             "Access-Control-Allow-Private-Network: true\r\n"
             "Content-Length: 15\r\nConnection: close\r\n\r\n{\"ok\":true}\n";
    } else if (req.rfind("OPTIONS", 0) == 0) {
      resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\n"
             "Access-Control-Allow-Methods: POST,OPTIONS\r\n"
             "Access-Control-Allow-Headers: Content-Type\r\n"
             "Access-Control-Allow-Private-Network: true\r\n"
             "Content-Length: 0\r\nConnection: close\r\n\r\n";
    } else {
      resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    }
    send(cs, resp.c_str(), (int)resp.size(), 0);
    closesocket(cs);
  }
  closesocket(ls);
  WSACleanup();
}

// ---------------------------------------------------------------- 页面供给（本地 HTTP · 动态端口）
// ★ 2026-09-28 终版（用户要求「更稳妥的 UI 连接方式」）：页面供给回到**宿主内置本地 HTTP**，
//   但端口改为 **bind(port 0) 由系统分配**（g_uiPort）—— 固定 :8965 时代「多开 / 实例未退净
//   → bind 失败 → ERR_CONNECTION_REFUSED」（本日 15:36 实测三连，用户截图为证）被根治。
//   · 进程内拦截器（gbcalc.*）方案同日投入两小时实测后**否决**：小页面能通，真实 calc 页
//     必现导航管线停摆（overlay 壳载同页直接 err=9），细节见 SetupUiServing 函数注释；
//   · calc/：有 .enc 优先内存解密（发布版磁盘无明文），无 .enc 回退明文（开发版）；
//   · /engine/*：原生引擎桥（与 ResHandler 共用 NativeEngineRouteJson）；
//   · /ai/*：exe 旁 resources/ 的 rapfi 模型（basename，挡 .. 穿越），带长缓存。

static void SendAll(SOCKET cs, const char* p, int n) {
  while (n > 0) {
    int k = send(cs, p, n, 0);
    if (k <= 0) return;
    p += k; n -= k;
  }
}

// ---------------------------------------------------------------- 原生 Rapfi 引擎桥（★ 仅纯训练器版）
// 背景（2026-09-24 用户定稿）：纯训练器版把页面里的 rapfi **WASM** 换成**原生 C++ rapfi**。
//   · WASM 只有 simd128（128 位）+ SAB/pthread 开销 + wasm32 地址空间天花板；
//     原生可用 AVX512+VNNI（本机 CPU 实测支持）、真 OS 线程、想吃多少内存吃多少 →
//     同样时间搜得更深，棋力更高。这是「提升最高智力」的正路。
//   · 变体按 CPU 现场挑：AVX512F+DQ+BW+VL+VNNI 齐 → RapfiEngine-avx512.exe，否则 RapfiEngine-avx2.exe。
//     （两个变体都随包发，换台机器不会因缺指令集直接 SIGILL。）
//   · 三条车道 main / sub / fwd 各起**一个独立进程** —— 与 WASM 版的三 Worker 一一对应，
//     互不排队（fwd 前瞻推演不与主搜索抢线程/哈希），线程与哈希按车道分配，口径同 laneSpecs()。
//   · ★ 只在 **exe 旁存在 rapfi-native/ 目录** 时启用。三合一版不部署该目录 → 照旧走 WASM，
//     满足用户「仅仅替换纯训练器版本」的要求。
//   · 页面里 AI 跑在 Worker，**拿不到 chrome.webview**，所以通道走同源 HTTP（与页面同源 :8965）：
//       POST /engine/cmd?lane=main     body = 命令行原文        → 写入该车道引擎 stdin
//       GET  /engine/out?lane=main&since=N                     → {seq, lines:[...]}（N 之后的新行）
//       GET  /engine/status                                    → {available, variant, cpus, memMB, lanes}
//       POST /engine/reset?lane=main                           → 重启该车道（崩溃自愈）
//     用「拉」而不是推：waitForMove 本来就是 60ms 轮询 lane.outBuf，这里 20ms 把新行补进
//     同一个 buffer 即可，零协议改动、无需长连接与常驻线程。
// 前置声明（定义在命名空间之后）：HandlePageCmd('status') 的应答要附带完整探测负载。
static std::string NativeEngineRouteJson(const std::string& route, const std::string& query,
                                         const std::string& reqBody);
namespace nativeeng {

static const int LANE_COUNT = 3;

struct Engine {
  HANDLE    hProcess = nullptr;    // ★ 必须记账：否则重启时杀不掉旧进程（见 SpawnLocked）
  HANDLE    hStdin    = nullptr;
  HANDLE    hStdout   = nullptr;   // 所有权归**读线程**（它 ReadFile 见 EOF 后自己 Close）
  std::mutex mu;                   // 保护 lines / seq / dropped
  std::mutex spawnMu;              // ★ 串行化 Ensure/Spawn/Write：修「每车道 2 个进程」
  std::deque<std::string> lines;   // 尚未被页面取走的输出行
  uint64_t  seq       = 0;         // 累计产出行数（页面用它做 since 游标）
  uint64_t  dropped   = 0;         // 环形溢出丢弃数（页面长时间不取时保护内存）
  std::atomic<bool> alive{false};  // ★ 跨线程读写（HTTP 线程读 / 读线程写），必须 atomic
  std::atomic<int>  gen{0};        // ★ 代际号：每 Spawn 一次 +1；老读线程据此不污染新引擎
};

static Engine      g_eng[LANE_COUNT];
static std::string g_laneName[LANE_COUNT] = {"main", "sub", "fwd"};

static bool    g_probed  = false;   // 是否已探测过 rapfi-native/
static bool    g_avail   = false;   // rapfi-native/ 存在且至少有一个可执行变体
static std::string g_variant;       // "avx512" | "avx2"
static std::wstring g_dir;          // rapfi-native/ 绝对路径

static int LaneIndex(const std::string& name) {
  for (int i = 0; i < LANE_COUNT; i++) if (g_laneName[i] == name) return i;
  return -1;
}

/// 本机是否支持「AVX512F + DQ + BW + VL + VNNI」——与 avx512 变体编译期开关(/arch:AVX512 + USE_VNNI)对齐。
static bool CpuSupportsAvx512Vnni() {
  int r[4] = {0, 0, 0, 0};
  __cpuidex(r, 0, 0);
  if (r[0] < 7) return false;
  __cpuidex(r, 7, 0);
  bool avx512f  = (r[1] >> 16) & 1;
  bool avx512dq = (r[1] >> 17) & 1;
  bool avx512bw = (r[1] >> 30) & 1;
  bool avx512vl = (r[1] >> 31) & 1;
  bool vnni     = ((r[2] >> 11) & 1) != 0;   // AVX512_VNNI
  return avx512f && avx512dq && avx512bw && avx512vl && vnni;
}

/// 探测 rapfi-native/ 并选定变体。只在首次调用时做，之后走缓存。
static void Probe() {
  if (g_probed) return;
  g_probed = true;
  std::wstring dir = Join(ExeDir(), L"rapfi-native");
  if (!FileExists(Join(dir, L"config.toml"))) {
    LogMsg("[engine] rapfi-native/config.toml 不存在 → 走页面内 WASM（纯训练器版才带原生引擎）");
    return;
  }
  bool avx512 = FileExists(Join(dir, L"RapfiEngine-avx512.exe"));
  bool avx2   = FileExists(Join(dir, L"RapfiEngine-avx2.exe"));
  if (avx512 && CpuSupportsAvx512Vnni())      g_variant = "avx512";
  else if (avx2)                              g_variant = "avx2";
  else if (avx512)                            g_variant = "avx512";
  else { LogMsg("[engine] rapfi-native/ 里没有引擎 exe → 走 WASM"); return; }
  g_dir   = dir;
  g_avail = true;
  LogMsg("[engine] 原生 Rapfi 可用：variant=" + g_variant + " dir=" + WideToUtf8(dir));
}

/// 给宿主报文用：本进程旁边有没有可用的原生引擎（首次调用会触发探测，之后走缓存）。
static bool Available() {
  Probe();
  return g_avail;
}

/// 读线程：**自带 out 句柄**（不读 e.hStdout —— 否则重启后老线程会跑到新管道上抢数据），
/// 并带 myGen 代际号：只有自己那一代仍是当前代时，才允许把 alive 置 false。
static void ReaderThread(int idx, HANDLE out, int myGen) {
  Engine& e = g_eng[idx];
  std::string pending;
  char buf[8192];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(out, buf, sizeof(buf), &n, nullptr) || n == 0) break;
    pending.append(buf, n);
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, pos);
      pending.erase(0, pos + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.rfind("ERROR", 0) == 0) LogMsg("[engine:" + g_laneName[idx] + "] " + line);
      std::lock_guard<std::mutex> lk(e.mu);
      // 上限 4 万行：页面若长时间不取（例如窗口最小化），宁可丢老行也别把宿主内存吃光。
      if (e.lines.size() >= 40000) { e.lines.pop_front(); e.dropped++; }
      e.lines.push_back(line);
      e.seq++;
    }
    RequestEngineFlush();                            // ★ 推给页面（新后端；未启用时是 no-op）
  }
  CloseHandle(out);                                  // 句柄所有权在本线程（见 Engine.hStdout 注释）
  if (e.gen.load() != myGen) return;                 // ★ 已被新一代取代 → 不许碰新引擎的状态
  std::lock_guard<std::mutex> lk(e.mu);
  e.alive = false;
  e.lines.push_back("");           // 收尾：让页面看到一次推进，知道车道断了
  e.seq++;
}
// ★ RequestEngineFlush 由读线程调用 → 必须在 namespace 内可见（声明在文件前部）。

/// 起（或重启）某车道的原生引擎进程。cwd = rapfi-native/，config.toml 与权重都在那儿。
/// ★ 必须持 spawnMu 调用（内部不锁）——见下面的 Spawn / Ensure / WriteEnsured。
///
/// 这里修的是「每个车道跑出 2 个 RapfiEngine-*.exe」的根因（2026-09-24 实测定到 6 个进程）：
///   ① 原实现 `CloseHandle(pi.hProcess)` 之后**从不**把句柄写回 e.hProcess → 旧进程杀不掉，
///      重启只会在旁边再挂一个孤儿（进程泄漏），而 e.hStdin/hStdout 被新管道顶掉后旧句柄也丢；
///   ② e.alive 是普通 bool 且 Ensure 无锁 → 开机时页面 pump 的自动 reset 与 boot 连发的
///      START/INFO 并发进来，两条线程都看到 alive==false，各 Spawn 一次（= 2 个进程）。
static bool SpawnLocked(int idx) {
  Engine& e = g_eng[idx];
  // —— 回收上一代（顺序：先杀进程让旧管道保证 EOF，再交还句柄）——
  if (e.hProcess) { TerminateProcess(e.hProcess, 0); CloseHandle(e.hProcess); e.hProcess = nullptr; }
  if (e.hStdin)   { CloseHandle(e.hStdin); e.hStdin = nullptr; }
  e.hStdout = nullptr;                  // 旧的交给老读线程自己 Close（它见到 EOF 就退）
  e.alive   = false;

  std::wstring exe = Join(g_dir, std::wstring(L"RapfiEngine-") + Utf8ToWide(g_variant) + L".exe");

  SECURITY_ATTRIBUTES sa = {};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE inR = nullptr, inW = nullptr, outR = nullptr, outW = nullptr;
  if (!CreatePipe(&inR, &inW, &sa, 0)) return false;
  if (!CreatePipe(&outR, &outW, &sa, 0)) { CloseHandle(inR); CloseHandle(inW); return false; }
  SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = inR;
  si.hStdOutput = outW;
  si.hStdError = outW;              // 引擎的 ERROR 走 stderr，并进来方便落日志
  PROCESS_INFORMATION pi = {};
  std::wstring cmd = L"\"" + exe + L"\"";
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  // ★ 环境块必须传 nullptr（自建环境块在本机必 ERROR_INVALID_PARAMETER(87)，见本文件引擎 spawn 注释）
  BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW, nullptr, g_dir.c_str(), &si, &pi);
  CloseHandle(inR);
  CloseHandle(outW);
  if (!ok) {
    CloseHandle(inW); CloseHandle(outR);
    LogMsg("[engine:" + g_laneName[idx] + "] spawn 失败 err=" + std::to_string(GetLastError()));
    return false;
  }
  CloseHandle(pi.hThread);

  e.hProcess = pi.hProcess;         // ★ 记账（不再 Immediately CloseHandle）：下次重启能杀
  e.hStdin   = inW;
  e.hStdout  = outR;
  int myGen  = ++e.gen;             // ★ 新一代：老读线程看到代际不符就不再碰 alive
  {
    std::lock_guard<std::mutex> lk(e.mu);
    e.lines.clear(); e.seq = 0; e.dropped = 0;
  }
  e.alive = true;
  std::thread(ReaderThread, idx, outR, myGen).detach();
  LogMsg("[engine:" + g_laneName[idx] + "] 已启动 " + WideToUtf8(exe) + " (gen=" + std::to_string(myGen) + ")");
  return true;
}

/// 强制重启某车道（用户/页面显式请求）。持 spawnMu 串行化。
static bool Spawn(int idx) {
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  return SpawnLocked(idx);
}

/// 确保车道有活着的引擎（已活则**绝不**重启）。持 spawnMu：并发调用只会 Spawn 一次。
static bool Ensure(int idx) {
  Probe();
  if (!g_avail) return false;
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  if (g_eng[idx].alive.load()) return true;
  return SpawnLocked(idx);
}

/// 直接把命令写进当前 stdin（不持锁、不管进程死活）——只给 WriteEnsured 内部语义参考用。
/// 注意：**不要再从路由层直接调它**，见 WriteEnsured 的注释。
static void Write(int idx, const std::string& text) {
  Engine& e = g_eng[idx];
  if (!e.hStdin) return;
  std::string s = text;
  if (s.empty() || s.back() != '\n') s += "\n";
  DWORD wr = 0;
  WriteFile(e.hStdin, s.data(), (DWORD)s.size(), &wr, nullptr);
}

/// ★ 原子「确保活着 + 写命令」：宿主 /engine/cmd 走这条。
/// 为什么不能拆成 Ensure() 再 Write()：并发重 spawn 时，Ensure 返回后 hStdin 可能已被换成
/// 新进程的管道 —— 拆开写就会把 START/INFO 打进**已被杀掉**的旧进程（WriteFile 失败）→ 车道
/// 永远 boot 不起来。持同一把 spawnMu 就把「谁活着」与「往谁写」绑成一个原子步。
static bool WriteEnsured(int idx, const std::string& text) {
  Probe();
  if (!g_avail) return false;
  Engine& e = g_eng[idx];
  std::lock_guard<std::mutex> lk(e.spawnMu);
  if (!e.alive.load() && !SpawnLocked(idx)) return false;
  if (!e.hStdin) return false;
  std::string s = text;
  if (s.empty() || s.back() != '\n') s += "\n";
  DWORD wr = 0;
  return WriteFile(e.hStdin, s.data(), (DWORD)s.size(), &wr, nullptr) != 0;
}

/// 取 since 之后的新行；返回 JSON 文本。同时带上 rowSeq 让页面知道游标推到哪。
static std::string Poll(int idx, uint64_t since) {
  Engine& e = g_eng[idx];
  std::string out = "{\"alive\":";
  out += e.alive.load() ? "true" : "false";
  out += ",\"dropped\":" + std::to_string(e.dropped);
  out += ",\"lines\":[";
  bool first = true;
  std::lock_guard<std::mutex> lk(e.mu);
  uint64_t start = since > e.seq ? 0 : since;
  uint64_t base  = e.seq >= e.lines.size() ? e.seq - e.lines.size() : 0;
  for (size_t i = 0; i < e.lines.size(); i++) {
    uint64_t abs = base + i;
    if (abs < start) continue;
    if (!first) out += ",";
    first = false;
    out += JsonQuote(e.lines[i]);
  }
  out += "],\"seq\":" + std::to_string(e.seq) + "}";
  return out;
}

/// ★★ 2026-09-25 新后端（用户要求「用合理高效的手段重新构建连接后端」）：
///  把三个车道的新输出**打包成一条消息推给页面**，替代原来「页面每 15ms 打一次
///  :8965/engine/out」的轮询。省掉的开销（纯训练器版实测三车道 ≈ 200 次 HTTP/秒）：
///    · 每次轮询 = accept + 线程 + HTTP 解析 + JSON 编码 + 浏览器 fetch 往返；
///    · 输出到达页面的延迟从「0~15ms 轮询 + 0~60ms 解析」降到「读线程 → 一次消息」；
///    · 引擎安静时完全不产生任何消息（轮询则是永不停歇的空转）。
///  单条消息每车道最多带 800 行（SHOW_DETAIL 3 的 INFO 很密），超了下一趟再带。
static bool FlushToPage() {
  std::string out = "{\"type\":\"engineOut\",\"lanes\":[";
  bool any = false, first = true;
  for (int i = 0; i < LANE_COUNT; i++) {
    Engine& e = g_eng[i];
    std::vector<std::string> take;
    uint64_t seq = 0, dropped = 0;
    bool alive = e.alive.load();
    {
      std::lock_guard<std::mutex> lk(e.mu);
      if (e.lines.empty()) continue;
      size_t n = e.lines.size();
      if (n > 800) n = 800;
      take.assign(e.lines.begin(), e.lines.begin() + n);
      e.lines.erase(e.lines.begin(), e.lines.begin() + n);
      seq = e.seq; dropped = e.dropped;
    }
    if (!first) out += ",";
    first = false;
    out += "{\"lane\":" + JsonQuote(g_laneName[i]);
    out += ",\"alive\":" + std::string(alive ? "true" : "false");
    out += ",\"seq\":" + std::to_string(seq);
    out += ",\"dropped\":" + std::to_string(dropped);
    out += ",\"lines\":[";
    for (size_t k = 0; k < take.size(); k++) {
      if (k) out += ",";
      out += JsonQuote(take[k]);
    }
    out += "]}";
    any = true;
  }
  out += "]}";
  if (!any) return false;
  PostToPage(out);
  return true;
}

/// 页面 → 引擎（一次一批命令）。返回给页面的回执 ack 文本。
static std::string HandlePageCmd(const std::string& op, int idx,
                                 const std::vector<std::string>& cmds, int id) {
  bool ok = false;
  if (idx < 0) ok = false;
  else if (op == "cmd") {
    std::string body;
    for (size_t i = 0; i < cmds.size(); i++) { body += cmds[i]; body += "\n"; }
    ok = cmds.empty() || WriteEnsured(idx, body);
  } else if (op == "ensure") ok = Ensure(idx);
  else if (op == "reset")    ok = Spawn(idx);
  else if (op == "status")   ok = true;
  std::string r = "{\"type\":\"engineAck\",\"id\":" + std::to_string(id);
  r += ",\"op\":" + JsonQuote(op);
  r += ",\"lane\":" + JsonQuote(idx >= 0 ? g_laneName[idx] : std::string(""));
  r += ",\"ok\":" + std::string(ok ? "true" : "false");
  r += ",\"alive\":" + std::string((idx >= 0 && g_eng[idx].alive.load()) ? "true" : "false");
  // ★ 2026-09-28 硬连接 UI：Worker 经 postMessage 探测原生引擎（不再依赖 Worker fetch），
  //   应答里带上与 /engine/status 同形的完整负载（见 engine-ai.js probeNative 的 RELAY 分支）。
  if (op == "status") r += ",\"status\":" + NativeEngineRouteJson("status", "", "");
  r += "}";
  return r;
}

}  // namespace nativeeng

/** /engine/* 路由的统一实现（HttpUiServer 与 gbcalc.local 拦截器**共用**，2026-09-28）。
 *  route = 已去掉 "/engine/" 前缀的路由名；query = 原始查询串；reqBody = POST 体原文。 */
static std::string NativeEngineRouteJson(const std::string& route, const std::string& query,
                                         const std::string& reqBody) {
  auto qget = [&](const char* key) -> std::string {
    std::string k = std::string(key) + "=";
    size_t p = query.find(k);
    if (p == std::string::npos) return "";
    size_t e2 = query.find('&', p);
    return query.substr(p + k.size(), e2 == std::string::npos ? std::string::npos : e2 - (p + k.size()));
  };
  std::string lane = qget("lane");
  int idx = lane.empty() ? 0 : nativeeng::LaneIndex(lane);
  std::string payload;
  if (route == "status") {
    nativeeng::Probe();
    MEMORYSTATUSEX ms = {}; ms.dwLength = sizeof(ms);
    GlobalMemoryStatusEx(&ms);
    payload = std::string("{\"available\":") + (nativeeng::g_avail ? "true" : "false") +
              ",\"variant\":" + JsonQuote(nativeeng::g_variant) +
              ",\"cpus\":" + std::to_string((int)std::thread::hardware_concurrency()) +
              ",\"memMB\":" + std::to_string((long long)(ms.ullTotalPhys / (1024 * 1024))) +
              ",\"lanes\":[\"main\",\"sub\",\"fwd\"]}";
  } else if (idx < 0) {
    payload = "{\"error\":\"bad lane\"}";
  } else if (route == "cmd") {
    // ★ 原子「确保活着 + 写命令」：并发请求不会各起一个进程，命令也不会打进旧进程。
    bool ok = nativeeng::WriteEnsured(idx, reqBody);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "ensure") {
    // ★ 页面的自动恢复走这条：**已活着就不重启**。老页面若还调 reset 也仍然安全（有锁）。
    bool ok = nativeeng::Ensure(idx);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "reset") {
    bool ok = nativeeng::Spawn(idx);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "out") {
    uint64_t since = (uint64_t)strtoull(qget("since").c_str(), nullptr, 10);
    payload = nativeeng::Poll(idx, since);
  } else {
    payload = "{\"error\":\"unknown engine route\"}";
  }
  return payload;
}

static const char* UiHttpMime(const std::string& p) {
  size_t dot = p.rfind('.');
  std::string e = (dot == std::string::npos) ? "" : p.substr(dot);
  for (auto& c : e) if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
  if (e == ".html") return "text/html; charset=utf-8";
  if (e == ".js")   return "text/javascript; charset=utf-8";
  if (e == ".css")  return "text/css; charset=utf-8";
  if (e == ".wasm") return "application/wasm";
  return "application/octet-stream";
}

static void HttpUiServer() {
  WSADATA wsd;
  if (WSAStartup(MAKEWORD(2, 2), &wsd) != 0) { LogMsg("[ui-http] WSAStartup failed"); return; }
  SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (ls == INVALID_SOCKET) return;
  int one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof(one));
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  // ★ 2026-09-28：**bind(port 0)** —— 由系统分配一个当前空闲的端口。
  //   固定 8965 的时代，「上个实例没退净 / 用户多开」时 bind 失败 → 新窗全部
  //   ERR_CONNECTION_REFUSED（本日实测）。动态端口后该故障在物理上不可能发生。
  addr.sin_port = htons(0);
  if (bind(ls, (sockaddr*)&addr, sizeof(addr)) != 0 || listen(ls, 8) != 0) {
    LogMsg("[ui-http] bind/listen failed (even port 0?!)");
    closesocket(ls);
    WSACleanup();
    return;
  }
  sockaddr_in bound = {};
  int blen = sizeof(bound);
  int port = 0;
  if (getsockname(ls, (sockaddr*)&bound, &blen) == 0) port = ntohs(bound.sin_port);
  g_uiPort.store(port > 0 ? port : 8965);
  LogMsg("[ui-http] UI+AI serving on http://127.0.0.1:" + std::to_string(g_uiPort.load()) +
         "/ (COOP/COEP on, port auto-assigned - no collision possible)");
  while (g_running.load()) {
    SOCKET cs = accept(ls, nullptr, nullptr);
    if (cs == INVALID_SOCKET) break;
    std::thread([cs] {
      std::string req;
      char buf[4096];
      for (;;) {
        int n = recv(cs, buf, sizeof(buf) - 1, 0);
        if (n <= 0) { closesocket(cs); return; }
        buf[n] = 0; req += buf;
        if (req.find("\r\n\r\n") != std::string::npos) break;
        if (req.size() > 16384) break;
      }
      size_t sp1 = req.find(' ');
      size_t sp2 = (sp1 == std::string::npos) ? std::string::npos : req.find(' ', sp1 + 1);
      std::string method = (sp1 != std::string::npos) ? req.substr(0, sp1) : "GET";
      std::string path = (sp1 != std::string::npos && sp2 != std::string::npos)
                             ? req.substr(sp1 + 1, sp2 - sp1 - 1) : "";
      std::string query;
      size_t q = path.find('?');
      if (q != std::string::npos) { query = path.substr(q + 1); path = path.substr(0, q); }

      // ---- POST 体：/engine/cmd 要收命令行（YXBOARD 整条最长约 1.5KB）----
      std::string reqBody;
      {
        size_t he = req.find("\r\n\r\n");
        if (he != std::string::npos) {
          reqBody = req.substr(he + 4);
          size_t clPos = req.find("Content-Length:");
          if (clPos == std::string::npos) clPos = req.find("content-length:");
          size_t want = 0;
          if (clPos != std::string::npos) want = (size_t)strtoul(req.c_str() + clPos + 15, nullptr, 10);
          if (want > (size_t)4 << 20) want = (size_t)4 << 20;      // 4MB 上限，别被撑爆
          if (reqBody.size() < want) {
            reqBody.reserve(want);
            while (reqBody.size() < want) {
              int n = recv(cs, buf, sizeof(buf) - 1, 0);
              if (n <= 0) break;
              reqBody.append(buf, n);
            }
          }
          if (reqBody.size() > want && clPos != std::string::npos) reqBody.resize(want);
        }
      }

      std::vector<uint8_t> body;
      const char* mime = "application/octet-stream";
      int status = 200; const char* statusText = "OK";
      std::string extra;

      if (!path.empty() && path[0] == '/') {
        if (path.rfind("/engine/", 0) == 0) {
          // ---- 原生 Rapfi 引擎桥（仅纯训练器版带 rapfi-native/ 时可用）----
          auto qget = [&](const char* key) -> std::string {
            std::string k = std::string(key) + "=";
            size_t p = query.find(k);
            if (p == std::string::npos) return "";
            size_t e2 = query.find('&', p);
            return query.substr(p + k.size(), e2 == std::string::npos ? std::string::npos : e2 - (p + k.size()));
          };
          std::string route = path.substr(8);
          std::string lane  = qget("lane");
          int idx = lane.empty() ? 0 : nativeeng::LaneIndex(lane);
          std::string payload;
          if (route == "status") {
            nativeeng::Probe();
            MEMORYSTATUSEX ms = {}; ms.dwLength = sizeof(ms);
            GlobalMemoryStatusEx(&ms);
            payload = std::string("{\"available\":") + (nativeeng::g_avail ? "true" : "false") +
                      ",\"variant\":" + JsonQuote(nativeeng::g_variant) +
                      ",\"cpus\":" + std::to_string((int)std::thread::hardware_concurrency()) +
                      ",\"memMB\":" + std::to_string((long long)(ms.ullTotalPhys / (1024 * 1024))) +
                      ",\"lanes\":[\"main\",\"sub\",\"fwd\"]}";
          } else if (idx < 0) {
            payload = "{\"error\":\"bad lane\"}";
          } else if (route == "cmd") {
            // ★ 原子「确保活着 + 写命令」：并发请求不会各起一个进程，命令也不会打进旧进程。
            std::string text = reqBody;
            bool ok = nativeeng::WriteEnsured(idx, text);
            payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
          } else if (route == "ensure") {
            // ★ 页面的自动恢复走这条：**已活着就不重启**。老页面若还调 reset 也仍然安全（有锁）。
            bool ok = nativeeng::Ensure(idx);
            payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
          } else if (route == "reset") {
            bool ok = nativeeng::Spawn(idx);
            payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
          } else if (route == "out") {
            uint64_t since = (uint64_t)strtoull(qget("since").c_str(), nullptr, 10);
            payload = nativeeng::Poll(idx, since);
          } else {
            payload = "{\"error\":\"unknown engine route\"}";
          }
          mime = "application/json; charset=utf-8";
          extra = "Cache-Control: no-store\r\n";
          body.assign(payload.begin(), payload.end());
        } else if (path.rfind("/ai/", 0) == 0) {
          std::string name = path.substr(4);
          bool nameOk = !name.empty() && name.find("..") == std::string::npos &&
                        name.find('/') == std::string::npos && name.find('\\') == std::string::npos;
          if (nameOk) {
            std::ifstream ff(Join(Join(ExeDir(), L"resources"), Utf8ToWide(name)), std::ios::binary);
            if (ff) {
              body.assign((std::istreambuf_iterator<char>(ff)), std::istreambuf_iterator<char>());
              mime = UiHttpMime(name);
              extra = "Cache-Control: max-age=86400\r\n";
            }
          }
        } else {
          std::string name = path.substr(1);
          bool nameOk = !name.empty() && name.find("..") == std::string::npos &&
                        name.find('/') == std::string::npos && name.find('\\') == std::string::npos &&
                        name.find('.') != std::string::npos;
          if (nameOk) {
            std::wstring enc = Join(Join(ExeDir(), L"calc"), Utf8ToWide(name) + L".enc");
            if (FileExists(enc) && gbCalcReadEncFile(enc, body)) {
              // 发布版：内存解密，磁盘无明文
            } else {
            std::ifstream f(Join(Join(ExeDir(), L"calc"), Utf8ToWide(name)), std::ios::binary);
            if (f) body.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
          }
          // ★ UI 一律 no-store（2026-09-27 升级，原 no-cache）：实测 WebView2 对 heuristically
          //   fresh 的旧条目连重验证都不发（用户升级后重开仍见旧界面）。本地文件很便宜，
          //   **根本别存**；配合导航 URL 的 ?v=<exe指纹>（MainNavUrl）双保险。
          extra = "Cache-Control: no-store\r\n";
          mime = UiHttpMime(name);
          }
        }
      }
      if (body.empty()) { status = 404; statusText = "Not Found"; mime = "text/plain"; }
      char head[512];
      snprintf(head, sizeof(head),
               "HTTP/1.1 %d %s\r\nContent-Type: %s\r\n%s"
               "Cross-Origin-Opener-Policy: same-origin\r\n"
               "Cross-Origin-Embedder-Policy: require-corp\r\n"
               "Content-Length: %zu\r\nConnection: close\r\n\r\n",
               status, statusText, mime, extra.c_str(), body.size());
      LogMsg("[ui-http] req " + method + " " + path + (query.empty() ? "" : ("?" + query)));
      std::string h = head;
      SendAll(cs, h.c_str(), (int)h.size());
      if (!body.empty()) SendAll(cs, (const char*)body.data(), (int)body.size());
      closesocket(cs);
    }).detach();
  }
  closesocket(ls);
  WSACleanup();
}

/** 落盘 inbox：桌面覆盖层「复盘」写 %TEMP%\gb-calc-inbox.json，本进程轮询拾取。 */
static void InboxFileWatcher() {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  std::wstring path = Join(std::wstring(tmp), L"gb-calc-inbox.json");
  while (g_running.load()) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      LARGE_INTEGER sz;
      if (GetFileSizeEx(h, &sz) && sz.QuadPart > 0 && sz.QuadPart < (1 << 20)) {
        std::string data((size_t)sz.QuadPart, '\0');
        DWORD rd = 0;
        ReadFile(h, &data[0], (DWORD)sz.QuadPart, &rd, nullptr);
        data.resize(rd);
        if (!data.empty() && data != g_inboxSeen) {
          g_inboxSeen = data;
          std::string msg = "{\"type\":\"historyInbox\",\"text\":";
          msg += JsonQuote(data);
          msg += "}";
          PostToPage(msg);
          LogMsg("[inbox] file inbox picked up " + std::to_string(data.size()) + " bytes");
        }
      }
      CloseHandle(h);
    }
    Sleep(1200);
  }
}

// ---------------------------------------------------------------- WebView2 回调

template <class T> class Cb : public T {
 public:
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** pp) override {
    if (pp) *pp = nullptr;
    return E_NOINTERFACE;
  }
};

// ---------------------------------------------------------------- calc/ UI 的加密供给
// ★ 2026-09-19（用户要求）：「发布包里面的 ui 部分要加密」。
//   发布版 calc/ 里只有 <file>.enc（构建期由 tools/encrypt-calc-ui.js 生成），这里用
//   ui_crypto.h 的 gbCalcReadEncFile 在**内存里**解密，再把明文字节当响应体交给 WebView2
//   —— 磁盘上全程没有明文，解包也拿不到页面源码。
//   开发版没有 .enc → 同一个拦截器回退读明文（2026-09-19 起开发/发布统一走拦截器：
//   虚拟目录映射会屏蔽 WebResourceRequested，且映射路径无法附加 COOP/COEP 头，SAB 起不来）。
static std::wstring UiDir() { return Join(ExeDir(), L"calc"); }

/** https://gbcalc.test/calc.html?rv=1 → calc.html（丢掉查询串；复盘窗带 ?rv=1）。 */
static std::wstring UiPathFromUri(const std::wstring& uri) {
  const std::wstring prefix = L"https://gbcalc.test/";
  size_t p = uri.find(prefix);
  std::wstring rest = (p == std::wstring::npos) ? uri : uri.substr(p + prefix.size());
  size_t q = rest.find_first_of(L"?#");
  if (q != std::wstring::npos) rest = rest.substr(0, q);
  while (!rest.empty() && rest[0] == L'/') rest.erase(0, 1);
  if (rest.empty()) rest = L"calc.html";
  if (rest.find(L"..") != std::wstring::npos) rest = L"__deny__";   // 挡住 ../ 穿越
  return rest;
}
static const wchar_t* UiMimeFor(const std::wstring& p) {
  if (p.size() >= 5 && p.compare(p.size() - 5, 5, L".html") == 0) return L"text/html; charset=utf-8";
  if (p.size() >= 3 && p.compare(p.size() - 3, 3, L".js") == 0) return L"text/javascript; charset=utf-8";
  if (p.size() >= 4 && p.compare(p.size() - 4, 4, L".css") == 0) return L"text/css; charset=utf-8";
  if (p.size() >= 4 && p.compare(p.size() - 4, 4, L".png") == 0) return L"image/png";
  if (p.size() >= 4 && p.compare(p.size() - 4, 4, L".ico") == 0) return L"image/x-icon";
  return L"application/octet-stream";
}

/** 拦截器应答助手：用内存块构造响应并挂到 args 上。
 *  ★ 填了响应即视为已处理 —— 本 SDK 的 args **没有** put_Handled。
 *  ★ headers 参数只给**单个裸 mime 值**（overlay 同款、生产可用格式）—— 实测
 *    "Name: value\r\nName: value" 多行串会让导航挂起（资源 200 但 NavigationCompleted
 *    永不触发、JS 不执行；2026-09-19 与 09-28 两次复现，overlay 单值格式从未挂过）。
 *    额外响应头走 get_Headers → AppendHeader 逐条追加，不进那个字符串。
 *  ★ 注意**没有** COOP/COEP 隔离头：页面早已不依赖 SAB（独立版构建期剥掉 WASM = GB_NO_WASM；
 *  三件套版 UI 走 GB_AI_REMOTE fetch :8964，engine-server 自带 CORS）。 */
static void RespondMem(ICoreWebView2WebResourceRequestedEventArgs* args, int status,
                       const wchar_t* reason, const std::wstring& mime,
                       const wchar_t* extraName, const wchar_t* extraValue,
                       const std::vector<uint8_t>& body) {
  if (!g_env || !args) return;
  IStream* st = body.empty() ? SHCreateMemStream((const BYTE*)"", 0)
                             : SHCreateMemStream(body.data(), (UINT)body.size());
  if (!st) { LogMsg("[res] SHCreateMemStream failed"); return; }
  ICoreWebView2WebResourceResponse* resp = nullptr;
  HRESULT hr = g_env->CreateWebResourceResponse(st, status, reason, mime.c_str(), &resp);
  if (SUCCEEDED(hr) && resp) {
#if 0   // ★ 对照实验（2026-09-28）：AppendHeader 追加头先全部关掉，验证是否是它导致
        //   导航挂起（overlay 生产实现零附加头；404 空体 + AppendHeader 可提交，
        //   但真实文档仍挂 —— 逐变量排查）。
    if (extraName && *extraName) {
      ICoreWebView2HttpResponseHeaders* hs = nullptr;
      if (SUCCEEDED(resp->get_Headers(&hs)) && hs) {
        hs->AppendHeader(extraName, extraValue);
        hs->Release();
      }
    }
#endif
    HRESULT pr = args->put_Response(resp);
    if (FAILED(pr)) { char rb[128]; snprintf(rb, sizeof(rb), "[res] put_Response hr=0x%08lX", (unsigned long)pr); LogMsg(rb); }
    resp->Release();
  } else {
    char rb[128]; snprintf(rb, sizeof(rb), "[res] CreateWebResourceResponse hr=0x%08lX", (unsigned long)hr); LogMsg(rb);
  }
  st->Release();
}
static std::wstring AiMimeFor(const std::wstring& p) {
  if (p.size() >= 5 && p.compare(p.size() - 5, 5, L".wasm") == 0) return L"application/wasm";
  if (p.size() >= 3 && p.compare(p.size() - 3, 3, L".js") == 0) return L"text/javascript; charset=utf-8";
  return L"application/octet-stream";
}

/** gbcalc.* 进程内资源拦截器 —— **已否决、未注册（休眠代码）**。
 *  2026-09-28 实测结论（与 2026-09-19 的观察互相印证）：小页面能走通，但真实 calc 页
 *  必现「响应已创建、页面脚本已执行、页面内 DCL 已触发，宿主侧 DCL/NavigationCompleted
 *  永不到达、消息通道停摆、最终整壳静默退出」；overlay 壳载同一页面直接
 *  errStatus=9（ERROR_HTTP_INVALID_SERVER_RESPONSE）。对照实验覆盖了：隔离头有无、
 *  单值/多行响应头、AppendHeader、.local/.test 域名、明文/密文、文档大小 —— 均无关。
 *  保留本类：① 路由与解密逻辑的可读参考；② 若未来 WebView2 修复，按
 *  SetupUiServing 旧注释两行即可重新挂上。当前供给 = HttpUiServer（动态端口）。 */
class ResHandler : public Cb<ICoreWebView2WebResourceRequestedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) override {
    if (!args) return S_OK;
    ICoreWebView2WebResourceRequest* req = nullptr;
    if (FAILED(args->get_Request(&req)) || !req) return S_OK;
    LPWSTR uriW = nullptr;
    req->get_Uri(&uriW);
    std::wstring uri = uriW ? uriW : L"";
    if (uriW) CoTaskMemFree(uriW);
    if (uri.find(L"gbcalc.test") == std::wstring::npos) { req->Release(); return S_OK; }  // 非本源不接
    LogMsg("[res] enter " + WideToUtf8(uri).substr(0, 100));   // ★ 排查：卡住的请求入口

    // POST 体（/engine/cmd 的命令行，YXBOARD 整条 ~1.5KB；4MB 封顶）
    std::string reqBody;
    {
      IStream* cs = nullptr;
      if (SUCCEEDED(req->get_Content(&cs)) && cs) {
        char cb[8192]; ULONG rd = 0;
        for (;;) {
          if (FAILED(cs->Read(cb, sizeof(cb), &rd)) || rd == 0) break;
          reqBody.append(cb, rd);
          if (reqBody.size() > ((size_t)4 << 20)) break;
        }
        cs->Release();
      }
    }
    req->Release();

    std::wstring path = UiPathFromUri(uri);
    std::string query;
    {
      size_t q = uri.find(L'?');
      if (q != std::wstring::npos) {
        std::wstring qw = uri.substr(q + 1);
        size_t h = qw.find(L'#');
        if (h != std::wstring::npos) qw = qw.substr(0, h);
        query = WideToUtf8(qw);
      }
    }

    // ---- /engine/*：原生 Rapfi 引擎桥（与 HttpUiServer 共用同一路由实现）----
    if (path.rfind(L"engine/", 0) == 0) {
      std::string route = WideToUtf8(path.substr(7));
      std::string payload = NativeEngineRouteJson(route, query, reqBody);
      RespondMem(args, 200, L"OK", L"application/json; charset=utf-8", L"Cache-Control", L"no-store",
                 std::vector<uint8_t>(payload.begin(), payload.end()));
      if (route != "out") LogMsg("[res] engine/" + route + " -> " + payload.substr(0, 80));
      return S_OK;
    }

    // ---- /ai/*：rapfi wasm/js/data（三件套资源；独立版 404 无害）。
    //      只放 basename，挡 ../ 穿越；40MB 模型带长缓存（WebView2 磁盘缓存）。 ----
    if (path.rfind(L"ai/", 0) == 0) {
      std::wstring name = path.substr(3);
      bool nameOk = !name.empty() && name.find(L"..") == std::wstring::npos &&
                    name.find(L'/') == std::wstring::npos && name.find(L'\\') == std::wstring::npos;
      std::vector<uint8_t> ai;
      if (nameOk) {
        std::wstring f = Join(Join(ExeDir(), L"resources"), name);
        if (FileExists(f)) {
          std::ifstream ff(f, std::ios::binary);
          if (ff) ai.assign((std::istreambuf_iterator<char>(ff)), std::istreambuf_iterator<char>());
        }
      }
      if (!ai.empty()) RespondMem(args, 200, L"OK", AiMimeFor(name), L"Cache-Control", L"max-age=86400", ai);
      else             RespondMem(args, 404, L"Not Found", L"text/plain", L"Cache-Control", L"no-store", {});
      return S_OK;
    }
    // ---- UI 静态文件：.enc 内存解密优先，无 .enc 回退明文（开发版）----
    std::vector<uint8_t> content;
    bool ok = false;
    const char* how = "none";
    std::wstring enc = Join(UiDir(), path + L".enc");
    if (FileExists(enc) && gbCalcReadEncFile(enc, content)) { ok = true; how = "enc"; }
    else if (FileExists(enc)) { how = "enc-decrypt-FAILED"; }
    if (!ok) {
      std::wstring plain = Join(UiDir(), path);
      if (FileExists(plain)) {
        std::ifstream f(plain, std::ios::binary);
        if (f) { content.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()); ok = true; how = "plain"; }
      }
    }
    if (!ok || content.empty()) {
      // 未命中：明确回 404，不能悬着（拦截器模式下悬着 = 导航挂起）。
      LogMsg("[res] MISS " + WideToUtf8(path) + " (404)");
      RespondMem(args, 404, L"Not Found", L"text/plain", L"Cache-Control", L"no-store", {});
      return S_OK;
    }
    { char rb[512];
      snprintf(rb, sizeof(rb), "[res] serve %ls how=%s bytes=%zu", path.c_str(), how, content.size());
      LogMsg(rb); }
    // ★ UI 一律 no-store（2026-09-27，原 no-cache）：升级后旧 calc.js 可能还躺在 WebView2 缓存里
    //   （识图页实测中招）。配合导航 URL 的 ?v=<exe指纹>（MainNavUrl）双保险。
    RespondMem(args, 200, L"OK", UiMimeFor(path), L"Cache-Control", L"no-store", content);
    return S_OK;
  }
};

static ResHandler g_resHandler;   // 单例：Cb 引用计数恒 1，主/复盘/识图窗共用，进程生命周期内复用

static void LayoutWebView() {
  if (!g_controller || !g_hwnd) return;
  RECT r;
  GetClientRect(g_hwnd, &r);
  g_controller->put_Bounds(r);
}

/** 诊断钩子（GB_TEST_DIAG=1）：把 ExecuteScript 的回值打进日志 —— 排查「页面 ready 断链」用。 */
class EvalHandler : public Cb<ICoreWebView2ExecuteScriptCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, LPCWSTR result) override {
    if (result && *result) LogMsg("[eval] " + WideToUtf8(result));
    else LogMsg("[eval] (empty result)");
    return S_OK;
  }
};

/** 页面 → 宿主。目前只有两类消息：引擎档位（改完要重启引擎）、页面就绪。 */
class MsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* e) override {
    LPWSTR raw = nullptr;
    if (FAILED(e->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
     std::string s = WideToUtf8(raw);
     CoTaskMemFree(raw);
     LogMsg("[msg] " + s.substr(0, 200));
    // ★★ 2026-09-25 新引擎后端：页面（经主线程转发 Worker 的请求）直接用 WebView 消息
    //   驱动原生引擎 —— 不再绕 :8965 的 HTTP，也不再让页面 15ms 轮询取输出。
    //   形状：{"type":"engine","op":"cmd|ensure|reset|status","lane":"main","cmds":[...],"id":n}
    if (s.find("\"engine\"") != std::string::npos && s.find("\"op\":") != std::string::npos) {
      g_pushEngineOut = true;                       // 以后引擎输出直接推给页面
      std::string op   = JsonStrAfter(s, "\"op\":");
      std::string lane = JsonStrAfter(s, "\"lane\":");
      int id = atoi(s.c_str() + (s.find("\"id\":") == std::string::npos
                                   ? 0 : s.find("\"id\":") + 5));
      auto cmds = JsonStrArray(s, "\"cmds\":");
      int idx = nativeeng::LaneIndex(lane);
      PostToPageSoon(nativeeng::HandlePageCmd(op, idx, cmds, id));
      return S_OK;
    }
     if (s.find("\"engineConfig\"") != std::string::npos) {
      auto num = [&](const char* k) -> int {
        size_t p = s.find(k);
        if (p == std::string::npos) return 0;
        return atoi(s.c_str() + p + strlen(k));
      };
      int t = num("\"threads\":");
      int h = num("\"hashMB\":");
      g_threads = t; g_hashMB = h;
      // ★ 页面内 AI：档位由页面 Worker 自己消化（改线程数 = 页面重建 Worker；改哈希 =
      //   引擎热收 INFO HASH_SIZE），宿主无进程可重启，只记录。
      LogMsg("[ai] engineConfig threads=" + std::to_string(t) + " hashMB=" + std::to_string(h) + " (in-page)");
      return S_OK;
    }
    if (s.find("\"ready\"") != std::string::npos) {
      if (!g_pending.empty()) {
        std::string p = g_pending; g_pending.clear();
        PostToPage(p);
      }
      // ★ 主窗口页面就绪后再等 2.5s 才预热复盘窗：主窗口刚起来那会儿 WebView2 还在最脆弱的
      //   阶段（首帧偶发 LAUNCH_FAILED），这时候去抢第二个控制器纯属添乱；等它稳了再备，
      //   用户点「复盘」照样是秒开。
      // ★ 2026-09-19：页面报到 = 首帧可以画了 → 撤掉启动遮罩、放出 WebView2 控制器；
      //   同时把「主题|底色|语言」记下来，下次进程启动的遮罩直接用它（首帧不闪白/黑）。
      SaveUiPrefs(s);
      g_uiDark = (JsonStrAfterDecoded(s, JKey("theme").c_str()) != "light");
      ApplyDarkTitleBar(g_hwnd, g_uiDark);
      RevealMainPage();
      KillTimer(g_hwnd, kMainTimerReload);
      LogBoot("PAGE READY");
      LogMsg("[ui] main page ready - splash removed");
      // DOMContentLoaded 没来（某些运行时）时靠这一条兜住；延后一拍 —— 此刻正处在
      // WebMessageReceived 回调里，同步发会被 WebView2 丢掉。
      SetTimer(g_hwnd, kMainTimerHook, 50, nullptr);
      // ★ 用户要求「不要固定时间，越快打开并加载越好」→ 主窗口页面一报到就**立刻**备好复盘窗
      //   （原来写死 2.5s / 0.9s，那是我拍脑袋的安全余量，实际拖慢了第一次点「复盘」的速度）。
      //   复盘资源备好只是「后台有个藏着的窗口」，不影响主窗口任何交互。
      PrewarmReviewWindow();
      return S_OK;
    }
    // ★ 2026-09-19（用户要求）：「复盘这个独立窗口也应该适配深浅色主题」。
    //   任一窗口切深/浅 → 页面把新主题报上来 → ① 记进 ui 文件（下次启动的遮罩色）
    //   ② 两个窗口的系统标题栏一起变 ③ 转发给复盘窗页面（它自己换 CSS 变量）。
    if (s.find("uiTheme") != std::string::npos) {
      std::string th = JsonStrAfterDecoded(s, JKey("theme").c_str());
      if (th != "light" && th != "dark") th = "dark";
      SaveUiPrefs(s);
      g_uiDark = (th != "light");
      ApplyDarkTitleBar(g_hwnd, g_uiDark);
      ApplyDarkTitleBar(g_rvHwnd, g_uiDark);
      ApplyDarkTitleBar(g_visHwnd, g_uiDark);
      PostToRvPageSoon(std::string("{") + JKey("type") + JsonQuote(std::string("uiTheme")) + "," +
                       JKey("theme") + JsonQuote(th) + "}");
      PostToVisPageSoon(std::string("{") + JKey("type") + JsonQuote(std::string("uiTheme")) + "," +
                        JKey("theme") + JsonQuote(th) + "}");
      LogMsg("[ui] theme switched to " + th + " (all windows)");
      return S_OK;
    }
    // 页面发现引擎没应答时喊一声，宿主立刻补拉（看门狗之外的第二条路，响应更快）
    if (s.find("\"ensureEngine\"") != std::string::npos) {
      // ★ 页面内 AI 后宿主没有引擎进程可拉；消息保留兼容旧页面，仅记录（页面自己重试 Worker）。
      LogMsg("[ai] ensureEngine requested (no host engine anymore, ignored)");
      return S_OK;
    }
    // 剪贴板：粘贴 = 宿主读系统剪贴板 → 回推 {"type":"clip","text":...}（页面收到即载入局面）
    if (s.find("\"paste\"") != std::string::npos) {
      std::wstring txt = ReadClipboardText();
      LogMsg("[clip] paste -> " + std::to_string(txt.size()) + " chars");
      PostToPageSoon("{\"type\":\"clip\",\"text\":" + JsonQuote(WideToUtf8(txt)) + "}");
      return S_OK;
    }
    // 复制 = 页面把要复制的文本送上来，宿主写进系统剪贴板（页面侧 execCommand 失败时的兜底）
    if (s.find("\"copy\"") != std::string::npos) {
      std::string t = JsonStrAfter(s, "\"text\":");
      if (!t.empty()) WriteClipboardText(Utf8ToWide(t));
      LogMsg("[clip] copy -> " + std::to_string(t.size()) + " chars");
      return S_OK;
    }
    // ★ 复盘 = **另开一个窗口**（用户要求）。页面只把「要复盘的那一局」递上来，
    //   窗口的创建/复用全在 OpenReviewWindow 里，主窗口这边一点都不动。
    if (s.find("\"openReview\"") != std::string::npos) {
      OpenReviewWindow(JsonSubObject(s, "\"record\""));
      return S_OK;
    }
    // ★ 识图 = **另开一个识图窗口**（2026-09-21，用户要求：顶栏「识图」在「复盘」左边）。
    if (s.find("\"openVis\"") != std::string::npos) {
      OpenVisWindow();
      return S_OK;
    }
    // ★ 保存局面 = 弹系统「另存为」对话框由用户挑路径（用户要求：不要默认保存）
    if (s.find("\"savePng\"") != std::string::npos) {
      SavePngFromPage(s, g_hwnd);
      return S_OK;
    }
    // ★ 导出历史 = 同一个「另存为」套路，只是落盘成 txt（用户要求：历史能导出成 txt）
    if (s.find("\"saveTxt\"") != std::string::npos) {
      TxtSaveResult r = SaveTxtFromPage(s, g_hwnd);
      if (r.ok) {
        PostToPage("{\"type\":\"histExported\",\"n\":" + std::to_string(r.n) + "}");
        // 测试闭环：写盘成功后紧接着让页面把它读回来（导出 → 文件 → 导入）
        if (TestFlag("GB_TEST_HIST_ROUNDTRIP")) PostToPage("{\"type\":\"testHistNowImport\"}");
      }
      return S_OK;
    }
    // ★ 导入历史 = 弹系统「打开」对话框读 txt，再整段推给页面解析入库
    if (s.find("\"openTxt\"") != std::string::npos) {
      std::string m = ReadTxtMessage(g_hwnd);
      if (!m.empty()) PostToPage(m);
      return S_OK;
    }
    // 页面回执：这一批真的入库了几局（端到端测试的判据；正式运行只是日志）
    if (s.find("\"histImported\"") != std::string::npos) {
      LogMsg("[hist] imported n=" + std::to_string(JsonIntAfter(s, "\"n\":")) +
             " fp=" + JsonStrAfter(s, "\"fp\":"));
      return S_OK;
    }
    return S_OK;
  }
};

/** 剪贴板读取权限：WebView2 默认会把 clipboard-read 拒掉 → 页面 navigator.clipboard 失效。
 *  这里显式放行，让页面的粘贴在「宿主通道」之外还有一条原生通路。 */
class PermHandler : public Cb<ICoreWebView2PermissionRequestedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*,
                                   ICoreWebView2PermissionRequestedEventArgs* e) override {
    COREWEBVIEW2_PERMISSION_KIND k = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
    if (SUCCEEDED(e->get_PermissionKind(&k)) && k == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ) {
      e->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
    }
    return S_OK;
  }
};

class DomHandler : public Cb<ICoreWebView2DOMContentLoadedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2DOMContentLoadedEventArgs*) override {
    // 把本机能力告诉页面：核心数上限（总核−1/2/4）与默认（半核）；外加**物理内存总量**
    // 与**有没有原生引擎** —— 页面靠这两个决定哈希下拉能开到多大（6GB 档要 >=8GB 内存才可选）。
    char b[192];
    snprintf(b, sizeof(b),
             "{\"type\":\"host\",\"cpu\":%d,\"threadsDefault\":%d,\"threadsMax\":%d,"
             "\"memMB\":%d,\"native\":%s}",
             CpuCount(), ThreadsDefault(), ThreadsMax(), MemTotalMB(),
             nativeeng::Available() ? "true" : "false");
    PostToPage(b);
    LogBoot("dom content loaded");
    FireTestHooks();
    return S_OK;
  }
};

// ---------------------------------------------------------------- 测试钩子（GB_TEST_*=1）
// ★ 2026-09-19：这些钩子原来只挂在 **DOMContentLoaded** 上。实测在部分 WebView2 运行时上
//   add_DOMContentLoaded 的回调**根本不触发**（页面照常跑、ready 也照常报），钩子就全哑了，
//   端到端测试一片假红却看不出原因。
//   ⇒ 改成「DOMContentLoaded 或 页面报到（ready）—— 谁先到谁发」，并用 g_testHooksFired
//     保证**只发一次**。页面报到这个时点其实更稳：那时页面的消息监听一定已经挂好了。
static bool g_testHooksFired = false;
static void FireTestHooks() {
  if (g_testHooksFired) return;
  g_testHooksFired = true;
  // · GB_TEST_OPEN_REVIEW=1 → 让**页面**自己走一遍「点复盘 → 开窗口 → 投递局面」的链路；
  //   ＋GB_TEST_OPEN_REVIEW_DELAY_MS=<毫秒> → 把这一步推迟到那时才做，
  //   专门用来复现**用户的真实路径**：先预热好藏着，过一会儿用户才点「复盘」。
  // · GB_TEST_SAVE_POS=1    → 让页面调一次 savePos()，配合 GB_TEST_SAVE_PNG=<路径>
  //                           （不弹对话框，直接写那个路径）端到端验证「保存局面」。
  char tv[8] = {0};
  if (GetEnvironmentVariableA("GB_TEST_OPEN_REVIEW", tv, sizeof(tv)) && tv[0] == '1') {
    char dv[16] = {0};
    UINT delayMs = 0;
    if (GetEnvironmentVariableA("GB_TEST_OPEN_REVIEW_DELAY_MS", dv, sizeof(dv))) {
      delayMs = (UINT)atoi(dv);
    }
    if (delayMs && g_hwnd && IsWindow(g_hwnd)) {
      SetTimer(g_hwnd, kRvTimerTestOpen, delayMs, nullptr);
      LogMsg("[rv] test hook: opening a review window in " + std::to_string(delayMs) + " ms");
    } else {
      PostToPage("{\"type\":\"testOpenReview\"}");
      LogMsg("[rv] test hook: asked the page to open a review window");
    }
  }
  memset(tv, 0, sizeof(tv));
  if (GetEnvironmentVariableA("GB_TEST_SAVE_POS", tv, sizeof(tv)) && tv[0] == '1') {
    PostToPage("{\"type\":\"testSavePos\"}");
    LogMsg("[save] test hook: asked the page to save the position");
  }
  // 历史 txt 闭环（tools/test-trainer-history.js 的 C 段）：
  //   GB_TEST_HIST_ROUNDTRIP=1 + GB_TEST_SAVE_TXT=<tmp> + GB_TEST_OPEN_TXT=<同一个 tmp>
  //   → 页面塞两条历史并导出（宿主写盘）→ 宿主回 testHistNowImport → 页面读回来导入。
  memset(tv, 0, sizeof(tv));
  if (GetEnvironmentVariableA("GB_TEST_HIST_ROUNDTRIP", tv, sizeof(tv)) && tv[0] == '1') {
    PostToPage("{\"type\":\"testHistRoundtrip\"}");
    LogMsg("[hist] test hook: asked the page to export the history as txt");
  }
  // ★ 2026-09-25：「AI 执黑 + AI 执白 都选中 → 自动对弈，正中那颗键可停可续」的端到端自检。
  //   页面会真点击两个开关与正中键，并把每一步的手数/暂停态/图标回报进本文件的主日志。
  memset(tv, 0, sizeof(tv));
  if (GetEnvironmentVariableA("GB_TEST_AI_BOTH", tv, sizeof(tv)) && tv[0] == '1') {
    PostToPage("{\"type\":\"testAiBoth\"}");
    LogMsg("[ai] test hook: asked the page to run the AI-vs-AI self-play walkthrough");
  }
}

/** UI 资源指纹 = exe 本体的最后写入时间（64 位 FILETIME 十进制）。
 *  ★ 2026-09-27：WebView2 磁盘缓存实测会把旧 calc.html/css 条目当成 heuristically-fresh
 *  直接回放（连重验证都不发）——用户重开训练器仍见上一版界面。给导航 URL 挂上指纹后，
 *  **每换一版 exe，calc.html?v=… 就是全新 URL**，任何陈旧条目永远命不中；配合
 *  HttpUiServer 对 UI 文件一律 no-store，双保险。 */
static unsigned long long UiStamp() {
  static unsigned long long stamp = 0;
  if (!stamp) {
    wchar_t exe[MAX_PATH] = { 0 };
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    WIN32_FILE_ATTRIBUTE_DATA fa = {};
    if (GetFileAttributesExW(exe, GetFileExInfoStandard, &fa))
      stamp = ((unsigned long long)fa.ftLastWriteTime.dwHighDateTime << 32) |
              (unsigned long long)fa.ftLastWriteTime.dwLowDateTime;
    if (!stamp) stamp = 1;
  }
  return stamp;
}

static std::wstring MainNavUrl(const wchar_t* def) {
  char nu[300] = { 0 };
  if (GetEnvironmentVariableA("GB_NAV_URL", nu, sizeof(nu)) && nu[0]) return Utf8ToWide(nu);
  std::wstring url(def);
  url += (url.find(L'?') == std::wstring::npos) ? L'?' : L'&';
  url += L"v=" + std::to_wstring(UiStamp());
  return url;
}
/** 导航完成（页面 DOM/子资源都到位）→ 埋点。用它把「加载页面」和「页面 JS 自举」分开计时。 */
class NavHandler : public Cb<ICoreWebView2NavigationCompletedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*,
                                   ICoreWebView2NavigationCompletedEventArgs* e) override {
    BOOL ok = FALSE;
    if (e) e->get_IsSuccess(&ok);
    if (ok) {
      LogBoot("navigation completed");
    } else {
      COREWEBVIEW2_WEB_ERROR_STATUS es = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
      if (e) e->get_WebErrorStatus(&es);
      LogMsg("[boot] navigation FAILED err=" + std::to_string((int)es));
    }
    return S_OK;
  }
};

/** 渲染进程崩溃自愈：渲染器随机退出（本会话实测 Crashpad 多份 8MB 转储）会让页面
 *  永远停在「加载中」—— WebView2 不会自己重试。这里监听 ProcessFailed，渲染器
 *  一挂就重导航一次（WebView2 会自动重启渲染进程）。复盘窗/主窗各自注册各自恢复。 */
class ProcFailHandler : public Cb<ICoreWebView2ProcessFailedEventHandler> {
 public:
  explicit ProcFailHandler(std::wstring url) : url_(std::move(url)) {}
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2ProcessFailedEventArgs* e) override {
    COREWEBVIEW2_PROCESS_FAILED_KIND k = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    if (e) e->get_ProcessFailedKind(&k);
    if (k == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE ||
        k == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) {
      LogMsg("[wv2] render process died (kind=" + std::to_string((int)k) + ") - re-navigating");
      if (sender) sender->Navigate(url_.c_str());
    }
    return S_OK;
  }
 private:
  std::wstring url_;
};

/** 页面导航基准 —— **唯一事实来源**：HttpUiServer 动态绑定端口后的实际端口
 *  （见 g_uiPort 注释）。tag: nullptr=主窗, "rv"=复盘窗, "vis"=识图窗。 */
static std::wstring UiBaseUrl(const char* tag) {
  int port = g_uiPort.load();
  for (int i = 0; port == 0 && i < 200; ++i) {   // 等 ui-http 线程完成绑定（微秒级，防呆上限 2s）
    Sleep(10);
    port = g_uiPort.load();
  }
  wchar_t base[64] = { 0 };
  swprintf(base, 64, L"http://127.0.0.1:%d/calc.html", port > 0 ? port : 8965);
  std::wstring url = base;
  if (tag && std::string(tag) == "rv")  url += L"?rv=1";
  if (tag && std::string(tag) == "vis") url += L"?vis=1";
  return url;
}

/** UI 供给注册：渲染崩溃自愈 + 导航基准日志。主/复盘/识图窗各调一次。
 *  ★ 2026-09-28 定论：**不要**改回 gbcalc.* 进程内拦截 —— 本日投入两小时实测：
 *    小页面能走通，但真实 calc 页（enc/明文皆然）必现「响应已创建、页面脚本已执行、
 *    页面内 DCL 已触发，而宿主侧 DCL/NavigationCompleted 永不到达、消息通道停摆」，
 *    overlay 壳载同一页面则直接 errStatus=9（ERROR_HTTP_INVALID_SERVER_RESPONSE）——
 *    与 2026-09-19 的「导航挂起」观察完全一致，是 WebView2 拦截器对这种大文档的深层
 *    缺陷，跟隔离头/响应头格式/域名 TLD 均无关（全部对照实验过）。真 HTTP 是唯一
 *    稳定通道；端口冲突问题已由 bind(port 0) 根治，无需再绕开 TCP。 */
static void SetupUiServing(ICoreWebView2* wv, const char* tag) {
  std::wstring base = UiBaseUrl(tag);
  EventRegistrationToken ptok = {};
  wv->add_ProcessFailed(new ProcFailHandler(base), &ptok);
  char bb[160];
  snprintf(bb, sizeof(bb), "[%s] UI via local http://127.0.0.1:%d/ (COOP/COEP + crash heal)",
           tag ? tag : "wv2", g_uiPort.load());
  LogMsg(bb);
}

class CtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
    if (FAILED(hr) || !ctl) { LogMsg("[wv2] controller creation failed"); return S_OK; }
    g_controller = ctl;
    ctl->AddRef();
    ctl->get_CoreWebView2(&g_webview);
    if (g_webview) {
      g_webview->AddRef();
      ICoreWebView2Settings* st = nullptr;
      if (SUCCEEDED(g_webview->get_Settings(&st)) && st) {
        st->put_IsStatusBarEnabled(FALSE);
        st->put_AreDefaultContextMenusEnabled(FALSE);
        // ★ 关掉页面缩放（用户要求：不能 Ctrl+滚轮随意缩放，界面比例要固定）。
        //   Settings 上没有 zoom 开关，得走 ICoreWebView2Settings3::put_IsZoomControlEnabled。
        ICoreWebView2Settings3* st3 = nullptr;
        if (SUCCEEDED(st->QueryInterface(__uuidof(ICoreWebView2Settings3), (void**)&st3)) && st3) {
          st3->put_IsZoomControlEnabled(FALSE);
          st3->Release();
        }
        st->Release();
      }
      // 页面侧再兜一层（calc.js 里 preventDefault Ctrl+滚轮），两处都要有
      ICoreWebView2_2* wv2 = nullptr;
      if (SUCCEEDED(g_webview->QueryInterface(__uuidof(ICoreWebView2_2), (void**)&wv2)) && wv2) {
        EventRegistrationToken t = {};
        wv2->add_DOMContentLoaded(new DomHandler(), &t);
        wv2->Release();
      }
      EventRegistrationToken tok = {};
      g_webview->add_WebMessageReceived(new MsgHandler(), &tok);
      EventRegistrationToken ntok = {};
      g_webview->add_NavigationCompleted(new NavHandler(), &ntok);
      EventRegistrationToken ptok = {};
      g_webview->add_PermissionRequested(new PermHandler(), &ptok);
      // calc/ 目录（与本 exe 同级）怎么供给页面 —— 主窗/复盘窗共用同一个函数（见其注释）。
      SetupUiServing(g_webview, "wv2");
      LogBoot("controller ready");
      g_webview->Navigate(MainNavUrl(UiBaseUrl(nullptr).c_str()).c_str());
      LogMsg("[wv2] navigated to " + WideToUtf8(MainNavUrl(UiBaseUrl(nullptr).c_str())));   // 实际 URL
    }
    // ★ 2026-09-19：底色设成页面底色（页面还没画出第一帧时露出来的就是它，不闪黑/白）。
    //   ⚠ 控制器**不能**藏（put_IsVisible(FALSE)）：WebView2 一旦不可见会**暂停渲染与脚本**，
    //   实测页面 5s 才报到、有时干脆不到（[hist] 测试钩子因此从来不触发）——
    //   「加载中…」改由页面自己的静态 #boot 遮罩来显示（比 calc.js 还早存在）。
    SetWebviewBg(ctl, g_uiBg);
    ctl->put_IsVisible(TRUE);
    LayoutWebView();
    return S_OK;
  }
};

class EnvHandler : public Cb<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Environment* env) override {
    if (FAILED(hr) || !env) {
      LogMsg("[wv2] environment creation failed - is WebView2 Runtime installed?");
      return S_OK;
    }
    g_env = env;
    env->AddRef();
    LogBoot("wv2 env ready");
    env->CreateCoreWebView2Controller(g_hwnd, new CtlHandler());
    return S_OK;
  }
};

// ---------------------------------------------------------------- 启动遮罩（「加载中…」）
// ★ 2026-09-19（用户要求）：「不管是复盘界面，还是五子棋练习器，启动时要瞬间显示窗口，
//   如果还是黑屏，在黑屏上显示：加载中…」。
//   做法：窗口建出来就**立刻显示**；但 WebView2 控制器先不放出来（创建时 put_IsVisible(FALSE)）
//   —— 这段时间由本进程用 GDI 在客户区画「底色 + 居中 加载中…」（PaintSplash 走 WM_PAINT），
//   页面报到（ready）之后才放出来。于是「窗口出现 → 内容出现」中间一帧黑/白都没有。
//   底色与文案取自上一轮页面报上来的值（%TEMP%/GomokuTrainer.ui），所以深色主题的用户
//   连遮罩都是深色的；3s 兜底定时器保证控制器一定会被放出来。
//   （状态与函数原型在文件上方「启动遮罩：状态 + 入口声明」已声明，这里只放实现。）
static std::wstring UiFile() {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  return Join(std::wstring(tmp), L"GomokuTrainer.ui");
}

/** 读上一轮存下来的「主题|页面底色|语言」；没有就沿用深色默认值。 */
static void LoadUiPrefs() {
  FILE* f = _wfopen(UiFile().c_str(), L"rb");
  if (!f) return;
  char buf[128] = {0};
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  std::string s(buf, n);
  std::string theme = "dark", bg, lang = "zh";
  size_t p1 = s.find('|');
  if (p1 != std::string::npos) {
    theme = s.substr(0, p1);
    size_t p2 = s.find('|', p1 + 1);
    if (p2 != std::string::npos) {
      bg = s.substr(p1 + 1, p2 - p1 - 1);
      lang = s.substr(p2 + 1);
    } else {
      bg = s.substr(p1 + 1);
    }
  }
  while (!lang.empty() && (unsigned char)lang[lang.size() - 1] <= 32) lang.erase(lang.size() - 1);
  g_uiDark = (theme != "light");
  g_uiFg = g_uiDark ? RGB(0x9a, 0xa0, 0xa6) : RGB(0x8a, 0x8a, 0x86);
  if (bg.size() >= 7 && bg[0] == '#') {
    unsigned r = 0, g = 0, b = 0;
    if (sscanf(bg.substr(0, 7).c_str(), "#%2x%2x%2x", &r, &g, &b) == 3) {
      g_uiBg = RGB((BYTE)r, (BYTE)g, (BYTE)b);
    }
  }
  g_uiText = (lang.rfind("en", 0) == 0) ? L"Loading…" : L"加载中…";
  // ★ 选框/弹窗文字也按存下来的语言走：上次停在英文，重启后截图框不能又是中文
  //   （2026-09-21 用户：按键和标题适配英文模式）。
  g_uiLangEn = (lang.rfind("en", 0) == 0);
  LogMsg("[ui] splash prefs loaded (theme=" + theme + " bg=" + bg + " lang=" + lang + ")");
}

/** 页面报到时把「主题|底色|语言」记下来 —— 下次启动的遮罩直接用它，首帧不闪。 */
static void SaveUiPrefs(const std::string& s) {
  std::string theme = JsonStrAfterDecoded(s, JKey("theme").c_str());
  std::string bg = JsonStrAfterDecoded(s, JKey("bg").c_str());
  std::string lang = JsonStrAfterDecoded(s, JKey("lang").c_str());
  if (!lang.empty()) g_uiLangEn = (lang.rfind("en", 0) == 0);
  if (theme != "light" && theme != "dark") theme = "dark";
  if (lang != "en") lang = "zh";
  std::string line = theme + "|" + bg + "|" + lang;
  FILE* f = _wfopen(UiFile().c_str(), L"wb");
  if (!f) return;
  fwrite(line.data(), 1, line.size(), f);
  fclose(f);
}

/** 深色主题下把**系统标题栏**也变深（两个窗口都调）。
 *  属性 20 = Win10 2004+ 的 DWMWA_USE_IMMERSIVE_DARK_MODE；老版本上同一属性号是 19。
 *  失败无所谓（DWM 自己会忽略），所以不做任何兜底 UI。 */
static void ApplyDarkTitleBar(HWND h, bool dark) {
  if (!h || !IsWindow(h)) return;
  BOOL v = dark ? TRUE : FALSE;
  if (FAILED(DwmSetWindowAttribute(h, 20, &v, sizeof(v)))) {
    DwmSetWindowAttribute(h, 19, &v, sizeof(v));
  }
}

/** WebView2 控制器的默认底色 —— 「页面还没画出第一帧」时露出来的就是它。
 *  窗口类背景 + 这一层 + 页面里的静态 #boot 遮罩三层同色，任何一帧都不会闪白/黑。 */
static void SetWebviewBg(ICoreWebView2Controller* ctl, COLORREF c) {
  if (!ctl) return;
  ICoreWebView2Controller2* c2 = nullptr;
  if (FAILED(ctl->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&c2)) || !c2) return;
  COREWEBVIEW2_COLOR col = { 255, GetRValue(c), GetGValue(c), GetBValue(c) };   // A,R,G,B
  c2->put_DefaultBackgroundColor(col);
  c2->Release();
}

/** 把主窗口的 WebView2 控制器放出来（页面报到 / 兜底超时都走这里，幂等）。 */
static void RevealMainPage() {
  g_mainPageShown = true;
  if (g_controller) g_controller->put_IsVisible(TRUE);
  if (g_hwnd && IsWindow(g_hwnd)) InvalidateRect(g_hwnd, nullptr, TRUE);
}

/** 启动遮罩：底色铺满 + （页面还没报到时）居中一行软件英文名。 */
/** 启动遮罩与页面 #boot 共用的那行字（两边必须一模一样）。
 *  ★ 2026-09-21（用户要求）：软件名换成「Meter Gomoku Trainer」，前缀「Meter」涂天蓝
 *    （页面侧是 .boot .brand i{color:#3d9bd6}；这里的 GDI 画法按第一个空格分段分色，
 *    复盘/识图窗的品牌词没有 Meter 前缀，照旧整段一色）。 */
static const wchar_t* kBrandName = L"Meter Gomoku Trainer";
/** 复盘窗遮罩上那行字（同款字体/斜体/灰蓝，只换名字 —— 2026-09-19 用户要求）。 */
static const wchar_t* kBrandNameRv = L"Gomoku Review";

/** 这行字的灰蓝色：深浅两套底色各一档（与 calc.css 的 --boot-fg 对齐）。 */
static COLORREF BrandFg() {
  return g_uiDark ? RGB(0x8c, 0xa6, 0xc0) : RGB(0x5b, 0x7a, 0x99);
}

/** 挑一款**真装了**的字体：思源黑体优先（SIL OFL，可商用），没装再按顺序回落。
 *  ★ 不能直接把字体名丢给 CreateFontW：名字不存在时 Windows 会拿默认字体顶上，
 *    粗细/斜体都对不上，两边（GDI 这一层 vs 页面 CSS）看上去就不像同一个东西了。 */
static const wchar_t* BrandFontFace() {
  static const wchar_t* kFaces[] = {L"Source Han Sans SC", L"Source Han Sans CN", L"Noto Sans SC",
                                    L"思源黑体", L"Source Han Sans", L"Microsoft YaHei", L"Segoe UI"};
  static const wchar_t* picked = nullptr;
  if (picked) return picked;
  struct Ctx { const wchar_t* want; bool found; };
  for (const wchar_t* face : kFaces) {
    Ctx ctx{face, false};
    LOGFONTW lf = {};
    lf.lfCharSet = DEFAULT_CHARSET;
    wcscpy_s(lf.lfFaceName, face);
    HDC screen = GetDC(nullptr);
    EnumFontFamiliesExW(screen, &lf,
        [](const LOGFONTW* f, const TEXTMETRICW*, DWORD, LPARAM lp) -> int {
          Ctx* c = (Ctx*)lp;
          if (f && _wcsicmp(f->lfFaceName, c->want) == 0) { c->found = true; return 0; }
          return 1;
        },
        (LPARAM)&ctx, 0);
    ReleaseDC(nullptr, screen);
    if (ctx.found) { picked = face; return picked; }
  }
  picked = L"Segoe UI";
  return picked;
}

static void PaintSplash(HWND h, bool pageShown, const wchar_t* brand) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(h, &ps);
  RECT rc;
  GetClientRect(h, &rc);
  HBRUSH br = CreateSolidBrush(g_uiBg);
  FillRect(dc, &rc, br);
  DeleteObject(br);
  if (!pageShown) {
    // ★ 2026-09-19（用户定稿）：原生遮罩上就一行**软件英文名** —— 和页面 #boot 里那行
    //   必须是同一个东西（同样的字、同样的斜体/字重、同样的灰蓝）。
    //   字体优先思源黑体（SIL OFL，**可商用**，不像雅黑那样只能随 Windows 授权使用），
    //   没装再按顺序回落；纯 ASCII 文本，任何一款都能画出来。
    int dpi = GetDeviceCaps(dc, LOGPIXELSY);
    HFONT f = CreateFontW(-MulDiv(22, dpi, 72), 0, 0, 0, FW_SEMIBOLD, TRUE /*斜体*/, FALSE, FALSE,
                          ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                          CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, BrandFontFace());
    HGDIOBJ old = SelectObject(dc, f);
    SetBkMode(dc, TRANSPARENT);
    // ★ 2026-09-21（用户要求）：「Meter」单独涂天蓝 —— 按第一个空格把品牌词拆两段分别画，
    //   整体仍然水平居中（先量两段宽度和，再从居中起点先后 TextOut 两段）。
    const wchar_t* kMeter = L"Meter";
    size_t mlen = wcslen(kMeter);
    bool hasMeter = (wcsncmp(brand, kMeter, mlen) == 0 && brand[mlen] == L' ');
    const wchar_t* rest = hasMeter ? (brand + mlen) : brand;   // 余下部分含前导空格 → 间隔自然带出
    SIZE sm = { 0, 0 }, sr = { 0, 0 };
    GetTextExtentPoint32W(dc, kMeter, (int)mlen, &sm);
    GetTextExtentPoint32W(dc, rest, (int)wcslen(rest), &sr);
    RECT rc2;
    GetClientRect(h, &rc2);
    int tx = rc2.left + ((rc2.right - rc2.left) - (sm.cx + sr.cx)) / 2;
    int ty = rc2.top + ((rc2.bottom - rc2.top) - sr.cy) / 2;
    if (hasMeter) {
      SetTextColor(dc, RGB(0x3d, 0x9b, 0xd6));                 // Meter = 天蓝（同 .fwdok.on）
      TextOutW(dc, tx, ty, kMeter, (int)mlen);
    }
    SetTextColor(dc, BrandFg());
    TextOutW(dc, tx + sm.cx, ty, rest, (int)wcslen(rest));
    SelectObject(dc, old);
    DeleteObject(f);
  }
  EndPaint(h, &ps);
}
// ---------------------------------------------------------------- 复盘窗口（第二个顶层窗口）
// 用户要求（2026-09-19）：「打开复盘，弹出一个**新的窗口**……这个窗口只有**一个棋盘和下面的
// 几个控制键**，不参与任何功能的连接（没有 AI、也没有禁手/无禁手）」；历史里点一局同样开在这里。
// 实现要点：
//   · 复用主窗口的 WebView2 环境（g_env）与同一份 calc/ 目录映射，页面用 ?rv=1 进 RV_MODE；
//   · hWndParent 传 nullptr → 这是一个**独立**的顶层窗口（有自己的任务栏按钮），
//     不是主窗口的附属弹窗；关掉主窗口 = 整个进程退出，它也跟着没（引擎本来就绑在主窗口上）；
//   · 全程不碰引擎、不碰看门狗 / :8972 / inbox —— 那些都是主窗口专属的。
// 全进程只保留**一个**复盘窗口：再点复盘、或在历史里换一局 → 复用同一个窗口并投递新局。
static const wchar_t* kRvCls = L"GbCalcReview";
static const wchar_t* kRvTitle = L"复盘 · Gomoku Review";

static std::wstring RvWinPosFile() {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  return Join(std::wstring(tmp), L"GomokuReview.pos");
}
static void PostToRvPage(const std::string& json) {
  if (!g_rvWebview) { g_rvPending = json; return; }
  std::wstring w = Utf8ToWide(json);
  g_rvWebview->PostWebMessageAsJson(w.c_str());
}
/** 回给「刚才那个窗口」（主窗 or 复盘窗）—— 两个窗口都开了历史抽屉，导入回执要回对地方。 */
static void PostToOwner(HWND owner, const std::string& json) {
  if (owner && owner == g_rvHwnd) PostToRvPage(json); else PostToPage(json);
}
static void LayoutRvWebView() {
  if (!g_rvController || !g_rvHwnd) return;
  RECT r;
  GetClientRect(g_rvHwnd, &r);
  g_rvController->put_Bounds(r);
}
static void SaveRvWinPos() {
  if (!g_rvHwnd || IsIconic(g_rvHwnd)) return;
  WINDOWPLACEMENT wp = {};
  wp.length = sizeof(wp);
  if (!GetWindowPlacement(g_rvHwnd, &wp)) return;
  FILE* f = _wfopen(RvWinPosFile().c_str(), L"wb");
  if (!f) return;
  fwrite(&wp, 1, sizeof(wp), f);
  fclose(f);
}

// ★ 2026-09-19（用户反馈「打开复盘要黑一会才出来、感觉有点慢」）—— 两处改动：
//   ① **建好先藏着**：CreateWindowEx 之后不再立刻 ShowWindow，等页面报到（ready）才亮。
//      页面报到时会把它的底色一起报上来（bg），我们拿它设 WebView2 的
//      DefaultBackgroundColor —— 于是窗口一露面就是画好的复盘盘面，
//      中间**不会有黑块/白块闪一下**（那一下就是用户看到的「黑一会」）。
//      兜底：万一下面报到迟迟不来，2.5s 后照样把窗口亮出来（绝不让它变成永远不出现）。
//   ② **预热**：主窗口页面就绪后 2.5s，在后台把复盘窗建好藏着（WebView2 先启好、页面也加载完）。
//      用户点「复盘」时只剩「投数据 + ShowWindow」→ 秒开，不用干等 WebView2 启动。
//      复盘窗被关掉后 1.5s 再备一份，下次照样秒开。
static bool g_rvWanted = false;      // 用户真的要它出来（false = 纯预热，建好藏着不显示）
static bool g_rvShown = false;       // 已经 ShowWindow 过
static bool g_rvPageReady = false;   // 页面报过到（ready）
static const UINT_PTR kRvTimerPrewarm = 2;   // 主窗口侧的预热定时器
// ★ 自定义消息：复盘窗关掉之后要**立刻**再备一个藏着的。用消息而不是定时器 ——
//   用户要求「不要固定时间」，能多早就多早。
static const UINT kMsgPrewarmRv = WM_APP + 1;
// kRvTimerTestOpen(=3) 定义在文件前面（MsgHandler 也要用）

/** 复盘窗的 WebView2 默认底色 = 页面底色（页面在 ready 报文里带上来）。
 *  设置它只为「还没画出第一帧」的那一瞬间不露黑/白，跟主题无关。 */
static void SetRvBackground(const std::string& hex) {
  if (!g_rvController || hex.size() < 7 || hex[0] != '#') return;
  ICoreWebView2Controller2* c2 = nullptr;
  if (FAILED(g_rvController->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&c2)) || !c2) return;
  unsigned r = 0, g = 0, b = 0;
  if (sscanf(hex.c_str(), "#%2x%2x%2x", &r, &g, &b) == 3) {
    COREWEBVIEW2_COLOR col = { 255, (BYTE)r, (BYTE)g, (BYTE)b };   // 字段顺序是 A,R,G,B
    c2->put_DefaultBackgroundColor(col);
    LogMsg("[rv] default background = " + hex);
  }
  c2->Release();
}

/** 把复盘窗亮出来（幂等）。页面还没报到时不调用它 —— 见上面 ① 的说明。 */
static void ShowReviewWindow() {
  if (!g_rvHwnd || g_rvShown) return;
  g_rvShown = true;
  ShowWindow(g_rvHwnd, SW_SHOWNORMAL);
  SetForegroundWindow(g_rvHwnd);
  LogMsg("[rv] review window shown");
}

/** 把复盘窗的 WebView2 控制器放出来（页面报到 / 兜底超时都走这里，幂等）。
 *  ★ 2026-09-19（用户要求）：「复盘界面启动时也要瞬间显示窗口，黑屏上显示 加载中…」——
 *    窗口（可以）立刻就显示，控制器先藏着，这段时间客户区由 PaintSplash 画「加载中…」。 */
static void RevealRvPage() {
  if (g_rvController) g_rvController->put_IsVisible(TRUE);
  if (g_rvHwnd && IsWindow(g_rvHwnd)) InvalidateRect(g_rvHwnd, nullptr, TRUE);
}

static void ScheduleRvPrewarm(UINT ms) {
  if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kRvTimerPrewarm, ms, nullptr);
}

static LRESULT CALLBACK RvWndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_ERASEBKGND:
      return 1;                                  // 底色只由 WM_PAINT 铺（不闪系统白底）
    case WM_PAINT:
      PaintSplash(h, g_rvPageReady, kBrandNameRv);  // 页面报到前画「Gomoku Review」（同款斜体灰蓝）
      return 0;
    case WM_SIZE:
      LayoutRvWebView();
      return 0;
    // ★ 2026-09-19（用户定稿）：WM_TIMER 全撤 —— 显示与揭示都是**纯事件驱动**：
    //   点击 → ShowReviewWindow（立即）；页面报到 → RevealRvPage（立即）。没有兜底等待。
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      // ★ 复盘窗最小尺寸：装得下一张棋盘 + 底部一行导航键。
      //   ★ 2026-09-28：CSS px 基准 × 当前显示器 DPI（写死物理像素的话高分屏上会被压到很小）。
      int mw = GbPx(h, 520), mh = GbPx(h, 620);
      GbClampToWorkArea(h, mw, mh);
      mm->ptMinTrackSize.x = mw;
      mm->ptMinTrackSize.y = mh;
      return 0;
    }
    case WM_CLOSE:
      SaveRvWinPos();
      DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      SaveRvWinPos();
      if (g_rvController) { g_rvController->Release(); g_rvController = nullptr; }
      if (g_rvWebview) { g_rvWebview->Release(); g_rvWebview = nullptr; }
      g_rvHwnd = nullptr;
      g_rvCreating = false;
      g_rvPending.clear();
      g_rvWanted = false;
      g_rvShown = false;
      g_rvPageReady = false;
      LogMsg("[rv] review window destroyed");
      // 关掉后**立刻**（不排任何定时器）再备一份藏着的 → 下次点「复盘」依旧是秒开。
      // ★ 走 PostMessage 而不是直接调：现在是 WM_DESTROY 里，窗口还没拆干净，
      //   延到主窗口的下一轮消息再建，同样**不引入任何固定等待**。
      PostMessageW(g_hwnd, kMsgPrewarmRv, 0, 0);
      return 0;                          // ★ 不要 PostQuitMessage：主窗口还开着
    default:
      break;
  }
  return DefWindowProcW(h, m, w, l);
}

class RvMsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*,
                                   ICoreWebView2WebMessageReceivedEventArgs* e) override {
    LPWSTR raw = nullptr;
    if (FAILED(e->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
    std::string s = WideToUtf8(raw);
    CoTaskMemFree(raw);
    if (s.find("\"ready\"") != std::string::npos) {
      g_rvPageReady = true;
      ApplyDarkTitleBar(g_rvHwnd, g_uiDark);           // 复盘窗的标题栏也跟着主题走
      RevealRvPage();                                 // 页面能画了 → 撤遮罩、放出控制器
      SetRvBackground(JsonStrAfter(s, "\"bg\":"));     // 先把底色定下来，再决定要不要露脸
      if (!g_rvWanted) {
        // 预热那一轮：页面已经就绪、窗口继续藏着，等用户真点「复盘」
        LogMsg("[rv] prewarmed and hidden (page ready, waiting for the user)");
        return S_OK;
      }
      LogMsg("[rv] review page ready");
      if (!g_rvPending.empty()) {
        std::string p = g_rvPending;
        g_rvPending.clear();
        PostToRvPage(p);
      }
      ShowReviewWindow();                              // ★ 页面画好了才亮出来（不闪黑/白）
      return S_OK;
    }
    // 页面回执：确认真收到了那一局（端到端测试的判据之一；正式运行只是日志）
    if (s.find("\"reviewAck\"") != std::string::npos) {
      int n = 0;
      size_t p = s.find("\"moves\":");
      if (p != std::string::npos) n = atoi(s.c_str() + p + 8);
      LogMsg("[rv] ack moves=" + std::to_string(n));
      return S_OK;
    }
    if (s.find("\"closeReview\"") != std::string::npos) {
      LogMsg("[rv] page asked to close the review window");
      if (g_rvHwnd) PostMessageW(g_rvHwnd, WM_CLOSE, 0, 0);
      return S_OK;
    }
    if (s.find("\"savePng\"") != std::string::npos) {
      SavePngFromPage(s, g_rvHwnd);       // 复盘窗里也要能「保存局面」
      return S_OK;
    }
    // 复盘窗里也开着同一个历史抽屉（用户要求：打开复盘窗后再挑历史 → 露出背诵/回顾），
    // 所以导出的「另存为」、导入的「打开」、以及导入回执这里都得认。
    if (s.find("\"saveTxt\"") != std::string::npos) {
      TxtSaveResult r = SaveTxtFromPage(s, g_rvHwnd);
      if (r.ok) PostToOwner(g_rvHwnd, "{\"type\":\"histExported\",\"n\":" + std::to_string(r.n) + "}");
      return S_OK;
    }
    if (s.find("\"openTxt\"") != std::string::npos) {
      std::string m = ReadTxtMessage(g_rvHwnd);
      if (!m.empty()) PostToOwner(g_rvHwnd, m);
      return S_OK;
    }
    if (s.find("\"histImported\"") != std::string::npos) {
      LogMsg("[hist] imported (review) n=" + std::to_string(JsonIntAfter(s, "\"n\":")) +
             " fp=" + JsonStrAfter(s, "\"fp\":"));
      return S_OK;
    }
    return S_OK;
  }
};

class RvCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
    g_rvCreating = false;
    if (FAILED(hr) || !ctl || !g_rvHwnd) {
      LogMsg("[rv] review controller creation failed");
      return S_OK;
    }
    g_rvController = ctl;
    ctl->AddRef();
    ctl->get_CoreWebView2(&g_rvWebview);
    if (!g_rvWebview) return S_OK;
    g_rvWebview->AddRef();
    ICoreWebView2Settings* st = nullptr;
    if (SUCCEEDED(g_rvWebview->get_Settings(&st)) && st) {
      st->put_IsStatusBarEnabled(FALSE);
      st->put_AreDefaultContextMenusEnabled(FALSE);
      ICoreWebView2Settings3* st3 = nullptr;
      if (SUCCEEDED(st->QueryInterface(__uuidof(ICoreWebView2Settings3), (void**)&st3)) && st3) {
        st3->put_IsZoomControlEnabled(FALSE);
        st3->Release();
      }
      st->Release();
    }
    // 同一份 calc/ 供给 —— 密文拦截 / 明文映射都由共用函数处理（★ 此前只映射目录、
    // 没注册解密拦截器，发布包只剩 .enc 时复盘窗直接 ERR_FILE_NOT_FOUND，已修）。
    SetupUiServing(g_rvWebview, "rv");
    EventRegistrationToken tok = {};
    g_rvWebview->add_WebMessageReceived(new RvMsgHandler(), &tok);
    g_rvWebview->Navigate(UiBaseUrl("rv").c_str());
    // ★ 2026-09-19：控制器先藏着（客户区留给 PaintSplash 的「加载中…」），页面报到后
    //   由 RevealRvPage() 放出来 —— 窗口本身可以立刻显示（用户要求「复盘界面也要瞬间
    //   显示窗口，如果还是黑屏，在黑屏上显示 加载中…」）。
    SetWebviewBg(ctl, g_uiBg);
    ctl->put_IsVisible(FALSE);
    LayoutRvWebView();
    LogMsg("[rv] navigated to calc.html?rv=1");
    return S_OK;
  }
};

/** 建复盘窗（**不显示**）并把 WebView2 控制器挂上。窗口先藏着，
 *  等页面报到（或兜底定时器到点）才由 ShowReviewWindow() 亮出来。 */
static void CreateReviewWindow() {
  if (g_rvHwnd || g_rvCreating || !g_env) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = RvWndProc;
  wc.hInstance = g_hInst;
  wc.lpszClassName = kRvCls;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.hIcon = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
  wc.hIconSm = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
  RegisterClassExW(&wc);

  // ★ 2026-09-28（用户要求）：复盘窗默认尺寸同样按分辨率/缩放换算（900×980 CSS px）——
  //   原来写死物理像素，4K@175% 上只有 514×560 CSS px，棋盘一开就很小。
  int x = CW_USEDEFAULT, y = CW_USEDEFAULT;
  int w = GbPx(nullptr, 900), h = GbPx(nullptr, 980);
  bool placed = false;
  {
    FILE* f = _wfopen(RvWinPosFile().c_str(), L"rb");
    if (f) {
      WINDOWPLACEMENT wp = {};
      if (fread(&wp, 1, sizeof(wp), f) == sizeof(wp) && wp.length == sizeof(wp)) {
        RECT r = wp.rcNormalPosition;
        x = r.left; y = r.top;
        w = r.right - r.left; h = r.bottom - r.top;
        placed = true;
      }
      fclose(f);
    }
  }
  RECT work = {0, 0, 0, 0};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  if (!placed) {
    // 第一次开：贴主窗口右边（放不下就贴左边）—— 两个窗口横向不重叠，方便并排看
    RECT mw = {0, 0, 0, 0};
    if (g_hwnd) GetWindowRect(g_hwnd, &mw);
    x = mw.right + 12;
    if (x + w > work.right) x = mw.left - w - 12;
    y = mw.top;
  }
  int maxW = work.right - work.left, maxH = work.bottom - work.top;
  if (w > maxW) w = maxW;
  if (h > maxH) h = maxH;
  if (x < work.left) x = work.left;
  if (y < work.top) y = work.top;
  if (x + w > work.right) x = work.right - w;
  if (y + h > work.bottom) y = work.bottom - h;

  // ★ hWndParent = nullptr：**独立**顶层窗口（有自己的任务栏按钮），不是主窗口的附属弹窗。
  //   ★ 不带 WS_VISIBLE、也不 ShowWindow：先藏着（见上面 ① 的说明）。
  g_rvHwnd = CreateWindowExW(0, kRvCls, kRvTitle,
                             WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                             x, y, w, h, nullptr, nullptr, g_hInst, nullptr);
  if (!g_rvHwnd) { LogMsg("[rv] CreateWindowEx failed"); return; }
  g_rvCreating = true;
  g_rvShown = false;
  g_rvPageReady = false;
  LogMsg("[rv] review window created (independent top-level window)");
  LogMsg("[rv] window kept hidden until the page reports ready (no black flash)");
  g_env->CreateCoreWebView2Controller(g_rvHwnd, new RvCtlHandler());
}

/** 预热：在后台把复盘窗**藏好**建出来（WebView2 先启好、页面也加载完）。
 *  用户第一次点「复盘」时就是秒开，而不是干等 WebView2 启动。
 *  预热**不动 g_rvWanted** —— 页面报到时看到 false，就只是静静留在后台。 */
static void PrewarmReviewWindow() {
  if (g_rvHwnd || g_rvCreating || !g_env) return;
  LogMsg("[rv] prewarming the review window (hidden, so the first open is instant)");
  CreateReviewWindow();
}

/** 打开（或复用）复盘窗口，并把要复盘的那一局投进页面。
 *  recordJson = {"moves":[[x,y,c]…], …}；空串 = 纯空棋盘（顶栏「复盘」进来的那种）。 */
static void OpenReviewWindow(const std::string& recordJson) {
  std::string rec = recordJson.empty() ? std::string("{\"moves\":[]}") : recordJson;
  LogMsg("[rv] openReview record " + std::to_string(rec.size()) + " bytes");
  std::string msg = "{\"type\":\"reviewData\",\"record\":" + rec + "}";
  g_rvWanted = true;
  if (g_rvHwnd) {                                // 已经开着 / 或预热好了 → 复用，只换内容
    if (IsIconic(g_rvHwnd)) ShowWindow(g_rvHwnd, SW_RESTORE);
    if (g_rvPageReady) PostToRvPage(msg);
    else g_rvPending = msg;                      // 页面还没报到 → 攒着，ready 时一起投
    // ★ 2026-09-19（用户再强调）：「一定要先弹出界面」—— 点了**立刻**弹窗，绝不等页面。
    //   预热窗的页面偶尔还没报到时，旧代码靠 2.5s 定时器兜底才显形 = 用户感觉「点了没反应」。
    //   遮罩（Gomoku Review 那行字）本来就画在客户区上，先弹出来正好承接加载过程；
    //   页面报到后 RevealRvPage() 再把正片放出来（无定时器，纯事件）。
    ShowReviewWindow();
    // ★ 2026-09-19（用户定稿）：**不加任何定时器** —— 点击即弹窗、页面报到（事件）即放正片，
    //   快慢全交給机器；遮罩只是启动画面，不是等待门槛。
    SetForegroundWindow(g_rvHwnd);
    return;
  }
  g_rvPending = msg;
  if (g_rvCreating || !g_env) {                  // 正在建 / 环境还没就绪 → 先攒着，等 ready 再发
    LogMsg(g_rvCreating ? "[rv] queued (window is being created)"
                        : "[rv] queued (webview2 env not ready)");
    // 窗口已经建出来了（只是页面还在启动）→ 先亮出来，让用户看到「加载中…」
    if (g_rvHwnd) ShowReviewWindow();
    return;
  }
  CreateReviewWindow();
  if (g_rvHwnd) {
    // ★ 2026-09-19（用户要求）：「复盘界面启动时也要**瞬间显示窗口**」—— 窗口立刻亮出来，
    //   客户区由 PaintSplash 画「Gomoku Review」，页面报到（ready 事件）后 RevealRvPage()
    //   再换成正片。**不加定时器**：快慢全交給机器（见上面复用分支的同款注释）。
    ShowReviewWindow();
  }
}

// ---------------------------------------------------------------- 识图窗口（第三个顶层窗口，2026-09-21）
// 用户要求：顶栏「识图」（在「复盘」左边）打开一个**独立窗口**：左边上传/截屏的图片面板、
// 右边一张棋盘显示识别结果；识别由随包的 GomokuVision.exe 子进程离线完成。
// 与复盘窗同款机制：复用 g_env、共享 calc/ 目录、PaintSplash「Gomoku Vision」遮罩、
// 页面报到才揭正片；全程不碰引擎/看门狗/:8972。全进程只保留**一个**识图窗（复用）。
static const wchar_t* kVisCls = L"GbCalcVis";
static const wchar_t* kVisTitle = L"识图 · Gomoku Vision";
/** 识图窗遮罩上的那行英文名（与软件/复盘窗同款斜体灰蓝 —— 用户要求「同款加载单词」）。 */
static const wchar_t* kBrandNameVis = L"Gomoku Vision";

static std::wstring VisWinPosFile() {
  wchar_t tmp[MAX_PATH] = { 0 };
  GetTempPathW(MAX_PATH, tmp);
  return Join(std::wstring(tmp), L"GomokuVis.pos");
}
static void PostToVisPage(const std::string& json) {
  if (!g_visWebview) { g_visPending = json; return; }
  std::wstring w = Utf8ToWide(json);
  g_visWebview->PostWebMessageAsJson(w.c_str());
}
/** 识图窗的回程消息：后台线程（截屏/识别）也会投递 → PostMessage 触发主线程 flush
 *  （SetTimer 跨线程不可靠；见 kMsgFlushOutbox 的说明）。 */
static void PostToVisPageSoon(const std::string& json) {
  g_outboxVis.push_back(json);
  if (g_hwnd && IsWindow(g_hwnd)) PostMessageW(g_hwnd, kMsgFlushOutbox, 0, 0);
}
static void LayoutVisWebView() {
  if (!g_visController || !g_visHwnd) return;
  RECT r;
  GetClientRect(g_visHwnd, &r);
  g_visController->put_Bounds(r);
}
static void SaveVisWinPos() {
  if (!g_visHwnd || IsIconic(g_visHwnd)) return;
  WINDOWPLACEMENT wp = {};
  wp.length = sizeof(wp);
  if (!GetWindowPlacement(g_visHwnd, &wp)) return;
  FILE* f = _wfopen(VisWinPosFile().c_str(), L"wb");
  if (!f) return;
  fwrite(&wp, 1, sizeof(wp), f);
  fclose(f);
}
static void ShowVisWindow() {
  if (!g_visHwnd || g_visShown) return;
  g_visShown = true;
  ShowWindow(g_visHwnd, SW_SHOWNORMAL);
  SetForegroundWindow(g_visHwnd);
  LogMsg("[vis] vision window shown");
}
static void RevealVisPage() {
  if (g_visController) g_visController->put_IsVisible(TRUE);
  if (g_visHwnd && IsWindow(g_visHwnd)) InvalidateRect(g_visHwnd, nullptr, TRUE);
}
static void SetVisBackground(const std::string& hex) {
  if (!g_visController || hex.size() < 7 || hex[0] != '#') return;
  ICoreWebView2Controller2* c2 = nullptr;
  if (FAILED(g_visController->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&c2)) || !c2) return;
  unsigned r = 0, g = 0, b = 0;
  if (sscanf(hex.c_str(), "#%2x%2x%2x", &r, &g, &b) == 3) {
    COREWEBVIEW2_COLOR col = { 255, (BYTE)r, (BYTE)g, (BYTE)b };   // 字段顺序是 A,R,G,B
    c2->put_DefaultBackgroundColor(col);
    LogMsg("[vis] default background = " + hex);
  }
  c2->Release();
}

/** 识图界面没了 → 截图框没有归宿，一起收掉（2026-09-21 用户要求）。
 *  ★ 必须 Post 而不是直接 DestroyWindow：此刻正处在识图窗的 WM_CLOSE/WM_DESTROY 里，
 *    选框有自己的消息循环，同步拆会打断它的 WM_PAINT/定时器。 */
static void VselCloseWithVisWindow() {
  if (g_visSelHwnd && IsWindow(g_visSelHwnd)) {
    LogMsg("[vis] vision window gone -> closing the hollow select box");
    PostMessageW(g_visSelHwnd, WM_CLOSE, 0, 0);
  }
}

static LRESULT CALLBACK VisWndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      // 页面报到前画「Gomoku Vision」（与软件/复盘窗同款字体/斜体/灰蓝，用户要求）
      PaintSplash(h, g_visPageReady, kBrandNameVis);
      return 0;
    case WM_SIZE:
      LayoutVisWebView();
      return 0;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      // ★ 识图窗最小阈值（用户 2026-09-21 定 880×580；★ 九轮抬高 900×660：底部一行 5 键 + 识别框加高）
      //   ★ 2026-09-28：改成 **CSS px 基准 × 当前显示器 DPI**（与主窗同一套换算，见 kVisMinCssW/H）
      //   —— 写死物理像素的话，4K@175% 上只剩 514×377 CSS px，底部那排键会挤堆。
      int mw = GbPx(h, kVisMinCssW), mh = GbPx(h, kVisMinCssH);
      GbClampToWorkArea(h, mw, mh);
      mm->ptMinTrackSize.x = mw;
      mm->ptMinTrackSize.y = mh;
      return 0;
    }
    case WM_CLOSE:
      SaveVisWinPos();
      VselCloseWithVisWindow();
      DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      SaveVisWinPos();
      VselCloseWithVisWindow();
      if (g_visController) { g_visController->Release(); g_visController = nullptr; }
      if (g_visWebview) { g_visWebview->Release(); g_visWebview = nullptr; }
      g_visHwnd = nullptr;
      g_visCreating = false;
      g_visPending.clear();
      g_visShown = false;
      g_visPageReady = false;
      LogMsg("[vis] vision window destroyed");
      return 0;                          // ★ 不要 PostQuitMessage：主窗口还开着
    default:
      break;
  }
  return DefWindowProcW(h, m, w, l);
}

class VisMsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*,
                                   ICoreWebView2WebMessageReceivedEventArgs* e) override {
    LPWSTR raw = nullptr;
    if (FAILED(e->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
    std::string s = WideToUtf8(raw);
    CoTaskMemFree(raw);
    if (s.find("\"ready\"") != std::string::npos) {
      g_visPageReady = true;
      ApplyDarkTitleBar(g_visHwnd, g_uiDark);
      RevealVisPage();
      SetVisBackground(JsonStrAfter(s, "\"bg\":"));
      LogMsg("[vis] vision page ready");
      if (!g_visPending.empty()) {
        std::string p = g_visPending;
        g_visPending.clear();
        PostToVisPage(p);
      }
      ShowVisWindow();
      return S_OK;
    }
    // 屏幕截图：挪到主窗独立消息里再开中空选框（不在 WebView2 回调栈上跑消息循环）
    if (s.find("\"visShot\"") != std::string::npos) {
      PostMessageW(g_hwnd, kMsgVisShot, 0, 0);
      return S_OK;
    }
    // ★ 廿四轮（用户要求）：双击图片（识图窗大图 / 抽屉缩略图）→ 用系统默认看图软件打开。
    //   与识别同一套路：页面只给 dataURL，宿主落盘 + ShellExecuteW("open")。
    if (s.find("\"openImage\"") != std::string::npos) {
      OpenImageFromPage(s);
      return S_OK;
    }
    // 识别：把图片字节喂 GomokuVision.exe（后台线程，识别可到数秒）
    if (s.find("\"visRecognize\"") != std::string::npos) {
      std::thread(RunVisionForVis, s).detach();
      return S_OK;
    }
    // 「加载到练习」：把识别结果转投**主窗口**的 external 通道 ——
    // 页面侧 ingestExternal 本来就认 {black,white}（合成着手 + 入库 + 摆上主窗棋盘接着下）
    if (s.find("\"visToTrainer\"") != std::string::npos) {
      std::string payload = JsonSubObject(s, "\"payload\"");
      if (!payload.empty()) {
        PostToPageSoon("{\"type\":\"external\",\"payload\":" + JsonQuote(payload) + "}");
        LogMsg("[vis] forwarded board to the trainer (" + std::to_string(payload.size()) + " bytes)");
      }
      return S_OK;
    }
    // ★ 识图页也会报 uiTheme（页面切语言/切主题）：宿主只要把语言记下来 ——
    //   截图框的按键/标题读的是 g_uiLangEn（2026-09-21 用户：适配英文模式）。
    if (s.find("uiTheme") != std::string::npos) {
      std::string lg = JsonStrAfterDecoded(s, JKey("lang").c_str());
      if (!lg.empty()) g_uiLangEn = (lg.rfind("en", 0) == 0);
      std::string th = JsonStrAfterDecoded(s, JKey("theme").c_str());
      if (th != "light" && th != "dark") th = "dark";
      SaveUiPrefs(s);
      g_uiDark = (th != "light");
      ApplyDarkTitleBar(g_visHwnd, g_uiDark);
      LogMsg("[vis] ui lang -> " + std::string(g_uiLangEn ? "en" : "zh"));
      return S_OK;
    }
    if (s.find("\"closeVis\"") != std::string::npos) {
      LogMsg("[vis] page asked to close the vision window");
      if (g_visHwnd) PostMessageW(g_visHwnd, WM_CLOSE, 0, 0);
      return S_OK;
    }
    return S_OK;
  }
};

class VisCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
    g_visCreating = false;
    if (FAILED(hr) || !ctl || !g_visHwnd) {
      LogMsg("[vis] vision controller creation failed");
      return S_OK;
    }
    g_visController = ctl;
    ctl->AddRef();
    ctl->get_CoreWebView2(&g_visWebview);
    if (!g_visWebview) return S_OK;
    g_visWebview->AddRef();
    ICoreWebView2Settings* st = nullptr;
    if (SUCCEEDED(g_visWebview->get_Settings(&st)) && st) {
      st->put_IsStatusBarEnabled(FALSE);
      st->put_AreDefaultContextMenusEnabled(FALSE);
      ICoreWebView2Settings3* st3 = nullptr;
      if (SUCCEEDED(st->QueryInterface(__uuidof(ICoreWebView2Settings3), (void**)&st3)) && st3) {
        st3->put_IsZoomControlEnabled(FALSE);
        st3->Release();
      }
      st->Release();
    }
    SetupUiServing(g_visWebview, "vis");
    EventRegistrationToken tok = {};
    g_visWebview->add_WebMessageReceived(new VisMsgHandler(), &tok);
    g_visWebview->Navigate(UiBaseUrl("vis").c_str());
    // 控制器先藏着（客户区留给 PaintSplash 的「Gomoku Vision」），页面报到后 RevealVisPage 放出
    SetWebviewBg(ctl, g_uiBg);
    ctl->put_IsVisible(FALSE);
    LayoutVisWebView();
    LogMsg("[vis] navigated to calc.html?vis=1");
    return S_OK;
  }
};

/** 建识图窗（不显示）并把 WebView2 控制器挂上。与复盘窗不同：识图窗**不做预热**
 *  （截屏/上传前它没理由占一份 WebView2），点「识图」即建即弹，遮罩承接加载过程。 */
static void CreateVisWindow() {
  if (g_visHwnd || g_visCreating || !g_env) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = VisWndProc;
  wc.hInstance = g_hInst;
  wc.lpszClassName = kVisCls;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.hIcon = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
  wc.hIconSm = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
  RegisterClassExW(&wc);

  int x = CW_USEDEFAULT, y = CW_USEDEFAULT, w = 1180, h = 820;
  bool placed = false;
  {
    FILE* f = _wfopen(VisWinPosFile().c_str(), L"rb");
    if (f) {
      WINDOWPLACEMENT wp = {};
      if (fread(&wp, 1, sizeof(wp), f) == sizeof(wp) && wp.length == sizeof(wp)) {
        RECT r = wp.rcNormalPosition;
        x = r.left; y = r.top;
        w = r.right - r.left; h = r.bottom - r.top;
        placed = true;
      }
      fclose(f);
    }
  }
  RECT work = { 0, 0, 0, 0 };
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  if (!placed) {
    // 第一次开：贴主窗口右边（放不下就贴左边）—— 左图右盘，与主窗横向不重叠
    RECT mw = { 0, 0, 0, 0 };
    if (g_hwnd) GetWindowRect(g_hwnd, &mw);
    x = mw.right + 12;
    if (x + w > work.right) x = mw.left - w - 12;
    y = mw.top;
  }
  int maxW = work.right - work.left, maxH = work.bottom - work.top;
  if (w > maxW) w = maxW;
  if (h > maxH) h = maxH;
  if (x < work.left) x = work.left;
  if (y < work.top) y = work.top;
  if (x + w > work.right) x = work.right - w;
  if (y + h > work.bottom) y = work.bottom - h;

  // ★ hWndParent = nullptr：独立顶层窗口（有自己的任务栏按钮）。
  //   ★ 不带 WS_VISIBLE、也不 ShowWindow：先藏着，页面报到才亮（同复盘窗，不闪黑/白）。
  g_visHwnd = CreateWindowExW(0, kVisCls, kVisTitle,
                              WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                              x, y, w, h, nullptr, nullptr, g_hInst, nullptr);
  if (!g_visHwnd) { LogMsg("[vis] CreateWindowEx failed"); return; }
  g_visCreating = true;
  g_visShown = false;
  g_visPageReady = false;
  LogMsg("[vis] vision window created (independent top-level window)");
  LogMsg("[vis] window kept hidden until the page reports ready (no black flash)");
  g_env->CreateCoreWebView2Controller(g_visHwnd, new VisCtlHandler());
}

/** 打开（或复用）识图窗口。窗口立刻弹出来（遮罩上是「Gomoku Vision」），
 *  页面报到后由 RevealVisPage 揭正片 —— 与复盘窗「先弹界面」同一条规矩。 */
static void OpenVisWindow() {
  LogMsg("[vis] openVis requested");
  if (g_visHwnd) {
    if (IsIconic(g_visHwnd)) ShowWindow(g_visHwnd, SW_RESTORE);
    ShowVisWindow();
    SetForegroundWindow(g_visHwnd);
    return;
  }
  if (g_visCreating || !g_env) {
    LogMsg(g_visCreating ? "[vis] queued (window is being created)"
                         : "[vis] queued (webview2 env not ready)");
    return;
  }
  CreateVisWindow();
  if (g_visHwnd) ShowVisWindow();
}

// ---------------------------------------------------------------- 窗口

static const wchar_t* kCls = L"GbCalcHost";
static const wchar_t* kTitle = L"五子棋练习器 · Gomoku Trainer";

static std::wstring WinPosFile() {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  return Join(std::wstring(tmp), L"GomokuTrainer.pos");
}
static void SaveWinPos() {
  if (!g_hwnd || IsIconic(g_hwnd)) return;
  WINDOWPLACEMENT wp = {};
  wp.length = sizeof(wp);
  if (!GetWindowPlacement(g_hwnd, &wp)) return;
  FILE* f = _wfopen(WinPosFile().c_str(), L"wb");
  if (!f) return;
  fwrite(&wp, 1, sizeof(wp), f);
  fclose(f);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case kMsgPrewarmRv:                        // 「复盘窗刚关 → 立刻再备一个」（见 RvWndProc/WM_DESTROY）
      PrewarmReviewWindow();
      return 0;
    case kMsgVisShot:                          // 「截图」= 直接开中空选框（UI 线程、回调栈外）
      StartVisShotFlow();
      return 0;
    case WM_ERASEBKGND:
      // 底色一律由 WM_PAINT 那支刷子铺（不然会先闪一下窗口类的系统白底）
      return 1;
    case WM_PAINT:
      // 页面还没报到时这里画「底色 + 加载中…」；报到之后 WebView2 盖住客户区，
      // 我们连 WM_PAINT 都不会再收到（除非被强制重绘）——所以这一支两种情况都对。
      PaintSplash(h, g_mainPageShown, kBrandName);
      return 0;
    case WM_SIZE:
      LayoutWebView();
      return 0;
    case kMsgFlushOutbox:
      // ★ 2026-09-21 重大修复：这是 PostMessageW 发来的独立消息（WM_APP+2），不是 WM_TIMER！
      //   原先这块处理逻辑写在 case WM_TIMER 里面，`if (w == kMsgFlushOutbox)` 永远为假
      //   → 识图窗后台线程回投的「截图结果 / 识别结果」从来没被 flush 过 —— 页面永远停在
      //   「识别中」（用户实测复现，e2e 探针钉死）。必须作为独立 case 挂在 switch 顶层。
      {
        std::vector<std::string> pg, rv, vs;
        pg.swap(g_outboxPage);
        rv.swap(g_outboxRv);
        vs.swap(g_outboxVis);
        for (size_t i = 0; i < pg.size(); ++i) PostToPage(pg[i]);
        for (size_t i = 0; i < rv.size(); ++i) PostToRvPage(rv[i]);
        for (size_t i = 0; i < vs.size(); ++i) PostToVisPage(vs[i]);
      }
      return 0;
    case kMsgEngineFlush:
      // ★ 引擎输出推给页面（新后端）：清 pending → 一次 drain 三车道 → 一条消息推走。
      g_engineFlushPending = false;
      nativeeng::FlushToPage();
      return 0;
    case WM_TIMER:
      // ★ 2026-09-19（用户定稿）：显示类定时器（遮罩兜底 / 遮罩动画心跳）全撤 ——
      //   控制器第一帧就可见、遮罩是页面静态 #boot，正片由页面 ready **事件**直接揭。
      //   只保留机制类：自愈重导航 / 回程消息 outbox / 测试钩子 / 预热调度。
      // ★ 2026-09-19（实测）：WebView2 首帧**偶发**起不来（渲染进程没起来 / LAUNCH_FAILED）
      //   —— 页面永远不报到，窗口就永远停在一句「加载中…」上（端到端测试也随之假红）。
      //   自愈：6s 不见动静就重新导航一次，最多两次。
      if (w == kMainTimerReload) {
        KillTimer(h, kMainTimerReload);
        if (g_mainPageShown) return 0;
        if (g_mainReloads < 2 && g_webview) {
          g_mainReloads++;
          LogMsg("[ui] main page still silent after " + std::to_string(10000 + (g_mainReloads - 1) * 12000) +
                 "ms - re-navigating (self heal #" + std::to_string(g_mainReloads) + ")");
          g_webview->Navigate(MainNavUrl(UiBaseUrl(nullptr).c_str()).c_str());
          SetTimer(h, kMainTimerReload, 12000, nullptr);
          return 0;
        }
        LogMsg("[ui] main page never reported ready - revealing the webview anyway");
        RevealMainPage();
        return 0;
      }
      // 回程消息：下一个 tick 才发（同步发会被丢，见 PostToPageSoon 的说明）
      if (w == kMainTimerOutbox) {
        KillTimer(h, kMainTimerOutbox);
        std::vector<std::string> pg, rv;
        pg.swap(g_outboxPage);
        rv.swap(g_outboxRv);
        for (size_t i = 0; i < pg.size(); ++i) PostToPage(pg[i]);
        for (size_t i = 0; i < rv.size(); ++i) PostToRvPage(rv[i]);
        return 0;
      }
      // 测试钩子：也延后一拍（页面报到那条路是在消息回调里触发的）
      if (w == kMainTimerHook) {
        KillTimer(h, kMainTimerHook);
        FireTestHooks();
        return 0;
      }
      // 诊断（GB_TEST_DIAG=1）：boot 链排查 —— 回读页面关键状态进日志。
      //   #boot 还在 = 页面 boot() 没跑完（中途抛错）；typeof LocalAI = 桥存在否；
      //   readySent 由 calc.js 在 postMessage ready 后置位（区分「没发」vs「没送到」）。
      if (w == kMainTimerEval) {
        KillTimer(h, kMainTimerEval);
        if (g_webview) {
          g_webview->ExecuteScript(Utf8ToWide(
            "(function(){"
            "var b=document.getElementById('boot');"
            "try{return JSON.stringify({"
            "url:location.href,"
            "rs:document.readyState,"
            "title:document.title.slice(0,20),"
            "bootInfo:(typeof window.__bootInfo!=='undefined')?JSON.stringify(window.__bootInfo):null,"
            "gbTop:!!window.__gbTop,"
            "bootElGone:!b,"
            "hasLocalAI:typeof LocalAI,"
            "moves:(typeof G!=='undefined'&&G.moves)?G.moves.length:-1,"
            "readySent:!!window.__gbReadySent"
            "});}catch(err){return 'EVALERR:'+err.message;}"
            "})()").c_str(), new EvalHandler());
        }
        return 0;
      }
      // 预热复盘窗（主窗口页面就绪后预约的那一次，见 ScheduleRvPrewarm）
      if (w == kRvTimerPrewarm) {
        KillTimer(h, kRvTimerPrewarm);
        PrewarmReviewWindow();
        return 0;
      }
      // 测试钩子：推迟到这会儿才让页面去开复盘窗（复现「先预热、用户过一会儿才点复盘」）
      if (w == kRvTimerTestOpen) {
        KillTimer(h, kRvTimerTestOpen);
        PostToPage("{\"type\":\"testOpenReview\"}");
        LogMsg("[rv] test hook (delayed): asked the page to open a review window");
        return 0;
      }
      break;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      // ★★ 2026-09-28（用户要求）：最小窗口尺寸 = **底栏按键文字开始换行/堆叠的临界宽度**，
      //   并且**随显示器分辨率与缩放换算**（不是写死物理像素）。
      //   · 临界值是内容侧的 CSS px：无头 Edge 加载真实 calc.html 二分实测
      //     （tools/measure-bottombar-minwidth.html）：#boardBtns 自然宽 410px，底栏共需 424px；
      //     视口 655px 时棋盘列只给到 419px → 出横向滚动条、底栏 33→41px；视口 **660px** 刚好齐平
      //     ⇒ 取 660 + 20 余量 = **680 CSS px**，高度 600（见 kMainMinCssW/H）。
      //   · 物理像素 = CSS px × dpi/96（WebView2 按 DPI 缩放渲染）——
      //     1080p@100% 得 680，4K@175% 得 1190，内容宽度在两种屏上**是同一个 680 CSS px**。
      //   · 最后夹到工作区，免得在极小屏上「最小值 > 可用区」把窗口卡死。
      int mw = GbPx(h, kMainMinCssW), mh = GbPx(h, kMainMinCssH);
      GbClampToWorkArea(h, mw, mh);
      mm->ptMinTrackSize.x = mw;
      mm->ptMinTrackSize.y = mh;
      return 0;
    }
    case WM_COPYDATA: {
      // 第二个实例（或覆盖层的「复盘」）把 JSON 直接递给已开的窗口
      COPYDATASTRUCT* cd = (COPYDATASTRUCT*)l;
      if (cd && cd->lpData && cd->cbData > 0) {
        std::string body((const char*)cd->lpData, (size_t)cd->cbData);
        std::string msg = "{\"type\":\"external\",\"payload\":" + JsonQuote(body) + "}";
        PostToPage(msg);
        LogMsg("[ipc] WM_COPYDATA " + std::to_string(body.size()) + " bytes -> page");
      }
      SetForegroundWindow(h);
      return TRUE;
    }
    case WM_CLOSE:
      SaveWinPos();
      DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      SaveWinPos();
      g_running.store(false);
      PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(h, m, w, l);
}

/** WebView2 用户数据目录（2026-09-19 用户要求改名）：
 *  以前传 nullptr → WebView2 用默认「<exe 全路径>.WebView2」，落出来就是又长又难看的
 *  「Desktop GomokuTrainer.exe.WebView2」。现在显式指定为 exe 旁的「GomokuTrainer resources」。
 *  ★ 首次升级时把旧目录**整个改名**过来 —— localStorage（设置/历史/布局）都存在里面，
 *    不迁移的话用户升级后设置全丢、历史清零。旧目录被占用（旧版还在跑）时改名失败
 *    就静默放弃：这次先用新目录，下次升级再试。 */
static std::wstring WebView2UserDataDir() {
  wchar_t exePath[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, exePath, MAX_PATH);
  std::wstring oldDir = std::wstring(exePath) + L".WebView2";   // 旧默认名
  std::wstring nu = Join(ExeDir(), L"GomokuTrainer resources");
  DWORD attr = GetFileAttributesW(oldDir.c_str());
  if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
    if (GetFileAttributesW(nu.c_str()) == INVALID_FILE_ATTRIBUTES) {
      if (MoveFileW(oldDir.c_str(), nu.c_str()))
        LogMsg("[boot] migrated WebView2 user data dir -> GomokuTrainer resources");
      else
        LogMsg("[boot] old WebView2 dir in use, migration skipped (will retry next start)");
    }
  }
  return nu;
}

// ★ 关于「给 WebView2 传浏览器启动参数」来提速 —— 试过，别再试（2026-09-19 实测）：
//   手写一个最小的 ICoreWebView2EnvironmentOptions（本工程不引 WRL）传进去，
//   CreateCoreWebView2EnvironmentWithOptions **一律返回 E_INVALIDARG**（0x80070057）；
//   用 GB_WV2_ARGS 二分过：哪怕只带一条最无害的 --disable-features=CalculateNativeWinOcclusion
//   也一样被拒，说明被拒的是**这个手写对象本身**（WebView2 认的是它自己的 WRL 实现），
//   不是参数内容。→ 老老实实传 nullptr 用默认参数。
//   启动耗时的大头本来也不在这里：见下面 [perf] 的埋点，是运行时进程拉起的 1.4~1.6s。
int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
  g_bootT0 = GetTickCount();                 // ★ 启动埋点的零点（越早越好）
  g_hInst = hInst;
  // ★ 必须最先做：本机 3072×1920 @175%，晚一步窗口几何就会被虚拟化。
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == FALSE) {
    SetProcessDPIAware();
  }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  // 单实例：已经在跑就把参数递过去（覆盖层的「复盘」靠这条把棋盘映射进来）。
  std::string argPayload;
  {
    int nArgs = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &nArgs);
    if (argv) {
      for (int i = 1; i < nArgs; ++i) {
        std::wstring a(argv[i]);
        if (a.rfind(L"--board=", 0) == 0) argPayload = WideToUtf8(a.substr(8));
      }
      LocalFree(argv);
    }
  }
  HANDLE mx = CreateMutexW(nullptr, FALSE, L"Global\\GomokuTrainer_v1");
  bool already = (mx && GetLastError() == ERROR_ALREADY_EXISTS);
  if (already) {
    HWND prev = FindWindowW(kCls, nullptr);
    if (prev) {
      if (!argPayload.empty()) {
        COPYDATASTRUCT cd = {};
        cd.cbData = (DWORD)argPayload.size();
        cd.lpData = (void*)argPayload.data();
        SendMessageW(prev, WM_COPYDATA, (WPARAM)0, (LPARAM)&cd);
      }
      if (IsIconic(prev)) ShowWindow(prev, SW_RESTORE);
      SetForegroundWindow(prev);
    }
    if (mx) CloseHandle(mx);
    return 0;
  }

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.lpszClassName = kCls;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(1));         // 由 icon.rc 编入
  wc.hIconSm = LoadIconW(hInst, MAKEINTRESOURCEW(1));
  RegisterClassExW(&wc);

  // ★ 2026-09-28（用户要求）：默认尺寸也按分辨率/缩放换算（kMainDefCssW/H = 1280×820 CSS px）。
  //   原来写死 1180×780 **物理像素** —— 在 4K@175% 上首启只有 674×446 CSS px（比底栏临界还窄），
  //   第一次打开就是挤堆的；现在任何缩放下首启都是同一个 1280×820 CSS px 的舒展布局。
  int x = CW_USEDEFAULT, y = CW_USEDEFAULT;
  int w = GbPx(nullptr, kMainDefCssW), h = GbPx(nullptr, kMainDefCssH);
  GbClampToWorkArea(nullptr, w, h);
  bool maximized = false;
  {
    FILE* f = _wfopen(WinPosFile().c_str(), L"rb");
    if (f) {
      WINDOWPLACEMENT wp = {};
      if (fread(&wp, 1, sizeof(wp), f) == sizeof(wp) && wp.length == sizeof(wp)) {
        RECT r = wp.rcNormalPosition;
        x = r.left; y = r.top;
        w = r.right - r.left; h = r.bottom - r.top;
        maximized = (wp.showCmd == SW_SHOWMAXIMIZED);
      }
      fclose(f);
    }
  }
  // ★ 2026-09-28：存档里的尺寸同样要过一遍当前显示器的最小值 —— 换了显示器 / 改了缩放之后，
  //   旧存档可能是按另一档 DPI 存的（物理像素偏小），直接还原会一开窗就挤堆。
  {
    int mw = GbPx(nullptr, kMainMinCssW), mh = GbPx(nullptr, kMainMinCssH);
    GbClampToWorkArea(nullptr, mw, mh);
    if (w < mw) w = mw;
    if (h < mh) h = mh;
  }
  // ★ 启动遮罩（用户要求「启动时瞬间显示窗口，黑屏上显示 加载中…」）：
  //   先把上一轮的主题底色读回来 —— 窗口一出来就铺它，不会闪一下白或黑；
  //   「深色标题栏」也要赶在 ShowWindow 之前定好，否则会先亮一条浅色标题栏再变深。
  LoadUiPrefs();
  g_hwnd = CreateWindowExW(0, kCls, kTitle,
                           WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                           x, y, w, h, nullptr, nullptr, hInst, nullptr);
  if (!g_hwnd) { LogMsg("[boot] CreateWindowEx failed"); return 1; }
  ApplyDarkTitleBar(g_hwnd, g_uiDark);
  ShowWindow(g_hwnd, maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
  UpdateWindow(g_hwnd);          // 立刻把启动遮罩画上（页面报到后由 RevealMainPage 撤掉）
  LogBoot("window shown");
  // ★ 2026-09-19（用户定稿）：**不加显示类定时器** —— 全靠事件驱动（页面 ready 即揭），
  //   快慢交給机器。唯一保留的周期性定时器是「自愈重导航」（页面 6s 无动静才重导航，
  //   那是故障恢复，不是等待）。
  SetTimer(g_hwnd, kMainTimerReload, 10000, nullptr);  // 自愈：页面 10s 不来才重导航（首次冷启动+模型初始化别误伤）
  {
    char dv[8] = {0};
    if (GetEnvironmentVariableA("GB_TEST_DIAG", dv, sizeof(dv)) && dv[0] == '1')
      SetTimer(g_hwnd, kMainTimerEval, 25000, nullptr);  // 诊断：25s 后回读（页面 ready + AI boot 完）
  }

  LogMsg("[boot] GomokuTrainer starting (exe dir " + WideToUtf8(ExeDir()) + ")");
  // ★ 目标：窗口出现到页面能画 ≤1.2s。WebView2 环境创建是这条链上最慢的一环（几百毫秒），
  //   而它是**异步**的 —— 所以必须**第一个**发起，让它和引擎拉起、后台线程并行跑。
  //   （旧代码把它排在引擎拉起之后，等于整段串行；页面内 AI 后没有引擎进程可言。）
  //   签名：(browserExecutableFolder, userDataFolder, environmentOptions, handler) —— 四个参数。
  //   第三个参数传 nullptr（自定义参数对象会被拒，原因见上面的注释）。
  //   ★ 第二个参数传 exe 旁的「GomokuTrainer resources」（2026-09-19 用户要求：不要
  //     「Desktop GomokuTrainer.exe.WebView2」那种长名字；旧目录会整个迁移过来）。
  std::wstring wv2udf = WebView2UserDataDir();
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, wv2udf.c_str(), nullptr, new EnvHandler());
  LogBoot("wv2 env requested");

  // ★ 页面内 AI：宿主不再拉任何引擎进程。AI = 页面 Worker 加载 rapfi（见 ResHandler /ai/*）。
  //   提权线程：渲染进程在控制器创建后陆续出现，分三次补扫（best-effort，进程退出即停）。
  std::thread([] {
    int delays[] = { 2500, 7000, 15000 };
    for (int i = 0; i < 3; i++) {
      Sleep(delays[i]);
      if (!g_running.load()) return;
      BoostWebViewPriority();
    }
  }).detach();
  std::thread(HttpHistoryServer).detach();
  std::thread(InboxFileWatcher).detach();
  std::thread(HttpUiServer).detach();   // ★ 页面 + AI 资源供给（动态端口，见 g_uiPort 注释；
                                        //   进程内拦截器方案 2026-09-28 实测否决，见 SetupUiServing 注释）
#ifdef GB_SUITE_ENGINE
  // ★ 三件套版：:8964 共享引擎的拉起/复用看门狗（原本的相互连接逻辑，见函数块头注释）
  std::thread(EngineWatchdog).detach();
#endif
  if (!argPayload.empty()) {
    std::string msg = "{\"type\":\"external\",\"payload\":" + JsonQuote(argPayload) + "}";
    g_pending = msg;
  }

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  g_running.store(false);
  if (mx) CloseHandle(mx);
  CoUninitialize();
  return 0;
}
