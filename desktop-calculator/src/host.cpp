/* Meter Gomoku Trainer desktop host - Win32 shell, WebView2 UI, vision pipe, native RapFi engine (hard link, no HTTP). */


#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX              
#endif
#include <winsock2.h>     
#include <ws2tcpip.h>
#include <windows.h>
#include <objidl.h>       
#include <gdiplus.h>      
#include <gdiplusflat.h>  
#include <commdlg.h>      
#include <shellapi.h>
#include <shlwapi.h>
#include <objbase.h>
#include <dwmapi.h>       
#include <tlhelp32.h>     
#include "WebView2.h"
#include "ui_crypto.h"          
#include "appver.h"             
#include <winhttp.h>            

#include <atomic>
#include <cctype>      
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <intrin.h>   
#include <immintrin.h> 
#include <mutex>      
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")

static HINSTANCE g_hInst = nullptr;
static HWND      g_hwnd = nullptr;
static HWND      g_view = nullptr;      
static ICoreWebView2* g_webview = nullptr;
static ICoreWebView2Controller* g_controller = nullptr;
static ICoreWebView2Environment* g_env = nullptr;
static std::atomic<bool> g_running{true};

static HANDLE g_job = nullptr;

static std::string g_pending;           

static HWND      g_rvHwnd = nullptr;
static ICoreWebView2* g_rvWebview = nullptr;
static ICoreWebView2Controller* g_rvController = nullptr;
static std::string g_rvPending;         
static bool        g_rvCreating = false;

static void OpenReviewWindow(const std::string& recordJson);
static void ScheduleRvPrewarm(UINT ms);      
static void PrewarmReviewWindow();           
static void PostToRvPage(const std::string& json);
static void PostToPage(const std::string& json);

static void OpenVisWindow();
static void PostToVisPage(const std::string& json);
static void PostToVisPageSoon(const std::string& json);   
static void StartVisShotFlow();                           
static void RunVisionForVis(std::string req);             

static void FireTestHooks();

static void OpenUpdateWindow();

static const UINT_PTR kRvTimerTestOpen = 3;  

static HWND      g_visHwnd = nullptr;
static ICoreWebView2* g_visWebview = nullptr;
static ICoreWebView2Controller* g_visController = nullptr;
static std::string g_visPending;         
static bool        g_visCreating = false;
static bool        g_visShown = false;
static bool        g_visPageReady = false;
static std::vector<std::string> g_outboxVis;   

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

#ifdef GB_SUITE_ENGINE
#include <winhttp.h>
static void LogMsg(const std::string& s);        

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
  std::wstring root = ExeDir();                 
  std::wstring exe = Join(root, L"Web GomokuEngine.exe");
  if (!FileExists(exe)) {
    exe = Join(root, L"GomokuEngine.exe");
    if (!FileExists(exe)) { LogMsg("[deps] engine exe not found (Web GomokuEngine.exe / GomokuEngine.exe)"); return; }
  }
  
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
#endif  

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

static void LogMsg(const std::string& s);        
static DWORD g_bootT0 = 0;
static void LogBoot(const char* what) {
  char b[160];
  snprintf(b, sizeof(b), "[perf] %-24s %5lu ms", what,
           (unsigned long)(GetTickCount() - g_bootT0));
  LogMsg(b);
}

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

static const UINT_PTR kMainTimerOutbox = 6;       
static const UINT_PTR kMainTimerHook = 7;         

static const UINT kMsgFlushOutbox = WM_APP + 2;

static const UINT kMsgVisShot = WM_APP + 7;

static const UINT kMsgEngineFlush = WM_APP + 10;
static std::atomic<bool> g_engineFlushPending{false};
static std::atomic<bool> g_pushEngineOut{false};   
static void RequestEngineFlush() {
  if (!g_pushEngineOut.load()) return;
  if (g_engineFlushPending.exchange(true)) return;   
  if (g_hwnd && IsWindow(g_hwnd)) PostMessageW(g_hwnd, kMsgEngineFlush, 0, 0);
  else g_engineFlushPending = false;
}

static std::vector<std::string> g_outboxPage;
static std::vector<std::string> g_outboxRv;

static void PostToPageSoon(const std::string& json) {
  g_outboxPage.push_back(json);
  if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kMainTimerOutbox, 1, nullptr);
}
static void PostToRvPageSoon(const std::string& json) {
  g_outboxRv.push_back(json);
  if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kMainTimerOutbox, 1, nullptr);
}

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
        else if (c == 'u') p += 4;              
        else cur += c;
      } else cur += s[p];
    }
    if (p < s.size()) ++p;
    out.push_back(cur);
  }
  return out;
}

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

static int JsonIntAfter(const std::string& s, const char* key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return -1;
  p += strlen(key);
  while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) ++p;
  return atoi(s.c_str() + p);
}

static bool g_uiDark = true;
static COLORREF g_uiBg = RGB(0x26, 0x27, 0x2a);   
static COLORREF g_uiFg = RGB(0x9a, 0xa0, 0xa6);   
static std::wstring g_uiText = L"加载中…";
static bool g_mainPageShown = false;              
static const UINT_PTR kMainTimerReload = 5;       
static const UINT_PTR kMainTimerEval = 8;         

static const UINT_PTR kMainTimerSysMem = 9;
static const UINT kSysMemIntervalMs = 3000;
static int g_mainReloads = 0;                    
static std::wstring UiFile();

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
    if (d < 0) continue;                       
    val = (val << 6) | d;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back((unsigned char)((val >> bits) & 0xFF)); }
  }
  return out;
}

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
  
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_NOCHANGEDIR;
  if (!GetSaveFileNameW(&ofn)) return L"";
  return std::wstring(buf);
}
static std::wstring PickSavePath(const std::wstring& suggested, HWND owner) {
  return PickSavePathAs(suggested, owner,
                        L"PNG 图片 (*.png)\0*.png\0所有文件 (*.*)\0*.*\0", L"png", L"保存局面图片");
}

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

static bool TestFlag(const char* name) {
  char v[8] = {0};
  return GetEnvironmentVariableA(name, v, sizeof(v)) && v[0] == '1';
}

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
    path = Utf8ToWide(tv);                     
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

struct TxtSaveResult { bool ok; int n; std::wstring path; };

static TxtSaveResult SaveTxtFromPage(const std::string& s, HWND owner) {
  TxtSaveResult r = { false, 0, L"" };
  
  std::string name = JsonStrAfterDecoded(s, "\"name\":");
  std::string data = JsonStrAfterDecoded(s, "\"data\":");
  int n = JsonIntAfter(s, "\"n\":");
  r.n = (n < 0) ? 0 : n;
  if (name.empty()) name = "gomoku-history.txt";

  std::wstring path;
  char tv[1024] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_SAVE_TXT", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);                    
  } else {
    path = PickSavePathAs(Utf8ToWide(name), owner,
                          L"文本文件 (*.txt)\0*.txt\0所有文件 (*.*)\0*.*\0",
                          L"txt", L"导出历史（txt）");
  }
  if (path.empty()) { LogMsg("[hist] export cancelled by user"); return r; }

  FILE* f = _wfopen(path.c_str(), L"wb");
  if (!f) { LogMsg("[hist] cannot open for write: " + WideToUtf8(path)); return r; }
  
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

static std::string ReadTxtMessage(HWND owner) {
  std::wstring path;
  char tv[1024] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_OPEN_TXT", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);                    
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
  if (txt.size() > 4u * 1024 * 1024) txt.resize(4u * 1024 * 1024);   
  LogMsg("[hist] txt read: " + WideToUtf8(path) + " (" + std::to_string(txt.size()) + " bytes)");
  return "{\"type\":\"histTxt\",\"text\":" + JsonQuote(txt) + "}";
}

static void GdiplusEnsure() {
  static bool done = false;
  if (!done) {
    Gdiplus::GdiplusStartupInput si;
    ULONG_PTR tok = 0;
    GdiplusStartup(&tok, &si, nullptr);
    done = true;                     
  }
}

static bool FindPngEncoderClsid(CLSID* out) {
  UINT num = 0, size = 0;
  
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

static std::vector<unsigned char> EncodePngFromHbitmap(HBITMAP hb) {
  std::vector<unsigned char> png;
  GdiplusEnsure();
  CLSID clsid;
  if (FindPngEncoderClsid(&clsid)) {
    
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

static HWND g_visSelHwnd = nullptr;      
static bool g_uiLangEn = false;          
static std::wstring VshT(const wchar_t* zh, const wchar_t* en) {
  return std::wstring(g_uiLangEn ? en : zh);
}

static int VsDpi() {
  UINT d = GetDpiForSystem();
  return d >= 96 ? (int)d : 96;
}
static int VsS(int v) { return (int)((double)v * VsDpi() / 96.0 + 0.5); }

static const int kMainMinCssW = 680;    
static const int kMainMinCssH = 600;    
static const int kMainDefCssW = 1280;   
static const int kMainDefCssH = 820;    
static const int kVisMinCssW  = 840;    
static const int kVisMinCssH  = 660;

static int GbDpiFor(HWND h) {
  UINT d = h ? GetDpiForWindow(h) : 0;
  if (!d) d = GetDpiForSystem();
  return d >= 96 ? (int)d : 96;
}

static int GbPx(HWND h, int css) { return MulDiv(css, GbDpiFor(h), 96); }

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

static const wchar_t* BrandFontFace();   

static COLORREF VisUiBg()     { return g_uiDark ? RGB(38, 39, 42)    : RGB(246, 246, 244); }
static COLORREF VisUiBtn()    { return g_uiDark ? RGB(58, 59, 63)    : RGB(255, 255, 255); }
static COLORREF VisUiBtnHov() { return g_uiDark ? RGB(72, 73, 78)    : RGB(226, 243, 253); }
static COLORREF VisUiFg()     { return g_uiDark ? RGB(230, 231, 234) : RGB(45, 47, 50); }
static COLORREF VisUiBorder() { return g_uiDark ? RGB(70, 71, 76)    : RGB(210, 210, 206); }
static COLORREF VisSky()      { return RGB(79, 195, 247); }   

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

#define VSEL_TITLE_H (VsS(34))          
#define VSEL_GRIP    (VsS(18))          
#define VSEL_BTN_W   (VsS(96))          
#define VSEL_CLOSE_W (VsS(78))          
#define VSEL_AUTO_W  (VsS(92))          
#define VSEL_BTN_GAP (VsS(10))          
#define VSEL_EDGE    (VsS(10))          

enum { VSEL_NONE = 0, VSEL_MOVE, VSEL_L, VSEL_R, VSEL_T, VSEL_B,
       VSEL_TL, VSEL_TR, VSEL_BL, VSEL_BR,
       VSEL_BTN_SHOT = 100, VSEL_BTN_CLOSE = 101, VSEL_BTN_AUTO = 102 };

static bool g_vselAuto = true;
static RECT g_vselBtnAuto = { 0, 0, 0, 0 };
static std::atomic<bool> g_vselAutoBusy(false);
#define VSEL_WM_SNAP (WM_APP + 9)        

static HBITMAP g_vselBmp = nullptr;      
static unsigned char* g_vselBits = nullptr;
static int g_vselBmpW = 0, g_vselBmpH = 0;
static RECT g_vselBtnShot = { 0, 0, 0, 0 }, g_vselBtnClose = { 0, 0, 0, 0 };
static int g_vselBtnSpan = 0;           
static int g_vselDrag = VSEL_NONE;       
static double g_vselStep = 0;            
static int g_vselHoverBtn = VSEL_NONE;   
static int g_vselPressBtn = VSEL_NONE;   
static POINT g_vselDragPt = { 0, 0 };    
static RECT g_vselDragRect = { 0, 0, 0, 0 };  

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
    return VSEL_MOVE;                                 
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
  return VSEL_NONE;                                   
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
    bi.bmiHeader.biHeight = -H;               
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
  
  g.Clear(Gdiplus::Color(0, 0, 0, 0));

  const Gdiplus::Color sky(255, GetRValue(VisSky()), GetGValue(VisSky()), GetBValue(VisSky()));
  {   
    Gdiplus::SolidBrush tb(Gdiplus::Color(236, sky.GetRed(), sky.GetGreen(), sky.GetBlue()));
    g.FillRectangle(&tb, 0.0f, 0.0f, (Gdiplus::REAL)W, (Gdiplus::REAL)VSEL_TITLE_H);
    Gdiplus::Pen ul(Gdiplus::Color(120, 255, 255, 255), 1.0f);
    g.DrawLine(&ul, 0.0f, (Gdiplus::REAL)VSEL_TITLE_H - 0.5f,
               (Gdiplus::REAL)W, (Gdiplus::REAL)VSEL_TITLE_H - 0.5f);
  }
  
  {
    
    int bh = VsS(26), by = (VSEL_TITLE_H - VsS(26)) / 2;
    Gdiplus::FontFamily ff(BrandFontFace());   
    Gdiplus::Font f(&ff, (Gdiplus::REAL)VsS(16), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetAlignment(Gdiplus::StringAlignmentCenter);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    bool autoOn = g_vselAuto;
    
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
      bw[i] = (int)(m.Width + 0.999f) + VsS(22);      
      if (bw[i] < base[i]) bw[i] = base[i];
    }
    {   
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
    if (span > W - VsS(4)) {                          
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
  
  {
    Gdiplus::FontFamily ff(BrandFontFace());
    Gdiplus::Font f(&ff, (Gdiplus::REAL)VsS(17), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::SolidBrush b(Gdiplus::Color(255, 10, 54, 74));
    
    const wchar_t* cands[3] = {
      g_uiLangEn ? L"Drag · Shot" : L"拖到棋盘 · 点截图",
      g_uiLangEn ? L"Shot"        : L"拖到棋盘",
      g_uiLangEn ? L""            : L"截图",
    };
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::REAL room = (Gdiplus::REAL)(g_vselBtnAuto.left - VsS(8));
    for (int i = 0; i < 3; ++i) {
      if (!cands[i][0]) break;                       
      Gdiplus::RectF msz;
      g.MeasureString(cands[i], -1, &f, Gdiplus::PointF(0, 0), &sf, &msz);
      if (VsS(12) + msz.Width <= room) {
        g.DrawString(cands[i], -1, &f, Gdiplus::PointF((Gdiplus::REAL)VsS(12),
                     (Gdiplus::REAL)(VSEL_TITLE_H / 2)), &sf, &b);
        break;
      }
    }
  }
  
  {
    Gdiplus::Pen pen(sky, (Gdiplus::REAL)VsS(3));
    g.DrawRectangle(&pen, 1.0f, (Gdiplus::REAL)VSEL_TITLE_H + 1.0f,
                    (Gdiplus::REAL)(W - 2), (Gdiplus::REAL)(H - VSEL_TITLE_H - 2));
    Gdiplus::SolidBrush hb(sky);
    const int hs = VsS(12);     
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

static void VselShot(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + VSEL_TITLE_H;          
  RECT rc = { wr.left, top, wr.right, wr.bottom };
  if (rc.right - rc.left < 24 || rc.bottom - rc.top < 24) return;   
  LogMsg("[vis] hollow select confirm: screen (" + std::to_string(rc.left) + "," +
         std::to_string(rc.top) + ") " + std::to_string(rc.right - rc.left) + "x" +
         std::to_string(rc.bottom - rc.top));
  
  VisShotDeliver(rc);
}

static std::wstring FindVisionExe();                       

static bool VisionHttpScanImage(const unsigned char* img, int len, std::string& out);
static bool VisionScanImage(const unsigned char* img, int len, std::string& out);
static bool VisionRecognize(const unsigned char* img, int len, int size, bool nosnap,
                            std::string& out);

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
  if (v[2] < 150 || v[3] < 150) return false;          
  double aspect = v[2] / v[3];
  if (aspect < 0.5 || aspect > 2.0) return false;      
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

static void VselAutoScan(HWND h) {
  if (g_vselAutoBusy.exchange(true)) return;
  std::thread([h] {
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    RECT rc = { vx, vy, vx + vw, vy + vh };
    std::vector<unsigned char> png = CaptureRectPng(rc);
    do {
      if (png.empty()) break;
      std::string out;
      
      if (!VisionScanImage(png.data(), (int)png.size(), out)) {
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
        
        BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                                 CREATE_NO_WINDOW, nullptr, cwd.c_str(), &si, &pi);
        CloseHandle(wr);
        if (!ok) { CloseHandle(rd); DeleteFileW(imgPath.c_str()); break; }
        CloseHandle(pi.hThread);
        if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);   
        char buf[4096];
        DWORD n = 0;
        while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
        CloseHandle(rd);
        if (WaitForSingleObject(pi.hProcess, 15000) != WAIT_OBJECT_0)
          TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        DeleteFileW(imgPath.c_str());
      }
      RECT br;
      double step = 0;
      if (VselScanRect(out, br, step)) {
        g_vselStep = step;                   
        br.left += vx; br.right += vx; br.top += vy; br.bottom += vy;   
        RECT* rp = new RECT(br);
        if (!PostMessageW(h, VSEL_WM_SNAP, 0, (LPARAM)rp)) delete rp;   
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
        
        int minW = VsS(330), minH = VSEL_TITLE_H + VsS(60);
        
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
            g_vselAuto = !g_vselAuto;        
            LogMsg(std::string("[vis] auto snap ") + (g_vselAuto ? "on" : "off"));
            if (g_vselAuto) VselAutoScan(h); 
            VselPaint(h);
            return 0;
          }
          if (pressed == VSEL_BTN_SHOT) {
            VselShot(h);                     
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
      
      RECT* rp = (RECT*)lp;
      if (!rp) return 0;
      RECT b = *rp;
      delete rp;
      if (!g_vselAuto || g_vselDrag != VSEL_NONE) return 0;
      
      LONG bw = b.right - b.left, bh = b.bottom - b.top;
      double step = (g_vselStep > 0) ? g_vselStep : (double)bw / 14.0;
      int pad = (int)(step * 0.6 + 0.5);
      if (pad < 6) pad = 6;
      LONG x = b.left - pad, y = b.top - pad - VSEL_TITLE_H;
      LONG w = bw + pad * 2;
      LONG hh = bh + pad * 2 + VSEL_TITLE_H;
      int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
      int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
      if (y < vy) y = vy;                      
      if (x < vx) { w -= (vx - x); x = vx; }   
      if (y + hh > vy + vh) hh = vy + vh - y;
      if (x + w > vx + vw) w = vx + vw - x;
      RECT cur;
      GetWindowRect(h, &cur);
      int dx = cur.left - x, dy = cur.top - y;
      int dw = (cur.right - cur.left) - (int)w, dh = (cur.bottom - cur.top) - (int)hh;
      if (dx > -6 && dx < 6 && dy > -6 && dy < 6 &&
          dw > -6 && dw < 6 && dh > -6 && dh < 6)
        return 0;                              
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

static void RunVisHollowSelect() {
  
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
  int w = VsS(480), h = VsS(360) + VSEL_TITLE_H;     
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
  SetTimer(g_visSelHwnd, 1, 1200, nullptr);   
  LogMsg("[vis] hollow select opened (drag title to move, edges to resize, ESC to cancel)");
  MSG msg;
  while (IsWindow(g_visSelHwnd) && GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  LogMsg("[vis] hollow select loop ended");
}

static void StartVisShotFlow() {
  LogMsg("[vis] screenshot requested (hollow select)");
  if (g_visSelHwnd && IsWindow(g_visSelHwnd)) return;   
  RunVisHollowSelect();
}

static std::wstring FindVisionExe() {
  
  std::wstring sub = Join(Join(ExeDir(), L"Vision"), L"GomokuVision.exe");
  if (FileExists(sub)) return sub;
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

namespace {

struct VisHttpCtx {
  CRITICAL_SECTION cs;
  HINTERNET session = nullptr;
  VisHttpCtx() { InitializeCriticalSection(&cs); }
  ~VisHttpCtx() {
    if (session) WinHttpCloseHandle(session);
    DeleteCriticalSection(&cs);
  }
};
VisHttpCtx g_visHttp;                             

struct VisEndpoint {
  int port = 0;
  HINTERNET conn = nullptr;                       
};
VisEndpoint g_visEp[3];                           

HINTERNET VisHttpSession() {
  EnterCriticalSection(&g_visHttp.cs);
  if (!g_visHttp.session)
    g_visHttp.session = WinHttpOpen(L"gbcalc-vis", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  HINTERNET s = g_visHttp.session;
  LeaveCriticalSection(&g_visHttp.cs);
  return s;
}

HINTERNET VisHttpConnFor(int port, bool forceNew) {
  EnterCriticalSection(&g_visHttp.cs);
  if (forceNew) {
    for (auto& e : g_visEp) {
      if (e.port == port && e.conn) { WinHttpCloseHandle(e.conn); e.conn = nullptr; e.port = 0; }
    }
  } else {
    for (auto& e : g_visEp) {
      if (e.port == port && e.conn) { LeaveCriticalSection(&g_visHttp.cs); return e.conn; }
    }
  }
  HINTERNET c = g_visHttp.session
      ? WinHttpConnect(g_visHttp.session, L"127.0.0.1", (INTERNET_PORT)port, 0)
      : nullptr;
  if (c) {
    bool stored = false;
    for (auto& e : g_visEp) {
      if (!e.conn) { e.port = port; e.conn = c; stored = true; break; }
    }
    if (!stored) {          
      if (g_visEp[0].conn) WinHttpCloseHandle(g_visEp[0].conn);
      g_visEp[0].port = port;
      g_visEp[0].conn = c;
    }
  }
  LeaveCriticalSection(&g_visHttp.cs);
  return c;
}

static bool VisHttpOnceLocked(HINTERNET conn, const wchar_t* method, const wchar_t* path,
                              const std::string& body, const wchar_t* hdr, const DWORD t4[4],
                              int* statusOut, std::string& out);

bool VisHttpOnce(HINTERNET conn, const wchar_t* method, const wchar_t* path,
                 const std::string& body, const wchar_t* hdr, const DWORD t4[4],
                 int* statusOut, std::string& out) {
  
  EnterCriticalSection(&g_visHttp.cs);
  bool ok = VisHttpOnceLocked(conn, method, path, body, hdr, t4, statusOut, out);
  LeaveCriticalSection(&g_visHttp.cs);
  return ok;
}

static bool VisHttpOnceLocked(HINTERNET conn, const wchar_t* method, const wchar_t* path,
                              const std::string& body, const wchar_t* hdr, const DWORD t4[4],
                              int* statusOut, std::string& out) {
  out.clear();
  HINTERNET r = WinHttpOpenRequest(conn, method, path, nullptr, WINHTTP_NO_REFERER,
                                   WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
  if (!r) return false;
  WinHttpSetTimeouts(r, t4[0], t4[1], t4[2], t4[3]);   
  BOOL sent;
  if (body.empty()) {
    sent = WinHttpSendRequest(r, hdr, hdr ? -1L : 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
  } else {
    sent = WinHttpSendRequest(r, hdr, hdr ? -1L : 0, (LPVOID)body.data(),
                              (DWORD)body.size(), (DWORD)body.size(), 0);
  }
  bool ok = false;
  if (sent && WinHttpReceiveResponse(r, nullptr)) {
    if (statusOut) {
      DWORD code = 0, len = sizeof(code);
      WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                          WINHTTP_HEADER_NAME_BY_INDEX, &code, &len, WINHTTP_NO_HEADER_INDEX);
      *statusOut = (int)code;
    }
    ok = true;
    for (;;) {
      DWORD avail = 0;
      if (!WinHttpQueryDataAvailable(r, &avail) || !avail) break;
      std::vector<char> buf(avail);
      DWORD got = 0;
      if (!WinHttpReadData(r, buf.data(), avail, &got) || !got) { ok = false; break; }
      out.append(buf.data(), got);
    }
  }
  WinHttpCloseHandle(r);
  return ok;
}

std::string VisHttpRequest(int port, const wchar_t* method, const wchar_t* path,
                           const std::string& body, const wchar_t* hdr, const DWORD t4[4],
                           int* statusOut) {
  std::string out;
  if (!VisHttpSession()) return out;
  for (int attempt = 0; attempt < 2; ++attempt) {
    HINTERNET conn = VisHttpConnFor(port, attempt > 0);
    if (!conn) break;
    int code = 0;
    if (VisHttpOnce(conn, method, path, body, hdr, t4, &code, out)) {
      if (statusOut) *statusOut = code;
      return out;
    }
    out.clear();
  }
  return out;
}

const DWORD* VisTimeoutHealth() {
  static const DWORD t[4] = {250, 250, 250, 250};
  return t;
}
const DWORD* VisTimeoutData() {
  static const DWORD t[4] = {2000, 2000, 15000, 15000};
  return t;
}

}  

static int VisionRecogPort() {
  static int p = 0;
  if (p) return p;
  char v[16] = {0};
  if (GetEnvironmentVariableA("GB_RECOG_PORT", v, sizeof(v)) && v[0]) {
    int n = atoi(v);
    if (n >= 1024 && n <= 65535) p = n;
  }
  if (!p) p = 8974;
  return p;
}
static int VisionScanPort() {
  static int p = 0;
  if (p) return p;
  char v[16] = {0};
  if (GetEnvironmentVariableA("GB_SCAN_PORT", v, sizeof(v)) && v[0]) {
    int n = atoi(v);
    if (n >= 1024 && n <= 65535) p = n;
  }
  if (!p) p = 8975;
  return p;
}

static bool VisionPortAlive(int port) {
  int code = 0;
  VisHttpRequest(port, L"GET", L"/health", std::string(), nullptr, VisTimeoutHealth(), &code);
  return code == 200;
}

static std::string VisionHttpPost(int port, const wchar_t* path, const std::string& body,
                                  const wchar_t* hdr, int* statusOut = nullptr) {
  return VisHttpRequest(port, L"POST", path, body, hdr, VisTimeoutData(), statusOut);
}

static void VisionSpawnDetached(const std::wstring& exe, const std::wstring& cwd) {
  std::wstring cmd = L"\"" + exe + L"\"";
  STARTUPINFOW si; ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
  PROCESS_INFORMATION pi; ZeroMemory(&pi, sizeof(pi));
  std::vector<wchar_t> buf(cmd.begin(), cmd.end()); buf.push_back(0);
  
  if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE,
                     CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr,
                     cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
    CloseHandle(pi.hThread);
    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);   
    CloseHandle(pi.hProcess);
  } else {
    LogMsg("[vis] vision service spawn failed err=" + std::to_string(GetLastError()));
  }
}

static std::atomic<unsigned long long> g_visSpawnedAt(0);
static void EnsureVisionServer() {
  static std::atomic<int> seenAlive(0);
  static std::atomic<int> restarts(0);
  
  {
    static bool envPinned = false;
    if (!envPinned) {
      envPinned = true;
      SetEnvironmentVariableA("GB_RECOG_PORT", std::to_string(VisionRecogPort()).c_str());
      SetEnvironmentVariableA("GB_SCAN_PORT", std::to_string(VisionScanPort()).c_str());
      SetEnvironmentVariableA("GB_PARENT_PID", std::to_string(GetCurrentProcessId()).c_str());
    }
  }
  bool scanAlive = VisionPortAlive(VisionScanPort());
  bool recogAlive = VisionPortAlive(VisionRecogPort());
  if (scanAlive && recogAlive) {
    if (seenAlive.exchange(1) == 0) {
      static std::atomic<bool> told(false);
      if (!told.exchange(true))
        LogMsg("[vis] vision service :" + std::to_string(VisionRecogPort()) + "/:" +
               std::to_string(VisionScanPort()) + " already running, reusing it");
    }
    return;
  }
  if (seenAlive.exchange(0) == 1) {
    LogMsg("[vis] vision service went down (scan=" + std::string(scanAlive ? "up" : "down") +
           " recog=" + std::string(recogAlive ? "up" : "down") + ") -> restarting (restart #" +
           std::to_string(restarts.load() + 1) + ")");
  }
  std::wstring exe = FindVisionExe();
  if (exe.empty()) { LogMsg("[vis] GomokuVision.exe not found, cannot start vision service"); return; }
  unsigned long long now = GetTickCount64(), cur = g_visSpawnedAt.load();
  for (;;) {
    if (now - cur < 25000) return;                        
    if (g_visSpawnedAt.compare_exchange_weak(cur, now)) break;
  }
  std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\/"));
  LogMsg("[vis] starting vision service GomokuVision.exe (both :" +
         std::to_string(VisionRecogPort()) + "/:" + std::to_string(VisionScanPort()) + ")");
  VisionSpawnDetached(exe, cwd);
  restarts.fetch_add(1);
}

static std::atomic<bool> g_visPrewarmStarted{ false };
static void PrewarmVisionServiceAsync() {
  bool expect = false;
  if (!g_visPrewarmStarted.compare_exchange_strong(expect, true)) return;
  std::thread([] {
    EnsureVisionServer();
    for (int i = 0; i < 40; ++i) {                        
      if (VisionPortAlive(VisionRecogPort()) && VisionPortAlive(VisionScanPort())) {
        LogMsg("[vis] prewarmed (vision service ready before first recognize)");
        return;
      }
      Sleep(300);
    }
    LogMsg("[vis] prewarm: service not ready in 12s (first recognize will retry)");
  }).detach();
}

static bool VisionHttpScanImage(const unsigned char* img, int len, std::string& out) {
  if (TestFlag("GB_NO_VISION_HTTP")) return false;
  EnsureVisionServer();
  int code = 0;
  std::string resp = VisionHttpPost(VisionScanPort(), L"/scan-image",
                                    std::string((const char*)img, (size_t)len),
                                    L"Content-Type: application/octet-stream", &code);
  if (code != 200) return false;
  if (resp.empty() || resp[0] != '{') return false;
  if (resp.find("\"found\"") == std::string::npos) return false;
  out = std::move(resp);
  return true;
}

static bool VisionHttpRecognize(const unsigned char* img, int len, int size, bool nosnap,
                                std::string& out) {
  if (TestFlag("GB_NO_VISION_HTTP")) return false;
  EnsureVisionServer();
  std::string body = "{\"image\":\"" + Base64Encode(std::vector<unsigned char>(img, img + len)) +
                     "\",\"size\":" + std::to_string(size) +
                     (nosnap ? ",\"nosnap\":true" : "") + "}";
  int code = 0;
  std::string resp = VisionHttpPost(VisionRecogPort(), L"/recognize", body,
                                    L"Content-Type: application/json", &code);
  if (code != 200) return false;
  if (resp.empty() || resp[0] != '{') return false;
  if (resp.find("\"black\"") == std::string::npos) return false;
  out = std::move(resp);
  return true;
}

namespace {

constexpr DWORD kVisPipeShmSize = 64u * 1024 * 1024;   
constexpr unsigned char VISOP_SCAN_IMAGE = 3;           
constexpr unsigned char VISOP_RECOGNIZE = 4;

struct VisPipeCtx {
  CRITICAL_SECTION cs;
  HANDLE pipe = nullptr;        
  bool hello = false;           
  HANDLE shm = nullptr;         
  void* view = nullptr;
  std::wstring shmName;         
  VisPipeCtx() { InitializeCriticalSection(&cs); }
  ~VisPipeCtx() {
    if (view) UnmapViewOfFile(view);
    if (shm) CloseHandle(shm);
    if (pipe) { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
    DeleteCriticalSection(&cs);
  }
};
VisPipeCtx g_vpipe[2];          

bool VisPipeIo(HANDLE h, void* buf, DWORD n, bool write) {
  char* p = (char*)buf;
  while (n > 0) {
    DWORD x = 0;
    if (!(write ? WriteFile(h, p, n, &x, nullptr) : ReadFile(h, p, n, &x, nullptr)) || x == 0)
      return false;
    p += x; n -= x;
  }
  return true;
}

bool VisPipeFrame(HANDLE h, unsigned char opcode, const void* payload, unsigned len, bool write) {
  unsigned char hdr[12];
  memcpy(hdr, "GBV1", 4);
  memcpy(hdr + 4, &opcode, 4);
  memcpy(hdr + 8, &len, 4);
  if (!VisPipeIo(h, hdr, 12, write)) return false;
  if (len && !VisPipeIo(h, (void*)payload, len, write)) return false;
  return true;
}

bool VisPipeConnect(VisPipeCtx& c, int idx) {
  
  wchar_t name[64];
  swprintf_s(name, L"\\\\.\\pipe\\GomokuVision.%s.%d",
             (idx == 0) ? L"recognize" : L"scan",
             (idx == 0) ? VisionRecogPort() : VisionScanPort());
  HANDLE h = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                         OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) { c.pipe = nullptr; c.hello = false; return false; }
  c.pipe = h;
  
  unsigned char hdr[12];
  if (!VisPipeFrame(h, 1, nullptr, 0, true) ||          
      !VisPipeIo(h, hdr, 12, false) ||
      memcmp(hdr, "GBV1", 4) != 0) {                    
    DisconnectNamedPipe(h); CloseHandle(h); c.pipe = nullptr; c.hello = false;
    return false;
  }
  unsigned plen = 0;
  memcpy(&plen, hdr + 8, 4);
  unsigned char pl[512];
  if (plen != 8 || plen > sizeof(pl) ||
      !VisPipeIo(h, pl, plen, false)) {                 
    DisconnectNamedPipe(h); CloseHandle(h); c.pipe = nullptr; c.hello = false;
    return false;
  }
  unsigned ver = 0, ready = 0;
  memcpy(&ver, pl, 4);
  memcpy(&ready, pl + 4, 4);
  if (ver != 1 || !ready) {                         
    DisconnectNamedPipe(h); CloseHandle(h); c.pipe = nullptr; c.hello = false;
    return false;
  }
  c.hello = true;
  return true;
}

bool VisPipeEnsureShm(VisPipeCtx& c) {
  if (c.shm && c.view) return true;
  wchar_t name[64];
  swprintf_s(name, L"GBV_SHM_%lu", (unsigned long)GetCurrentProcessId());
  HANDLE s = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                0, kVisPipeShmSize, name);
  if (!s) return false;
  void* v = MapViewOfFile(s, FILE_MAP_WRITE, 0, 0, 0);
  if (!v) { CloseHandle(s); return false; }
  c.shm = s; c.view = v; c.shmName = name;
  return true;
}

bool VisPipeCall(int idx, unsigned char opcode, const unsigned char* img, int imgLen,
                 const std::string& extra, std::string& out) {
  VisPipeCtx& c = g_vpipe[idx];
  EnterCriticalSection(&c.cs);
  bool ok = false;
  std::string resp;
  if (VisPipeEnsureShm(c) && imgLen > 0 && (DWORD)imgLen <= kVisPipeShmSize) {
    for (int attempt = 0; attempt < 2 && !ok; ++attempt) {     
      if (!c.pipe && !VisPipeConnect(c, idx)) break;
      
      std::string nameUtf8;
      for (size_t i = 0; i < c.shmName.size(); ++i)
        nameUtf8.push_back((char)(c.shmName[i] & 0xFF));       
      std::vector<unsigned char> pl;
      unsigned nameLen = (unsigned)nameUtf8.size();
      const unsigned char* nm = (const unsigned char*)nameUtf8.data();
      pl.insert(pl.end(), (unsigned char*)&nameLen, (unsigned char*)&nameLen + 4);
      pl.insert(pl.end(), nm, nm + nameLen);
      unsigned off = 0, ilen = (unsigned)imgLen;
      pl.insert(pl.end(), (unsigned char*)&off, (unsigned char*)&off + 4);
      pl.insert(pl.end(), (unsigned char*)&ilen, (unsigned char*)&ilen + 4);
      if (opcode == VISOP_RECOGNIZE) {
        unsigned elen = (unsigned)extra.size();
        pl.insert(pl.end(), (unsigned char*)&elen, (unsigned char*)&elen + 4);
        if (elen) pl.insert(pl.end(), extra.begin(), extra.end());
      }
      
      memcpy(c.view, img, imgLen);
      unsigned char hdr[12];
      if (VisPipeFrame(c.pipe, opcode, pl.data(), (unsigned)pl.size(), true) &&
          VisPipeIo(c.pipe, hdr, 12, false) && memcmp(hdr, "GBV1", 4) == 0) {
        unsigned plen = 0;
        memcpy(&plen, hdr + 8, 4);
          if (plen >= 8 && plen <= 64u * 1024 * 1024) {
            std::vector<unsigned char> rp(plen);
            if (VisPipeIo(c.pipe, rp.data(), plen, false)) {
              unsigned status = 0, rlen = 0;
              memcpy(&status, rp.data(), 4);
              memcpy(&rlen, rp.data() + 4, 4);
              if (status == 0 && rlen + 8 == plen) {
                resp.assign((const char*)rp.data() + 8, rlen);
                ok = true;
              } else if (status == 2) {
                break;                                          
              }
            }
          }
        }
      if (!ok) {                                                
        DisconnectNamedPipe(c.pipe); CloseHandle(c.pipe);
        c.pipe = nullptr; c.hello = false;
      }
    }
  }
  if (ok) out = std::move(resp);
  LeaveCriticalSection(&c.cs);
  return ok;
}

}  

static bool VisionScanImage(const unsigned char* img, int len, std::string& out) {
  if (TestFlag("GB_NO_VISION_HTTP")) return false;
  if (len > 0 && VisPipeCall(1, VISOP_SCAN_IMAGE, img, len, std::string(), out)) return true;
  return VisionHttpScanImage(img, len, out);
}

static bool VisionRecognize(const unsigned char* img, int len, int size, bool nosnap,
                            std::string& out) {
  if (TestFlag("GB_NO_VISION_HTTP")) return false;
  std::string extra = std::string("{\"size\":") + std::to_string(size) +
                      (nosnap ? ",\"nosnap\":true" : "") + "}";
  if (len > 0 && VisPipeCall(0, VISOP_RECOGNIZE, img, len, extra, out)) return true;
  return VisionHttpRecognize(img, len, size, nosnap, out);
}

static void OpenImageFromPage(const std::string& s) {
  std::string data = JsonStrAfter(s, "\"data\":");
  std::string ext = JsonStrAfter(s, "\"ext\":");
  int idx = JsonIntAfter(s, "\"idx\":");
  for (size_t i = 0; i < ext.size(); i++) {         
    char ch = ext[i];
    if (ch >= 'A' && ch <= 'Z') ext[i] = (char)(ch - 'A' + 'a');
  }
  if (ext.empty() || ext.size() > 5 ||
      ext.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789") != std::string::npos) {
    ext = "png";                                  
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

static void RunVisionForVis(std::string req) {
  std::string mode = JsonStrAfter(req, "\"mode\":");
  std::string data = JsonStrAfter(req, "\"data\":");
  std::string seq = JsonStrAfter(req, "\"seq\":");     
  
  std::string nosnap = JsonStrAfter(req, "\"nosnap\":");
  bool skipSnap = nosnap.find("true") != std::string::npos;
  for (size_t i = 0; i < seq.size();) {                
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

  {
    int boardSize = JsonIntAfter(req, "\"size\":");
    if (boardSize < 9 || boardSize > 25) boardSize = 15;   
    std::string http;
    bool ok = false;
    if (mode == "scan")
      ok = VisionScanImage(bytes.data(), (int)bytes.size(), http);
    else
      ok = VisionRecognize(bytes.data(), (int)bytes.size(), boardSize, skipSnap, http);
    if (ok) {
      LogMsg("[vis] recognize ok (" + std::to_string(http.size()) +
             " bytes, mode=" + mode + ")");
      PostToVisPageSoon("{\"type\":\"visResult\",\"mode\":\"" + mode +
                        (seq.empty() ? "" : "\",\"seq\":" + seq) +
                        "\",\"result\":" + http + "}");
      return;
    }
    LogMsg("[vis] http path unavailable -> spawn fallback (mode=" + mode + ")");
  }

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
  
  std::wstring cmd = L"\"" + exe + L"\" " +
                     (mode == "scan" ? L"--scan-image" : L"--recognize-image") +
                     L" \"" + imgPath + L"\"" +
                     (skipSnap ? L" --nosnap" : L"");
  std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end()); cmdBuf.push_back(0);

  SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) { fail("cannot create pipe"); return; }
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);     
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr;
  si.hStdError = wr;
  PROCESS_INFORMATION pi = {};
  std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\/"));
  
  BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW, nullptr, cwd.c_str(), &si, &pi);
  CloseHandle(wr);                       
  if (!ok) { CloseHandle(rd); fail("spawn failed"); DeleteFileW(imgPath.c_str()); return; }
  CloseHandle(pi.hThread);

  std::string out;
  char buf[4096];
  DWORD n = 0;
  while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
  CloseHandle(rd);
  
  DWORD wait = WaitForSingleObject(pi.hProcess, 10000);
  if (wait != WAIT_OBJECT_0) TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hProcess);
  DeleteFileW(imgPath.c_str());

  while (!out.empty() && (unsigned char)out.front() <= ' ') out.erase(0, 1);
  while (!out.empty() && (unsigned char)out.back() <= ' ') out.pop_back();
  if (out.empty() || out[0] != '{') { fail("no recognizer output"); return; }
  LogMsg("[vis] recognize ok (" + std::to_string(out.size()) + " bytes, mode=" + mode + ")");
  PostToVisPageSoon("{\"type\":\"visResult\",\"mode\":\"" + mode +
                    (seq.empty() ? "" : "\",\"seq\":" + seq) +
                    "\",\"result\":" + out + "}");
}

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

static int        g_threads = 0;      
static int        g_hashMB = 0;       

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

static int MemTotalMB() {
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms) && ms.ullTotalPhys > 0)
    return (int)(ms.ullTotalPhys / (1024ull * 1024ull));
  return 4096;
}

static int MemAvailMB() {
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  if (GlobalMemoryStatusEx(&ms) && ms.ullAvailPhys > 0)
    return (int)(ms.ullAvailPhys / (1024ull * 1024ull));
  return MemTotalMB() / 2;
}

static std::string CpuName() {
  HKEY hk = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                    L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                    0, KEY_READ, &hk) != ERROR_SUCCESS || !hk)
    return "";
  wchar_t buf[256] = {0};
  DWORD sz = sizeof(buf), ty = 0;
  LONG r = RegQueryValueExW(hk, L"ProcessorNameString", nullptr, &ty, (LPBYTE)buf, &sz);
  RegCloseKey(hk);
  if (r != ERROR_SUCCESS || ty != REG_SZ) return "";
  std::string v = WideToUtf8(buf);
  
  std::string o;
  bool sp = false;
  for (size_t i = 0; i < v.size(); ++i) {
    unsigned char c = (unsigned char)v[i];
    if (c == ' ' || c == '	') { if (!o.empty()) sp = true; continue; }
    if (sp) { o += ' '; sp = false; }
    o += (char)c;
  }
  return o;
}

static int PhysCoreCount() {
  DWORD len = 0;
  if (!GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &len)) {
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) return (int)std::thread::hardware_concurrency();
  }
  std::vector<char> buf(len ? len : 4096);
  if (!GetLogicalProcessorInformationEx(RelationProcessorCore,
                                        (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)buf.data(), &len))
    return (int)std::thread::hardware_concurrency();
  int cores = 0;
  DWORD off = 0;
  while (off < len) {
    PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX pi =
        (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)(buf.data() + off);
    if (pi->Relationship == RelationProcessorCore) cores++;
    off += pi->Size;
  }
  if (cores < 1) return (int)std::thread::hardware_concurrency();
  return cores;
}

static LONG RegDword(HKEY root, const wchar_t* sub, const wchar_t* val, DWORD& out) {
  HKEY hk = nullptr;
  if (RegOpenKeyExW(root, sub, 0, KEY_READ, &hk) != ERROR_SUCCESS || !hk) return -1;
  DWORD v = 0, sz = sizeof(v), ty = 0;
  LONG r = RegQueryValueExW(hk, val, nullptr, &ty, (LPBYTE)&v, &sz);
  RegCloseKey(hk);
  if (r == ERROR_SUCCESS) out = v;
  return r;
}

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

static std::string g_inboxSeen;

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

static void SendAll(SOCKET cs, const char* p, int n) {
  while (n > 0) {
    int k = send(cs, p, n, 0);
    if (k <= 0) return;
    p += k; n -= k;
  }
}

static std::string NativeEngineRouteJson(const std::string& route, const std::string& query,
                                         const std::string& reqBody);
namespace nativeeng {

static const int LANE_COUNT = 3;

struct Engine {
  HANDLE    hProcess = nullptr;    
  HANDLE    hStdin    = nullptr;
  HANDLE    hStdout   = nullptr;   
  std::mutex mu;                   
  std::mutex spawnMu;              
  std::deque<std::string> lines;   
  uint64_t  seq       = 0;         
  uint64_t  dropped   = 0;         
  std::atomic<bool> alive{false};  
  std::atomic<int>  gen{0};        
};

static Engine      g_eng[LANE_COUNT];
static std::string g_laneName[LANE_COUNT] = {"main", "sub", "fwd"};

static bool    g_probed  = false;   
static bool    g_avail   = false;   

static std::string g_diag;
static std::string g_badVariant;
static std::string g_variant;       
static std::wstring g_dir;          

static void EnsureJob() {
  if (g_job) return;
  g_job = CreateJobObjectW(nullptr, nullptr);
  if (!g_job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {};
  jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
    CloseHandle(g_job);
    g_job = nullptr;
  }
}

void CloseJobHandle() { if (g_job) { CloseHandle(g_job); g_job = nullptr; } }

static void ShutdownAllEngines() {
  for (int i = 0; i < LANE_COUNT; i++) {
    Engine& e = g_eng[i];
    std::lock_guard<std::mutex> lk(e.spawnMu);
    if (!e.hProcess) {
      if (e.hStdin) { CloseHandle(e.hStdin); e.hStdin = nullptr; }
      continue;
    }
    if (e.hStdin) { CloseHandle(e.hStdin); e.hStdin = nullptr; }  
    if (WaitForSingleObject(e.hProcess, 800) != WAIT_OBJECT_0)
      TerminateProcess(e.hProcess, 0);
    CloseHandle(e.hProcess);
    e.hProcess = nullptr;
  }
  
}

static int LaneIndex(const std::string& name) {
  for (int i = 0; i < LANE_COUNT; i++) if (g_laneName[i] == name) return i;
  return -1;
}

struct CpuCaps {
  bool sse = false, avx2 = false, avx512f = false, avx512vnni = false, avxvnni = false;
};

static CpuCaps CpuIdCaps() {
  CpuCaps c;
  c.sse = true;                                  
  int r[4] = {0, 0, 0, 0};
  __cpuidex(r, 0, 0);
  if (r[0] < 1) return c;
  __cpuidex(r, 1, 0);
  bool osxsave = (r[2] & (1 << 27)) != 0;        
  bool avxSup  = (r[2] & (1 << 28)) != 0;        
  unsigned long long xcr0 = osxsave ? _xgetbv(0) : 0;
  bool xmmYmm = osxsave && (xcr0 & 0x06) == 0x06;          
  bool zmm    = osxsave && (xcr0 & 0xE6) == 0xE6;          
  if (r[0] < 7) return c;
  __cpuidex(r, 7, 0);
  bool avx2bit = (r[1] >> 5) & 1;
  bool f512 = (r[1] >> 16) & 1, dq = (r[1] >> 17) & 1, bw = (r[1] >> 30) & 1, vl = (r[1] >> 31) & 1;
  bool v512 = (r[2] >> 11) & 1;                            
  c.avx2       = avxSup && xmmYmm && avx2bit;
  c.avx512f    = c.avx2 && zmm && f512 && dq && bw && vl;
  c.avx512vnni = c.avx512f && v512;
  __cpuidex(r, 7, 1);                                      
  c.avxvnni    = c.avx2 && (((unsigned)r[0] >> 4) & 1) != 0;
  return c;
}

static std::string CpuFingerprint() {
  int r[4] = {0, 0, 0, 0};
  __cpuidex(r, 0, 0);
  unsigned vendor[3] = {(unsigned)r[1], (unsigned)r[3], (unsigned)r[2]};   
  unsigned maxLeaf = (unsigned)r[0];
  unsigned sig = 0, feat7 = 0, feat7c = 0, feat7_1 = 0;
  if (maxLeaf >= 1) { __cpuidex(r, 1, 0); sig = (unsigned)r[0]; }          
  if (maxLeaf >= 7) {
    __cpuidex(r, 7, 0);
    feat7 = (unsigned)r[1]; feat7c = (unsigned)r[2];
    __cpuidex(r, 7, 1); feat7_1 = (unsigned)r[0];
  }
  SYSTEM_INFO si = {};
  GetSystemInfo(&si);
  char b[192];
  snprintf(b, sizeof(b), "%08X%08X%08X-%08X-%08X%08X-%08X-%u",
           vendor[0], vendor[1], vendor[2], sig, feat7, feat7c, feat7_1,
           (unsigned)si.dwNumberOfProcessors);
  return std::string(b);
}

static const char* kVariantOrder[] = {"avx512vnni", "avxvnni", "avx512", "avx2", "sse"};

static bool VariantCpuOk(const std::string& v, const CpuCaps& c) {
  if (v == "avx512vnni") return c.avx512vnni;
  if (v == "avxvnni")    return c.avxvnni;
  if (v == "avx512")     return c.avx512f;
  if (v == "avx2")       return c.avx2;
  return true;                                   
}

static bool SmokeVariantOk(const std::wstring& dir, const std::string& name) {
  std::wstring exe = Join(dir, std::wstring(L"RapfiEngine-") + Utf8ToWide(name) + L".exe");
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
  si.hStdInput = inR; si.hStdOutput = outW; si.hStdError = outW;
  PROCESS_INFORMATION pi = {};
  std::wstring cmd = L"\"" + exe + L"\"";
  std::vector<wchar_t> cbuf(cmd.begin(), cmd.end());
  cbuf.push_back(0);
  if (!CreateProcessW(nullptr, cbuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                      nullptr, dir.c_str(), &si, &pi)) {
    CloseHandle(inR); CloseHandle(inW); CloseHandle(outR); CloseHandle(outW);
    return false;
  }
  CloseHandle(pi.hThread);
  if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);   
  CloseHandle(inR);                              
  CloseHandle(outW);
  const char* script =
      "START 15\nINFO RULE 0\nINFO TIMEOUT_TURN 300\nINFO TIMEOUT_MATCH 5000\n"
      "INFO TIME_LEFT 5000\nYXBOARD 7,7,1 7,8,2 DONE\nYXNBEST 1\n";
  DWORD written = 0;
  WriteFile(inW, script, (DWORD)strlen(script), &written, nullptr);
  CloseHandle(inW);

  bool sawMove = false;
  std::string pending;
  char rb[4096];
  const DWORD t0 = GetTickCount();
  while (GetTickCount() - t0 < 5000) {
    DWORD avail = 0;
    if (PeekNamedPipe(outR, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
      DWORD n = 0;
      DWORD want = avail > (DWORD)sizeof(rb) ? (DWORD)sizeof(rb) : avail;
      if (ReadFile(outR, rb, want, &n, nullptr) && n > 0) {
        pending.append(rb, n);
        size_t pos = 0;
        while ((pos = pending.find('\n')) != std::string::npos) {
          std::string line = pending.substr(0, pos);
          pending.erase(0, pos + 1);
          if (!line.empty() && line.back() == '\r') line.pop_back();
          
          if (line.size() <= 5 && line.find(',') != std::string::npos &&
              line.find_first_not_of("0123456789,") == std::string::npos) sawMove = true;
        }
      }
    }
    DWORD code = 0;
    if (GetExitCodeProcess(pi.hProcess, &code) && code != STILL_ACTIVE) {
      TerminateProcess(pi.hProcess, 0);
      CloseHandle(pi.hProcess);
      CloseHandle(outR);
      return sawMove && code == 0;                 
    }
    if (sawMove) break;
    Sleep(40);
  }
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  if (code == STILL_ACTIVE) TerminateProcess(pi.hProcess, 0);
  CloseHandle(pi.hProcess);
  CloseHandle(outR);
  return sawMove && (code == 0 || code == STILL_ACTIVE);
}

static void Probe() {
  if (g_probed) return;
  g_probed = true;
  std::wstring dir = Join(ExeDir(), L"rapfi-native");
  if (!FileExists(Join(dir, L"config.toml"))) {
    LogMsg("[engine] rapfi-native/config.toml 不存在 → 走页面内 WASM（纯训练器版才带原生引擎）");
    return;
  }
  g_dir = dir;
  EnsureJob();   
                 
  CpuCaps caps = CpuIdCaps();
  LogMsg("[engine] cpuid: avx2=" + std::string(caps.avx2 ? "1" : "0") +
         " avx512f=" + std::string(caps.avx512f ? "1" : "0") +
         " avx512vnni=" + std::string(caps.avx512vnni ? "1" : "0") +
         " avxvnni=" + std::string(caps.avxvnni ? "1" : "0"));

  {
    FILE* f = _wfopen(Join(dir, L".variant-ok").c_str(), L"rb");
    if (f) {
      char buf[256] = {0};
      size_t n = fread(buf, 1, sizeof(buf) - 1, f);
      fclose(f);
      std::string cached(buf, n);
      while (!cached.empty() && (cached.back() == '\n' || cached.back() == '\r')) cached.pop_back();
      
      std::string v = cached, fp;
      {
        size_t sp = cached.find(' ');
        if (sp != std::string::npos) { v = cached.substr(0, sp); fp = cached.substr(sp + 1); }
      }
      if (!fp.empty() && fp == CpuFingerprint() &&
          FileExists(Join(dir, std::wstring(L"RapfiEngine-") + Utf8ToWide(v) + L".exe")) &&
          VariantCpuOk(v, caps)) {          
        g_variant = v;
        g_avail = true;
        LogMsg("[engine] 原生 Rapfi 可用（沿用本机上次的变体）：variant=" + g_variant);
        return;
      }
      if (!v.empty())
        LogMsg("[engine] .variant-ok 与本机 CPU 不匹配（换机器/拷目录）→ 作废，重新探测");
    }
  }

  std::string firstOk;                            
  for (const char* v : kVariantOrder) {
    if (!FileExists(Join(dir, std::wstring(L"RapfiEngine-") + Utf8ToWide(v) + L".exe"))) continue;
    if (v == g_badVariant) continue;          
    if (!VariantCpuOk(v, caps)) continue;
    if (firstOk.empty()) firstOk = v;
    if (SmokeVariantOk(dir, v)) { g_variant = v; break; }
    LogMsg("[engine] variant=" + std::string(v) + " 冒烟失败（多半是 CPU 实际不支持该指令集）→ 降一档");
  }
  if (g_variant.empty()) {
    
    g_variant = firstOk;
    if (g_variant.empty() && FileExists(Join(dir, L"RapfiEngine-sse.exe"))) g_variant = "sse";
  }
  if (g_variant.empty()) {
    g_diag = "rapfi-native/ 里没有可在本机运行的引擎 exe（文件缺失或 CPU 不支持）→ 已回退网页引擎";
    LogMsg("[engine] rapfi-native/ 里没有可用引擎 exe → 走 WASM");
    return;
  }
  g_avail = true;
  {
    FILE* f = _wfopen(Join(dir, L".variant-ok").c_str(), L"wb");   
    if (f) {
      std::string rec = g_variant + " " + CpuFingerprint();   
      fwrite(rec.data(), 1, rec.size(), f);
      fclose(f);
    }
  }
  LogMsg("[engine] 原生 Rapfi 可用：variant=" + g_variant + " dir=" + WideToUtf8(dir));
}

static bool Available() {
  Probe();
  return g_avail;
}

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
      
      if (e.lines.size() >= 40000) { e.lines.pop_front(); e.dropped++; }
      e.lines.push_back(line);
      e.seq++;
    }
    RequestEngineFlush();                            
  }
  CloseHandle(out);                                  
  if (e.gen.load() != myGen) return;                 
  {
    std::lock_guard<std::mutex> lk(e.mu);
    e.alive = false;
    e.lines.push_back("");         
    e.seq++;
  }
  
  DWORD code = 0;
  if (e.hProcess && GetExitCodeProcess(e.hProcess, &code) && code != 0) {
    std::string d;
    bool downgrade = false;
    if (code == 0xC000001D)      { d = "引擎非法指令退出（本机 CPU 不支持该变体指令集）→ 已自动降档"; downgrade = true; }
    else if (code == 0xC0000135 || code == 0xC0000139) {
      d = "引擎缺少运行库（请安装 Microsoft Visual C++ Redistributable x64）"; downgrade = true; }
    else if (code == 0xC0000005) { d = "引擎被安全软件拦截或文件损坏（请把 rapfi-native 加入白名单）"; }
    else { char b[64]; snprintf(b, sizeof(b), "引擎异常退出 code=0x%08lX", (unsigned long)code); d = b; }
    g_diag = d;
    LogMsg("[engine:" + g_laneName[idx] + "] " + d);
    if (downgrade) {
      if (!g_variant.empty()) g_badVariant = g_variant;   
      g_variant.clear(); g_probed = false; g_avail = false;
      DeleteFileW(Join(g_dir, L".variant-ok").c_str());   
      LogMsg("[engine] 变体已降档，下次启动引擎时将重挑可用 ISA");
    }
  }
}

static bool SpawnLocked(int idx) {
  Engine& e = g_eng[idx];
  
  if (e.hProcess) { TerminateProcess(e.hProcess, 0); CloseHandle(e.hProcess); e.hProcess = nullptr; }
  if (e.hStdin)   { CloseHandle(e.hStdin); e.hStdin = nullptr; }
  e.hStdout = nullptr;                  
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
  si.hStdError = outW;              
  PROCESS_INFORMATION pi = {};
  std::wstring cmd = L"\"" + exe + L"\"";
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  
  BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW, nullptr, g_dir.c_str(), &si, &pi);
  CloseHandle(inR);
  CloseHandle(outW);
  if (!ok) {
    CloseHandle(inW); CloseHandle(outR);
    DWORD ec = GetLastError();
    g_diag = "启动引擎进程失败 err=" + std::to_string(ec) +
             "（多为 rapfi-native 文件缺失、被杀软拦截或缺少 VC++ 运行库）";
    LogMsg("[engine:" + g_laneName[idx] + "] spawn 失败 err=" + std::to_string(ec));
    return false;
  }
  CloseHandle(pi.hThread);
  if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);   

  e.hProcess = pi.hProcess;         
  e.hStdin   = inW;
  e.hStdout  = outR;
  int myGen  = ++e.gen;             
  {
    std::lock_guard<std::mutex> lk(e.mu);
    e.lines.clear(); e.seq = 0; e.dropped = 0;
  }
  e.alive = true;
  std::thread(ReaderThread, idx, outR, myGen).detach();
  LogMsg("[engine:" + g_laneName[idx] + "] 已启动 " + WideToUtf8(exe) + " (gen=" + std::to_string(myGen) + ")");
  return true;
}

static bool Spawn(int idx) {
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  return SpawnLocked(idx);
}

static bool Ensure(int idx) {
  Probe();
  if (!g_avail) return false;
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  if (g_eng[idx].alive.load()) return true;
  return SpawnLocked(idx);
}

static void Write(int idx, const std::string& text) {
  Engine& e = g_eng[idx];
  if (!e.hStdin) return;
  std::string s = text;
  if (s.empty() || s.back() != '\n') s += "\n";
  DWORD wr = 0;
  WriteFile(e.hStdin, s.data(), (DWORD)s.size(), &wr, nullptr);
}

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
  out += "],\"seq\":" + std::to_string(e.seq);
  if (!g_diag.empty()) out += ",\"diag\":" + JsonQuote(g_diag);   
  out += "}";
  return out;
}

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
  
  if (op == "status") r += ",\"status\":" + NativeEngineRouteJson("status", "", "");
  r += "}";
  return r;
}

}  

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
              ",\"physCores\":" + std::to_string(PhysCoreCount()) +
              ",\"memAvailMB\":" + std::to_string(MemAvailMB()) +
              ",\"memMB\":" + std::to_string((long long)(ms.ullTotalPhys / (1024 * 1024))) +
              ",\"lanes\":[\"main\",\"sub\",\"fwd\"]}";
  } else if (idx < 0) {
    payload = "{\"error\":\"bad lane\"}";
  } else if (route == "cmd") {
    
    bool ok = nativeeng::WriteEnsured(idx, reqBody);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "ensure") {
    
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

#if 0   
        
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

      std::string reqBody;
      {
        size_t he = req.find("\r\n\r\n");
        if (he != std::string::npos) {
          reqBody = req.substr(he + 4);
          size_t clPos = req.find("Content-Length:");
          if (clPos == std::string::npos) clPos = req.find("content-length:");
          size_t want = 0;
          if (clPos != std::string::npos) want = (size_t)strtoul(req.c_str() + clPos + 15, nullptr, 10);
          if (want > (size_t)4 << 20) want = (size_t)4 << 20;      
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
                      ",\"physCores\":" + std::to_string(PhysCoreCount()) +
                      ",\"memAvailMB\":" + std::to_string(MemAvailMB()) +
                      ",\"memMB\":" + std::to_string((long long)(ms.ullTotalPhys / (1024 * 1024))) +
                      ",\"lanes\":[\"main\",\"sub\",\"fwd\"]}";
          } else if (idx < 0) {
            payload = "{\"error\":\"bad lane\"}";
          } else if (route == "cmd") {
            
            std::string text = reqBody;
            bool ok = nativeeng::WriteEnsured(idx, text);
            payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
          } else if (route == "ensure") {
            
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
              
            } else {
            std::ifstream f(Join(Join(ExeDir(), L"calc"), Utf8ToWide(name)), std::ios::binary);
            if (f) body.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
          }
          
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
#endif  

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

template <class T> class Cb : public T {
 public:
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** pp) override {
    if (pp) *pp = nullptr;
    return E_NOINTERFACE;
  }
};

static std::wstring UiDir() { return Join(ExeDir(), L"calc"); }

static std::wstring UiPathFromUri(const std::wstring& uri) {
  const std::wstring prefix = L"https://gbcalc.test/";
  size_t p = uri.find(prefix);
  std::wstring rest = (p == std::wstring::npos) ? uri : uri.substr(p + prefix.size());
  size_t q = rest.find_first_of(L"?#");
  if (q != std::wstring::npos) rest = rest.substr(0, q);
  while (!rest.empty() && rest[0] == L'/') rest.erase(0, 1);
  if (rest.empty()) rest = L"calc.html";
  if (rest.find(L"..") != std::wstring::npos) rest = L"__deny__";   
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
    ICoreWebView2HttpResponseHeaders* hs = nullptr;
    if (SUCCEEDED(resp->get_Headers(&hs)) && hs) {
      hs->AppendHeader(L"Cross-Origin-Opener-Policy", L"same-origin");
      hs->AppendHeader(L"Cross-Origin-Embedder-Policy", L"require-corp");
      if (extraName && *extraName) hs->AppendHeader(extraName, extraValue);
      if (!mime.empty()) hs->AppendHeader(L"Content-Type", mime.c_str());
      hs->AppendHeader(L"Cache-Control", L"no-store");
      hs->Release();
    }
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
    if (uri.find(L"gbcalc.test") == std::wstring::npos) { req->Release(); return S_OK; }  
    
    if (uri.find(L"/engine/out") == std::wstring::npos)
      LogMsg("[res] enter " + WideToUtf8(uri).substr(0, 100));

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

    if (path.rfind(L"engine/", 0) == 0) {
      std::string route = WideToUtf8(path.substr(7));
      std::string payload = NativeEngineRouteJson(route, query, reqBody);
      RespondMem(args, 200, L"OK", L"application/json; charset=utf-8", L"Cache-Control", L"no-store",
                 std::vector<uint8_t>(payload.begin(), payload.end()));
      if (route != "out") LogMsg("[res] engine/" + route + " -> " + payload.substr(0, 80));
      return S_OK;
    }

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
      
      LogMsg("[res] MISS " + WideToUtf8(path) + " (404)");
      RespondMem(args, 404, L"Not Found", L"text/plain", L"Cache-Control", L"no-store", {});
      return S_OK;
    }
    { char rb[512];
      snprintf(rb, sizeof(rb), "[res] serve %ls how=%s bytes=%zu", path.c_str(), how, content.size());
      LogMsg(rb); }
    
    RespondMem(args, 200, L"OK", UiMimeFor(path), L"Cache-Control", L"no-store", content);
    return S_OK;
  }
};

static ResHandler g_resHandler;   

static void LayoutWebView() {
  if (!g_controller || !g_hwnd) return;
  RECT r;
  GetClientRect(g_hwnd, &r);
  g_controller->put_Bounds(r);
}

class EvalHandler : public Cb<ICoreWebView2ExecuteScriptCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, LPCWSTR result) override {
    if (result && *result) LogMsg("[eval] " + WideToUtf8(result));
    else LogMsg("[eval] (empty result)");
    return S_OK;
  }
};

#ifdef GB_SUITE_ENGINE
static const char* kUpdateShareUrl = "https://wwbbj.lanzout.com/b016l4d3id";
static const char* kUpdateSharePwd = "55555";
#else
static const char* kUpdateShareUrl = "https://wwbbj.lanzout.com/b016l49aqj";
static const char* kUpdateSharePwd = "15";
#endif

static HWND g_updHwnd = nullptr;                 
static ICoreWebView2Controller* g_updController = nullptr;   
static ICoreWebView2* g_updWebview = nullptr;
static bool g_updCreating = false;

static ICoreWebView2Controller* g_updToolController = nullptr;   
static ICoreWebView2* g_updToolWebview = nullptr;

static ICoreWebView2Controller* g_updSuggestController = nullptr;
static ICoreWebView2* g_updSuggestWebview = nullptr;

static HWND g_updSuggestWnd = nullptr;
static int g_updSuggestH = 300;   
static double g_updZoom = 1.0;   
static void UpdShowSuggest(const std::wstring& json);   

static int UpdBarH(HWND h, int clientPxH) {
  int dpi = GbDpiFor(h);
  int cssH = MulDiv(clientPxH, 96, dpi);
  int css = (cssH < 560) ? 40 : (cssH > 900 ? 48 : 46);
  return MulDiv(css, dpi, 96);
}

static const int kUpdDefCssW = 1100, kUpdDefCssH = 780;
static const int kUpdMinCssW = 520,  kUpdMinCssH = 560;

static bool g_updSearchMode = false;             

static std::wstring UpdUrlEncode(const std::wstring& w) {
  std::string u8 = WideToUtf8(w);
  static const char* hex = "0123456789ABCDEF";
  std::string o;
  for (size_t i = 0; i < u8.size(); ++i) {
    unsigned char c = (unsigned char)u8[i];
    bool safe = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) o += (char)c; else { o += '%'; o += hex[c >> 4]; o += hex[c & 15]; }
  }
  return Utf8ToWide(o);
}

static void UpdNavigateTo(const std::wstring& raw) {
  if (!g_updWebview) return;
  std::wstring u = raw;
  while (!u.empty() && (u[0] == L' ' || u[0] == L'\t')) u.erase(0, 1);
  while (!u.empty() && (u[u.size()-1] == L' ' || u[u.size()-1] == L'\t')) u.erase(u.size()-1);
  if (u.empty()) { g_updWebview->Navigate(Utf8ToWide(std::string(kUpdateShareUrl)).c_str()); return; }
  
  bool hasScheme = u.find(L"://") != std::wstring::npos;
  bool hasHttp = _wcsnicmp(u.c_str(), L"http://", 7) == 0 || _wcsnicmp(u.c_str(), L"https://", 8) == 0;
  
  while (u.size() >= 8 && _wcsnicmp(u.c_str(), L"https://", 8) == 0 &&
         (_wcsnicmp(u.c_str() + 8, L"https://", 8) == 0 || _wcsnicmp(u.c_str() + 8, L"http://", 7) == 0))
    u.erase(0, 8);
  bool looksUrl = !hasScheme && !hasHttp && u.find(L'.') != std::wstring::npos &&
                  u.find(L' ') == std::wstring::npos && u.find(L'\t') == std::wstring::npos;
  if (hasScheme || hasHttp) {
    
  } else if (looksUrl) {
    u = L"https://" + u;
  } else {
    u = L"https://www.bing.com/search?q=" + UpdUrlEncode(u);
  }
  g_updWebview->Navigate(u.c_str());
}

static void UpdAutofillPwd() {
  if (!g_updWebview) return;
  
  LPWSTR cur = nullptr;
  if (FAILED(g_updWebview->get_Source(&cur)) || !cur) return;
  std::wstring url = cur;
  CoTaskMemFree(cur);
  std::wstring low = url;
  for (auto& c : low) c = towlower(c);
  if (low.find(L"lanzou") == std::wstring::npos && low.find(L"lanzo") == std::wstring::npos) return;
  
  static std::wstring lastUrl;
  if (lastUrl == url) return;
  lastUrl = url;
  
  std::wstring js =
    std::wstring(L"(function(){try{var P='") + Utf8ToWide(std::string(kUpdateSharePwd)) + L"';"
    L"var inp=document.querySelector('input[type=password],#pwd,#p,input[name=p],input[name=pwd]');"
    L"if(!inp)return;"
    L"inp.value=P;inp.dispatchEvent(new Event('input',{bubbles:true}));"
    L"var f=inp.closest('form');if(!f)return;"
    L"var b=f.querySelector('input[type=submit],button[type=submit],button');"
    L"if(b){b.click();}else{f.submit();}"
    L"}catch(e){}})();";
  g_updWebview->ExecuteScript(js.c_str(), nullptr);
}

static std::wstring WebView2UserDataDir();   
static const __int64 kUpdCleanLimit = 128LL * 1024 * 1024;   
static const DWORD kUpdCleanMinGap = 60000;                  
static DWORD g_updLastCleanTry = 0;

static __int64 UpdDirSize(const std::wstring& root) {
  __int64 total = 0;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW((root + L"\\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;
  do {
    if (fd.cFileName[0] == L'.' && (fd.cFileName[1] == L'\0' || (fd.cFileName[1] == L'.' && fd.cFileName[2] == L'\0'))) continue;
    std::wstring full = root + L"\\" + fd.cFileName;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) total += UpdDirSize(full);
    else total += ((__int64)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return total;
}

static void UpdDeleteTree(const std::wstring& root) {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW((root + L"\\*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.cFileName[0] == L'.' && (fd.cFileName[1] == L'\0' || (fd.cFileName[1] == L'.' && fd.cFileName[2] == L'\0'))) continue;
      std::wstring full = root + L"\\" + fd.cFileName;
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) UpdDeleteTree(full);
      else { SetFileAttributesW(full.c_str(), FILE_ATTRIBUTE_NORMAL); DeleteFileW(full.c_str()); }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  SetFileAttributesW(root.c_str(), FILE_ATTRIBUTE_NORMAL);
  RemoveDirectoryW(root.c_str());
}

static void UpdSweepCacheDirs() {
  static const wchar_t* dirs[] = {
    L"Cache", L"Code Cache", L"GPUCache", L"DawnCache", L"DawnGraphiteCache",
    L"Service Worker", L"IndexedDB", L"Session Storage", L"CacheStorage", L"SharedWorker"
  };
  static const wchar_t* files[] = { L"Cookies", L"Cookies-journal" };
  std::wstring root = WebView2UserDataDir() + L"\\EBWebView";
  for (auto n : dirs) {
    std::wstring d = root + L"\\" + n;
    DWORD att = GetFileAttributesW(d.c_str());
    if (att == INVALID_FILE_ATTRIBUTES || !(att & FILE_ATTRIBUTE_DIRECTORY)) continue;
    UpdDeleteTree(d);
  }
  for (auto f : files) {
    std::wstring d = root + L"\\" + f;
    DWORD att = GetFileAttributesW(d.c_str());
    if (att == INVALID_FILE_ATTRIBUTES) continue;
    SetFileAttributesW(d.c_str(), FILE_ATTRIBUTE_NORMAL);
    DeleteFileW(d.c_str());
  }
  LogMsg("[upd] browsing data >128MB auto-swept (search history kept)");
}

static void UpdMaybeCleanData() {
  DWORD now = GetTickCount();
  if (now - g_updLastCleanTry < kUpdCleanMinGap) return;
  g_updLastCleanTry = now;
  std::wstring root = WebView2UserDataDir();
  if (UpdDirSize(root) < kUpdCleanLimit) return;   
  UpdSweepCacheDirs();
}

  static std::wstring UpdToolBarHtml(bool dark, bool langEn) {
    std::wstring bodyCls = dark ? L"" : L" class=\"light\"";   
    std::wstring h =
      L"<!doctype html><html><head><meta charset=\"utf-8\"><style>"
      L":root{--bg:#26272a;--fg:#e6e7ea;--sub:#9aa0a6;--field:#1c1e21;--hover:rgba(255,255,255,.07);--border:rgba(255,255,255,.09);--accent:#2fc1d8}"
      L"body.light{--bg:#f4f5f7;--fg:#2d2f32;--sub:#87888b;--field:#ffffff;--hover:rgba(0,0,0,.05);--border:rgba(0,0,0,.10);--accent:#137f98}"
      L"*{margin:0;padding:0;box-sizing:border-box}"
      L"html,body{height:100%}"
      L"body{background:var(--bg);color:var(--fg);display:flex;align-items:center;gap:6px;padding:0 10px;font:14px/1 'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;user-select:none}"
      L".nav{width:34px;height:34px;flex:none;border:0;border-radius:10px;background:transparent;color:var(--sub);font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,color .12s}"
      L".nav:hover{background:var(--hover);color:var(--fg)}"
      L".nav:disabled{opacity:.25;cursor:default}"
      L"#box{flex:1;display:flex;align-items:center;gap:8px;height:34px;background:var(--field);border:1px solid var(--border);border-radius:16px;padding:0 14px}"
      L"#box:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}"
      L"#q{flex:1;border:0;outline:0;background:transparent;color:var(--fg);font-size:14px;min-width:0}"
      L"#q::placeholder{color:var(--sub)}"
      L".ico{color:var(--sub);font-size:13px;flex:none}"
      L"</style></head><body" + bodyCls + L">" +
      std::wstring(L"<button class=\"nav\" id=\"bBack\" title=\"") + (langEn ? L"Back" : L"后退") + L"\">&#9664;</button>" +
      std::wstring(L"<button class=\"nav\" id=\"bFwd\" title=\"") + (langEn ? L"Forward" : L"前进") + L"\">&#9654;</button>" +
      std::wstring(L"<button class=\"nav\" id=\"bRel\" title=\"") + (langEn ? L"Refresh" : L"刷新") + L"\">&#10227;</button>" +
      L"<div id=\"box\"><span class=\"ico\">&#128269;</span><input id=\"q\" spellcheck=\"false\" autocomplete=\"off\"></div>"
      L"<script>"
      L"(function(){"
      L"var wv=(window.chrome&&chrome.webview)?chrome.webview:null;"
      L"var Q=document.getElementById('q');"
      L"var hist=[];try{hist=JSON.parse(localStorage.getItem('gbUpdHist')||'[]');}catch(e){hist=[];}"
      L"if(!Array.isArray(hist))hist=[];"
      L"var EN=(navigator.language&&navigator.language.indexOf('en')===0);"
      L"function post(o){if(wv)wv.postMessage(o);}"
      L"function save(){try{localStorage.setItem('gbUpdHist',JSON.stringify(hist.slice(0,30)));}catch(e){}}"
      L"function send(){var v=Q.value.trim();var items=[];if(!v){items=hist.slice(0,30);}else{var lw=v.toLowerCase();for(var i=0;i<hist.length;i++){var t=String(hist[i]);if(t.toLowerCase().indexOf(lw)>=0)items.push(t);}}"
      L"post({tool:'suggest',items:items,act:v,lang:EN?1:0,dark:document.body.classList.contains('light')?0:1});}"
      L"function setLang(en){EN=!!en;Q.placeholder=en?'Search or enter a URL':'搜索或输入网址';}"
      L"Q.addEventListener('keydown',function(e){if(e.key==='Enter'){var q=Q.value.trim();if(q)post({tool:'go',q:q});post({tool:'suggestHide'});}});"
      L"Q.addEventListener('input',function(){send();});"
      L"Q.addEventListener('focus',function(){send();});"
      L"Q.addEventListener('blur',function(){setTimeout(function(){post({tool:'suggestHide'});},150);});"
      L"document.getElementById('bBack').addEventListener('click',function(){post({tool:'back'});});"
      L"document.getElementById('bFwd').addEventListener('click',function(){post({tool:'fwd'});});"
      L"document.getElementById('bRel').addEventListener('click',function(){post({tool:'reload'});});"
      L"if(wv)wv.addEventListener('message',function(e){"
      L"var d=e.data;if(typeof d==='string'){try{d=JSON.parse(d);}catch(x){return;}}"
      L"if(!d)return;"
      L"if(typeof d.url==='string'){Q.value=d.url;hist=[d.url].concat(hist.filter(function(x){return x!==d.url;}));hist=hist.slice(0,30);save();}"
      L"if(typeof d.canBack==='boolean')document.getElementById('bBack').disabled=!d.canBack;"
      L"if(typeof d.canFwd==='boolean')document.getElementById('bFwd').disabled=!d.canFwd;"
      L"if(typeof d.lang==='number')setLang(!!d.lang);"
      L"if(typeof d.dark==='number')document.body.classList.toggle('light',!d.dark);"
      L"});"
      L"if(navigator.language&&navigator.language.indexOf('en')===0)setLang(true);"
      L"})();"
      L"</script></body></html>";
    return h;
  }
  
  static std::wstring UpdSuggestHtml(bool dark, bool langEn) {
    std::wstring bodyCls = dark ? L"" : L" class=\"light\"";
    return
      L"<!doctype html><html><head><meta charset=\"utf-8\"><style>"
      L":root{--bg:#202124;--fg:#e6e7ea;--sub:#9aa0a6;--hover:rgba(255,255,255,.12);--accent:#8ab4f8;--border:rgba(255,255,255,.18);--shadow:rgba(0,0,0,.30)}"
      L"body.light{--bg:#ffffff;--fg:#2d2f32;--sub:#87888b;--hover:rgba(0,0,0,.08);--accent:#1a73e8;--border:rgba(0,0,0,.14);--shadow:rgba(0,0,0,.10)}"
      L"*{margin:0;padding:0;box-sizing:border-box}"
      L"html,body{height:100%}"
      L"body{background:var(--bg);font:14px/1 'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;user-select:none;padding:0}"
      L"#wrap{background:var(--bg);border:1px solid var(--border);border-radius:10px;height:100%;max-height:100%;overflow:hidden}"
      L"#list{overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.4) transparent;max-height:278px}"
      L"#list::-webkit-scrollbar{width:6px}"
      L"#list::-webkit-scrollbar-thumb{background:rgba(128,128,128,.4);border-radius:3px}"
      L".it{padding:10px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:var(--fg);display:flex;align-items:center;gap:8px;border-radius:6px;font-size:14px;line-height:1.3}"
      L".it:hover{background:var(--hover)}"
      L".it .act{flex:none;font-size:11px;color:var(--accent);margin-left:auto;opacity:.85}"
      L".empty{padding:7px 14px;font-size:12px;color:var(--sub)}"
      L"</style></head><body" + bodyCls + L"><div id=\"wrap\"><div id=\"list\"></div></div><script>"
      L"(function(){"
      L"var L=document.getElementById('list');"
      L"window.__upd=function(d){"
      L"if(!d)return;"
      L"document.body.classList.toggle('light',!(d.dark===undefined||d.dark));"
      L"var EN=!!d.lang;"
      L"L.innerHTML='';"
      L"var items=(d.items||[]),act=String(d.act||'');"
      L"if(!items.length&&!act){var e=document.createElement('div');e.className='empty';e.textContent=EN?'No suggestions':'暂无建议';L.appendChild(e);return;}"
      L"if(act){var a=document.createElement('div');a.className='it';a.innerHTML='<span></span><span class=\"act\">'+(EN?'Search':'搜索')+'</span>';a.firstChild.textContent=act;a.setAttribute('data-q',act);L.appendChild(a);}"
      L"for(var i=0;i<items.length;i++){var d2=document.createElement('div');d2.className='it';d2.textContent=items[i];d2.setAttribute('data-q',items[i]);L.appendChild(d2);}"
      L"};"
      L"document.addEventListener('click',function(e){"
      L"var t=e.target&&e.target.closest?e.target.closest('.it'):null;if(!t)return;var wv=window.chrome&&chrome.webview?chrome.webview:null;if(wv)wv.postMessage({tool:'pick',q:t.getAttribute('data-q')});});"
      L"})();"
      L"</script></body></html>";
  }
  
  static std::wstring JsonQuoteW(const std::wstring& s) {
    std::wstring o = L"\"";
    for (wchar_t c : s) { if (c == L'"' || c == L'\\') o += L'\\'; o += c; }
    o += L"\"";
    return o;
  }
  
  static void UpdNavSync() {
    if (!g_updToolWebview || !g_updWebview) return;
    LPWSTR u = nullptr;
    std::wstring url;
    if (SUCCEEDED(g_updWebview->get_Source(&u)) && u) { url = u; CoTaskMemFree(u); }
    BOOL canBack = FALSE, canFwd = FALSE;
    g_updWebview->get_CanGoBack(&canBack);
    g_updWebview->get_CanGoForward(&canFwd);
    std::wstring j = L"{\"url\":" + JsonQuoteW(url) +
                     L",\"canBack\":" + (canBack ? L"true" : L"false") +
                     L",\"canFwd\":" + (canFwd ? L"true" : L"false") + L"}";
    g_updToolWebview->PostWebMessageAsJson(j.c_str());
  }
  
  class UpdToolMsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
   public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) override {
      LPWSTR raw = nullptr;
      if (FAILED(a->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
      std::wstring s = raw;
      CoTaskMemFree(raw);
      if (s.find(L"\"tool\":\"back\"") != std::wstring::npos && g_updWebview) g_updWebview->GoBack();
      else if (s.find(L"\"tool\":\"fwd\"") != std::wstring::npos && g_updWebview) g_updWebview->GoForward();
      else if (s.find(L"\"tool\":\"reload\"") != std::wstring::npos && g_updWebview) g_updWebview->Reload();
      else if (s.find(L"\"tool\":\"suggest\"") != std::wstring::npos) { UpdShowSuggest(s); }
      else if (s.find(L"\"tool\":\"panel\"") != std::wstring::npos) { UpdShowSuggest(s); }
      else if (s.find(L"\"tool\":\"unfav\"") != std::wstring::npos) {
        if (g_updToolWebview) {
          std::wstring js = L"try{window.__unfav&&window.__unfav(" + s + L");}catch(e){}";
          g_updToolWebview->ExecuteScript(js.c_str(), nullptr);
        }
      }
      else if (s.find(L"\"tool\":\"suggestHide\"") != std::wstring::npos) {
        if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
        if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
      }
      else if (s.find(L"\"tool\":\"go\"") != std::wstring::npos) {
        size_t p = s.find(L"\"q\":\"");
        if (p != std::wstring::npos) {
          std::wstring q = s.substr(p + 5);
          size_t e = q.find(L'"');
          if (e != std::wstring::npos) q = q.substr(0, e);
          std::wstring dq;
          for (size_t i = 0; i < q.size(); ++i) {
            if (q[i] == L'\\' && i + 1 < q.size()) { dq += q[i + 1]; ++i; } else dq += q[i];
          }
          UpdNavigateTo(dq);
        }
      }
      return S_OK;
    }
  };
  
  static void UpdLayoutSuggest(int h) {
    if (!g_updHwnd || !g_updSuggestWnd) return;
    RECT rc;
    GetClientRect(g_updHwnd, &rc);
    RECT rc0; GetClientRect(g_updHwnd, &rc0);
    int bar = UpdBarH(g_updHwnd, rc0.bottom);
    
    int x = GbPx(g_updHwnd, 130);
    int w = rc.right - GbPx(g_updHwnd, 140);
    POINT pt = {x, bar - GbPx(g_updHwnd, 6)};   
    ClientToScreen(g_updHwnd, &pt);
    SetWindowPos(g_updSuggestWnd, nullptr, pt.x, pt.y, w, h,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    
    if (g_updSuggestController) {
      RECT cr;
      GetClientRect(g_updSuggestWnd, &cr);
      g_updSuggestController->put_Bounds(RECT{0, 0, cr.right, cr.bottom});
    }
  }
  
  static void UpdShowSuggest(const std::wstring& json) {
    (void)json;   
    return;
    if (!g_updSuggestWebview) { LogMsg("[upd] SUGGEST skip: no suggest webview"); return; }
    
    int rows = 0;
    size_t ap = json.find(L"\"act\":\"");
    if (ap != std::wstring::npos) { size_t av = ap + 7; if (av < json.size() && json[av] != L'"') rows++; }
    size_t ip = json.find(L"\"items\":[");
    if (ip != std::wstring::npos) {
      size_t st = ip + 9, en = json.find(L']', st);
      if (en != std::wstring::npos && en > st) {
        std::wstring seg = json.substr(st, en - st);
        int n = 1;
        for (wchar_t c : seg) if (c == L',') n++;
        rows += n;
      }
    }
    int sh = rows > 0 ? (42 * (rows > 8 ? 8 : rows)) : 1;   
    g_updSuggestH = GbPx(g_updHwnd, sh);
    
    UpdLayoutSuggest(g_updSuggestH);
    if (g_updSuggestWnd) {
      SetWindowPos(g_updSuggestWnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      ShowWindow(g_updSuggestWnd, SW_SHOW);
    }
    if (g_updSuggestController) g_updSuggestController->put_IsVisible(TRUE);
    std::wstring js = L"try{window.__upd&&window.__upd(" + json + L");}catch(e){}";
    g_updSuggestWebview->ExecuteScript(js.c_str(), nullptr);
  }
  
  class UpdSuggestMsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
   public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) override {
      LPWSTR raw = nullptr;
      if (FAILED(a->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
      std::wstring s = raw;
      CoTaskMemFree(raw);
      if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
      if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
      if (s.find(L"\"tool\":\"pick\"") != std::wstring::npos) {
        size_t p = s.find(L"\"q\":\"");
        if (p != std::wstring::npos) {
          std::wstring q = s.substr(p + 5);
          size_t e = q.find(L'"');
          if (e != std::wstring::npos) q = q.substr(0, e);
          std::wstring dq;
          for (size_t i = 0; i < q.size(); ++i) {
            if (q[i] == L'\\' && i + 1 < q.size()) { dq += q[i + 1]; ++i; } else dq += q[i];
          }
          UpdNavigateTo(dq);
        }
      }
      return S_OK;
    }
  };
  
  class UpdSuggestNavHandler : public Cb<ICoreWebView2NavigationCompletedEventHandler> {
   public:
    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) override {
      
      if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
      if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
      return S_OK;
    }
  };
  
  class UpdSuggestCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
   public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
      if (FAILED(hr) || !ctl || !g_updSuggestWnd) return S_OK;
      g_updSuggestController = ctl;
      ctl->AddRef();
      ctl->get_CoreWebView2(&g_updSuggestWebview);
      if (!g_updSuggestWebview) return S_OK;
      g_updSuggestWebview->AddRef();
      g_updSuggestWebview->add_WebMessageReceived(new UpdSuggestMsgHandler(), nullptr);
      SetWebviewBg(ctl, g_uiDark ? RGB(32, 33, 36) : RGB(255, 255, 255));   
      RECT rc;
      GetClientRect(g_updSuggestWnd, &rc);
      ctl->put_Bounds(RECT{0, 0, rc.right, rc.bottom});   
      
      g_updSuggestWebview->add_NavigationCompleted(new UpdSuggestNavHandler(), nullptr);
      ctl->put_IsVisible(TRUE);
      g_updSuggestWebview->NavigateToString(UpdSuggestHtml(g_uiDark, g_uiLangEn).c_str());
      return S_OK;
    }
  };
  
  class UpdToolCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
   public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
      if (FAILED(hr) || !ctl || !g_updHwnd) return S_OK;
      g_updToolController = ctl;
      ctl->AddRef();
      ctl->get_CoreWebView2(&g_updToolWebview);
      if (!g_updToolWebview) return S_OK;
      g_updToolWebview->AddRef();
      g_updToolWebview->add_WebMessageReceived(new UpdToolMsgHandler(), nullptr);
      RECT rc;
      GetClientRect(g_updHwnd, &rc);
      RECT rcT; GetClientRect(g_updHwnd, &rcT);
      int bar = UpdBarH(g_updHwnd, rcT.bottom);
      ctl->put_Bounds(RECT{0, 0, rc.right, bar});
      ctl->put_IsVisible(TRUE);
      g_updToolWebview->NavigateToString(UpdToolBarHtml(g_uiDark, g_uiLangEn).c_str());
      
      if (!g_updSuggestWnd) {
        WNDCLASSEXW sw = {};
        sw.cbSize = sizeof(sw);
        sw.lpfnWndProc = DefWindowProcW;
        sw.hInstance = g_hInst;
        sw.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
        sw.lpszClassName = L"GbUpdSuggestWnd";
        RegisterClassExW(&sw);
        
        g_updSuggestWnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST, L"GbUpdSuggestWnd", L"",
                                          WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, g_hInst, nullptr);   
      }
      if (g_env && g_updSuggestWnd) g_env->CreateCoreWebView2Controller(g_updSuggestWnd, new UpdSuggestCtlHandler());
      return S_OK;
    }
  };

class UpdNavDoneHandler : public Cb<ICoreWebView2NavigationCompletedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) override {
    if (!g_updWebview) return S_OK;
    UpdAutofillPwd();
    UpdNavSync();
    UpdMaybeCleanData();   
    return S_OK;
  }
};

class UpdHistHandler : public Cb<ICoreWebView2HistoryChangedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, IUnknown*) override {  
    UpdNavSync();
    return S_OK;
  }
};

class UpdDownloadHandler : public Cb<ICoreWebView2DownloadStartingEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* a) override {
    if (!a || !g_updHwnd) return S_OK;
    ICoreWebView2DownloadOperation* op = nullptr;
    if (FAILED(a->get_DownloadOperation(&op)) || !op) return S_OK;
    std::wstring defName = L"download";
    LPWSTR rfp = nullptr;
    if (SUCCEEDED(op->get_ResultFilePath(&rfp)) && rfp) {
      std::wstring p = rfp;
      CoTaskMemFree(rfp);
      size_t bs = p.find_last_of(L'\\\\'), sl = p.find_last_of(L'/');
      size_t at = (bs == std::wstring::npos) ? sl : ((sl == std::wstring::npos) ? bs : (bs > sl ? bs : sl));
      if (at != std::wstring::npos && at + 1 < p.size()) defName = p.substr(at + 1);
    }
    op->Release();
    std::wstring path = PickSavePathAs(defName, g_updHwnd,
                                       L"所有文件 (*.*)\0*.*\0", L"",
                                       g_uiLangEn ? L"Save Download As" : L"保存下载文件");
    if (path.empty()) { a->put_Cancel(TRUE); return S_OK; }
    a->put_ResultFilePath(path.c_str());
    return S_OK;
  }
};

class UpdCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
    g_updCreating = false;
    if (FAILED(hr) || !ctl || !g_updHwnd) { LogMsg("[upd] popup controller failed"); return S_OK; }
    g_updController = ctl;
    ctl->AddRef();
    ctl->get_CoreWebView2(&g_updWebview);
    if (!g_updWebview) return S_OK;
    g_updWebview->AddRef();
    EventRegistrationToken tok = {};
    g_updWebview->add_NavigationCompleted(new UpdNavDoneHandler(), &tok);
    g_updWebview->add_HistoryChanged(new UpdHistHandler(), &tok);       
    UpdMaybeCleanData();   
    
    ICoreWebView2_4* wv2 = nullptr;
    if (SUCCEEDED(g_updWebview->QueryInterface(IID_PPV_ARGS(&wv2)))) {
      wv2->add_DownloadStarting(new UpdDownloadHandler(), &tok);
      wv2->Release();
    }
    SetWebviewBg(ctl, g_uiBg);
    RECT rc;
    GetClientRect(g_updHwnd, &rc);
    int bar = UpdBarH(g_updHwnd, rc.bottom);
    ctl->put_Bounds(RECT{0, bar, rc.right, rc.bottom});   
    ctl->put_IsVisible(TRUE);
    
    if (g_updSearchMode) g_updWebview->Navigate(L"https://www.bing.com/");
    else g_updWebview->Navigate(Utf8ToWide(std::string(kUpdateShareUrl)).c_str());
    
    if (g_env) g_env->CreateCoreWebView2Controller(g_updHwnd, new UpdToolCtlHandler());
    return S_OK;
  }
};

static LRESULT CALLBACK UpdWndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CREATE:
      SetTimer(h, 2, 400, NULL);   
      return 0;
    case WM_TIMER:
      if (w == 2) {
        double z = 1.0;
        if (g_updController && SUCCEEDED(g_updController->get_ZoomFactor(&z)) && z != g_updZoom) {
          g_updZoom = z;
          if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
          if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
          g_updSuggestH = 0;
        }
      }
      return 0;
    case WM_SIZE: {
      RECT rc;
      GetClientRect(h, &rc);
      int bar = UpdBarH(h, rc.bottom);            
      
      if (g_updController) g_updController->put_Bounds(RECT{0, bar, rc.right, rc.bottom});
      if (g_updToolController) g_updToolController->put_Bounds(RECT{0, 0, rc.right, bar});
      
      if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
      if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
      g_updSuggestH = 0;
      UpdLayoutSuggest(0);
      return 0;
    }
    case WM_MOVE:
      UpdLayoutSuggest(g_updSuggestH);
      return 0;
    case WM_GETMINMAXINFO: {   
      MINMAXINFO* mm = (MINMAXINFO*)l;
      if (mm) { mm->ptMinTrackSize.x = GbPx(h, kUpdMinCssW); mm->ptMinTrackSize.y = GbPx(h, kUpdMinCssH); }
      return 0;
    }
    case WM_CLOSE:
      if (g_updSuggestController) g_updSuggestController->put_IsVisible(FALSE);
      if (g_updSuggestWnd) ShowWindow(g_updSuggestWnd, SW_HIDE);
      ShowWindow(h, SW_HIDE);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    default:
      return DefWindowProcW(h, m, w, l);
  }
  return DefWindowProcW(h, m, w, l);
}

static void OpenUpdateWindow(bool asSearch) {
  if (!g_env) { LogMsg("[upd] webview env not ready"); return; }
  g_updSearchMode = asSearch;
  
  if (!asSearch) WriteClipboardText(Utf8ToWide(std::string(kUpdateSharePwd)));
  if (!g_updHwnd) {
    if (g_updCreating) return;
    static const wchar_t* kUpdCls = L"GbUpdWnd";
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = UpdWndProc;
    wc.hInstance = g_hInst;
    wc.lpszClassName = kUpdCls;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.hIcon = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
    wc.hIconSm = LoadIconW(g_hInst, MAKEINTRESOURCEW(1));
    RegisterClassExW(&wc);
    int w = GbPx(nullptr, kUpdDefCssW), hgt = GbPx(nullptr, kUpdDefCssH);
    GbClampToWorkArea(nullptr, w, hgt);   
    RECT mw = {0, 0, 0, 0};
    int x = CW_USEDEFAULT, y = CW_USEDEFAULT;
    if (g_hwnd && GetWindowRect(g_hwnd, &mw)) {
      x = mw.left + ((mw.right - mw.left) - w) / 2;
      y = mw.top + ((mw.bottom - mw.top) - hgt) / 3;
    }
    g_updHwnd = CreateWindowExW(0, kUpdCls,
                                asSearch ? L"全网搜索 · Web Search"
                                         : (g_uiLangEn ? L"Get Latest Version" : L"获取最新版本"),
                                WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                                x, y, w, hgt, nullptr, nullptr, g_hInst, nullptr);
    if (!g_updHwnd) { LogMsg("[upd] CreateWindowEx failed"); return; }
    
    g_updCreating = true;
    g_env->CreateCoreWebView2Controller(g_updHwnd, new UpdCtlHandler());
    LogMsg("[upd] embedded-browser window created (toolbar via 2nd WebView2)");
  } else {
    
    SetWindowTextW(g_updHwnd, asSearch ? L"全网搜索 · Web Search"
                                      : (g_uiLangEn ? L"Get Latest Version" : L"获取最新版本"));
    if (g_updWebview) {
      if (asSearch) g_updWebview->Navigate(L"https://www.bing.com/");
      else g_updWebview->Navigate(Utf8ToWide(std::string(kUpdateShareUrl)).c_str());
    }
  }
  ShowWindow(g_updHwnd, SW_SHOWNORMAL);
  SetForegroundWindow(g_updHwnd);
}

class MsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* e) override {
    LPWSTR raw = nullptr;
    if (FAILED(e->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
     std::string s = WideToUtf8(raw);
     CoTaskMemFree(raw);
     LogMsg("[msg] " + s.substr(0, 200));
    
    if (s.find("\"engine\"") != std::string::npos && s.find("\"op\":") != std::string::npos) {
      g_pushEngineOut = true;                       
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
      
      LogMsg("[ai] engineConfig threads=" + std::to_string(t) + " hashMB=" + std::to_string(h) + " (in-page)");
      return S_OK;
    }
    if (s.find("\"ready\"") != std::string::npos) {
      if (!g_pending.empty()) {
        std::string p = g_pending; g_pending.clear();
        PostToPage(p);
      }
      
      SaveUiPrefs(s);
      g_uiDark = (JsonStrAfterDecoded(s, JKey("theme").c_str()) != "light");
      ApplyDarkTitleBar(g_hwnd, g_uiDark);
      RevealMainPage();
      KillTimer(g_hwnd, kMainTimerReload);
      LogBoot("PAGE READY");
      LogMsg("[ui] main page ready - splash removed");
      
      SetTimer(g_hwnd, kMainTimerHook, 50, nullptr);
      
      PrewarmReviewWindow();
      return S_OK;
    }
    
    if (s.find("uiTheme") != std::string::npos) {
      std::string th = JsonStrAfterDecoded(s, JKey("theme").c_str());
      if (th != "light" && th != "dark") th = "dark";
      
      std::string lg = JsonStrAfterDecoded(s, JKey("lang").c_str());
      if (lg == "en" || lg == "zh") g_uiLangEn = (lg == "en");
      SaveUiPrefs(s);
      g_uiDark = (th != "light");
      ApplyDarkTitleBar(g_hwnd, g_uiDark);
      ApplyDarkTitleBar(g_rvHwnd, g_uiDark);
      ApplyDarkTitleBar(g_visHwnd, g_uiDark);
      PostToRvPageSoon(std::string("{") + JKey("type") + JsonQuote(std::string("uiTheme")) + "," +
                       JKey("theme") + JsonQuote(th) + "," +
                       JKey("lang") + JsonQuote(g_uiLangEn ? "en" : "zh") + "}");
      PostToVisPageSoon(std::string("{") + JKey("type") + JsonQuote(std::string("uiTheme")) + "," +
                        JKey("theme") + JsonQuote(th) + "," +
                        JKey("lang") + JsonQuote(g_uiLangEn ? "en" : "zh") + "}");
      
      if (g_updToolWebview) {
        std::wstring tj = g_uiLangEn ? L"{\"lang\":1,\"dark\":" : L"{\"lang\":0,\"dark\":";
        tj += g_uiDark ? L"1}" : L"0}";
        g_updToolWebview->PostWebMessageAsJson(tj.c_str());
      }
      LogMsg("[ui] theme switched to " + th + " (all windows)");
      return S_OK;
    }
    
    if (s.find("\"ensureEngine\"") != std::string::npos) {
      
      LogMsg("[ai] ensureEngine requested (no host engine anymore, ignored)");
      return S_OK;
    }
    
    if (s.find("\"paste\"") != std::string::npos) {
      std::wstring txt = ReadClipboardText();
      LogMsg("[clip] paste -> " + std::to_string(txt.size()) + " chars");
      PostToPageSoon("{\"type\":\"clip\",\"text\":" + JsonQuote(WideToUtf8(txt)) + "}");
      return S_OK;
    }
    
    if (s.find("\"copy\"") != std::string::npos) {
      std::string t = JsonStrAfter(s, "\"text\":");
      if (!t.empty()) WriteClipboardText(Utf8ToWide(t));
      LogMsg("[clip] copy -> " + std::to_string(t.size()) + " chars");
      return S_OK;
    }
    
    if (s.find("\"checkUpdate\"") != std::string::npos) {
      OpenUpdateWindow(false);
      LogMsg("[update] share page window requested");
      return S_OK;
    }
    
    if (s.find("\"openShell\"") != std::string::npos) {
      OpenUpdateWindow(true);
      LogMsg("[shell] web search window requested");
      return S_OK;
    }
    
    if (s.find("\"openUrl\"") != std::string::npos) {
      std::string u = JsonStrAfter(s, "\"url\":");
      if (!u.empty() && (u.rfind("https://", 0) == 0 || u.rfind("http://", 0) == 0)) {
        ShellExecuteW(nullptr, L"open", Utf8ToWide(u).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        LogMsg("[update] open url -> " + u);
      } else {
        LogMsg("[update] open url rejected (not http/https)");
      }
      return S_OK;
    }
    
    if (s.find("\"openReview\"") != std::string::npos) {
      OpenReviewWindow(JsonSubObject(s, "\"record\""));
      return S_OK;
    }
    
    if (s.find("\"openVis\"") != std::string::npos) {
      OpenVisWindow();
      return S_OK;
    }
    
    if (s.find("\"savePng\"") != std::string::npos) {
      SavePngFromPage(s, g_hwnd);
      return S_OK;
    }
    
    if (s.find("\"saveTxt\"") != std::string::npos) {
      TxtSaveResult r = SaveTxtFromPage(s, g_hwnd);
      if (r.ok) {
        PostToPage("{\"type\":\"histExported\",\"n\":" + std::to_string(r.n) + "}");
        
        if (TestFlag("GB_TEST_HIST_ROUNDTRIP")) PostToPage("{\"type\":\"testHistNowImport\"}");
      }
      return S_OK;
    }
    
    if (s.find("\"openTxt\"") != std::string::npos) {
      std::string m = ReadTxtMessage(g_hwnd);
      if (!m.empty()) PostToPage(m);
      return S_OK;
    }
    
    if (s.find("\"histImported\"") != std::string::npos) {
      LogMsg("[hist] imported n=" + std::to_string(JsonIntAfter(s, "\"n\":")) +
             " fp=" + JsonStrAfter(s, "\"fp\":"));
      return S_OK;
    }
    return S_OK;
  }
};

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

static void RemoveDirRecursive(const std::wstring& dir) {
  WIN32_FIND_DATAW fd = {};
  HANDLE h = FindFirstFileW((dir + L"\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    std::wstring p = dir + L"\\" + name;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirRecursive(p);
    else DeleteFileW(p.c_str());
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  RemoveDirectoryW(dir.c_str());
}

static long long DirSizeRecursive(const std::wstring& dir) {
  long long sum = 0;
  WIN32_FIND_DATAW fd = {};
  HANDLE h = FindFirstFileW((dir + L"\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return 0;
  do {
    std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    std::wstring p = dir + L"\\" + name;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) sum += DirSizeRecursive(p);
    else sum += ((long long)fd.nFileSizeHigh << 32) | (long long)fd.nFileSizeLow;
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return sum;
}

static void ClearWebViewCache(const std::wstring& udf, const char* when) {
  if (udf.empty()) return;
  static const wchar_t* kDirs[] = {
    L"Cache", L"Code Cache", L"GPUCache", L"ShaderCache", L"VideoDecodeStats",
    L"blob_storage", L"Service Worker\CacheStorage", L"Service Worker\ScriptCache",
  };
  long long freed = 0;
  int n = 0;
  for (const wchar_t* d : kDirs) {
    std::wstring p = Join(udf, d);
    if (GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) continue;
    long long sz = DirSizeRecursive(p);
    RemoveDirRecursive(p);
    if (GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) { freed += sz; n++; }
  }
  if (n > 0)
    LogMsg("[wv2] " + std::string(when) + " 清掉 WebView2 缓存 " + std::to_string(n) +
           " 项目，约 " + std::to_string(freed / (1024 * 1024)) + " MB");
}

static std::string SysInfoJson() {
  std::string o = "{\"type\":\"sysInfo\"";

  o += ",\"cpuName\":" + JsonQuote(CpuName());
  o += ",\"physCores\":" + std::to_string(PhysCoreCount());
  o += ",\"logiCores\":" + std::to_string((int)std::thread::hardware_concurrency());
  DWORD mhz = 0;
  if (RegDword(HKEY_LOCAL_MACHINE,
               L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", L"~MHz", mhz) != ERROR_SUCCESS)
    mhz = 0;
  o += ",\"mhz\":" + std::to_string((int)mhz);

  nativeeng::CpuCaps c = nativeeng::CpuIdCaps();
  o += std::string(",\"isa\":{\"avx2\":") + (c.avx2 ? "true" : "false") +
       ",\"avx512\":" + (c.avx512f ? "true" : "false") +
       ",\"avx512vnni\":" + (c.avx512vnni ? "true" : "false") +
       ",\"avxvnni\":" + (c.avxvnni ? "true" : "false") + "}";

  int l1 = 0, l2 = 0, l3 = 0;
  {
    DWORD len = 0;
    if (!GetLogicalProcessorInformationEx(RelationCache, nullptr, &len) &&
        GetLastError() == ERROR_INSUFFICIENT_BUFFER && len > 0) {
      std::vector<char> buf(len);
      if (GetLogicalProcessorInformationEx(RelationCache,
              (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)buf.data(), &len)) {
        DWORD off = 0;
        while (off < len) {
          PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX pi =
              (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)(buf.data() + off);
          if (pi->Relationship == RelationCache) {
            int kb = (int)(pi->Cache.CacheSize / 1024);
            if (pi->Cache.Level == 1 && kb > l1) l1 = kb;
            else if (pi->Cache.Level == 2 && kb > l2) l2 = kb;
            else if (pi->Cache.Level == 3 && kb > l3) l3 = kb;
          }
          if (pi->Size == 0) break;
          off += pi->Size;
        }
      }
    }
  }
  o += std::string(",\"cache\":{\"l1\":") + std::to_string(l1) +
       ",\"l2\":" + std::to_string(l2) + ",\"l3\":" + std::to_string(l3) + "}";

  MEMORYSTATUSEX ms = {};
  ms.dwLength = sizeof(ms);
  GlobalMemoryStatusEx(&ms);
  o += ",\"memTotalMB\":" + std::to_string((long long)(ms.ullTotalPhys / (1024 * 1024)));
  o += ",\"memAvailMB\":" + std::to_string((long long)(ms.ullAvailPhys / (1024 * 1024)));
  o += ",\"memLoad\":" + std::to_string((int)ms.dwMemoryLoad);

  HKEY hk = nullptr;
  std::wstring prod, build;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE,
                    L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0, KEY_READ, &hk) == ERROR_SUCCESS && hk) {
    wchar_t b1[256] = {0}; DWORD sz = sizeof(b1), ty = 0;
    if (RegQueryValueExW(hk, L"ProductName", nullptr, &ty, (LPBYTE)b1, &sz) == ERROR_SUCCESS) prod = b1;
    wchar_t b2[64] = {0}; sz = sizeof(b2);
    if (RegQueryValueExW(hk, L"CurrentBuildNumber", nullptr, &ty, (LPBYTE)b2, &sz) == ERROR_SUCCESS) build = b2;
    else { DWORD nb = 0; if (RegDword(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"CurrentBuildNumber", nb) == ERROR_SUCCESS) build = std::to_wstring(nb); }
    RegCloseKey(hk);
  }
  o += ",\"osName\":" + JsonQuote(WideToUtf8(prod));
  o += ",\"osBuild\":" + JsonQuote(WideToUtf8(build));

  {
    wchar_t exe[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    wchar_t root[4] = {exe[0], L':', L'\\', 0};
    ULARGE_INTEGER freeBytes = {}, totalBytes = {}, totalFree = {};
    if (root[0] && GetDiskFreeSpaceExW(root, &freeBytes, &totalBytes, &totalFree))
      o += ",\"diskFreeGB\":" + std::to_string((long long)(totalFree.QuadPart / (1024ull * 1024 * 1024)));
    else
      o += ",\"diskFreeGB\":0";
  }

  o += ",\"variant\":" + JsonQuote(nativeeng::g_variant);
  o += ",\"native\":" + std::string(nativeeng::Available() ? "true" : "false");
  o += "}";
  return o;
}

static std::string SysMemJson() {
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  int totalMB = 0, availMB = 0, load = 0;
  if (GlobalMemoryStatusEx(&ms)) {
    totalMB = (int)(ms.ullTotalPhys / (1024ull * 1024ull));
    availMB = (int)(ms.ullAvailPhys / (1024ull * 1024ull));
    load = (int)ms.dwMemoryLoad;
  }
  return std::string("{\"type\":\"sysMem\",\"memTotalMB\":") + std::to_string(totalMB) +
         ",\"memAvailMB\":" + std::to_string(availMB) +
         ",\"memLoad\":" + std::to_string(load) + "}";
}

class DomHandler : public Cb<ICoreWebView2DOMContentLoadedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2DOMContentLoadedEventArgs*) override {
    
    char b[640];
    snprintf(b, sizeof(b),
             "{\"type\":\"host\",\"cpu\":%d,\"threadsDefault\":%d,\"threadsMax\":%d,"
             "\"physCores\":%d,\"memMB\":%d,\"memAvailMB\":%d,\"native\":%s,"
             "\"variant\":%s,\"cpuName\":%s}",
             CpuCount(), ThreadsDefault(), ThreadsMax(), PhysCoreCount(),
             MemTotalMB(), MemAvailMB(),
             nativeeng::Available() ? "true" : "false",
             JsonQuote(nativeeng::g_variant).c_str(), JsonQuote(CpuName()).c_str());
    PostToPage(b);
    PostToPage(SysInfoJson());   
    
    if (g_hwnd && IsWindow(g_hwnd)) SetTimer(g_hwnd, kMainTimerSysMem, kSysMemIntervalMs, nullptr);
    LogBoot("dom content loaded");
    FireTestHooks();
    return S_OK;
  }
};

static bool g_testHooksFired = false;
static void FireTestHooks() {
  if (g_testHooksFired) return;
  g_testHooksFired = true;
  
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
  
  memset(tv, 0, sizeof(tv));
  if (GetEnvironmentVariableA("GB_TEST_HIST_ROUNDTRIP", tv, sizeof(tv)) && tv[0] == '1') {
    PostToPage("{\"type\":\"testHistRoundtrip\"}");
    LogMsg("[hist] test hook: asked the page to export the history as txt");
  }
  
  memset(tv, 0, sizeof(tv));
  if (GetEnvironmentVariableA("GB_TEST_AI_BOTH", tv, sizeof(tv)) && tv[0] == '1') {
    PostToPage("{\"type\":\"testAiBoth\"}");
    LogMsg("[ai] test hook: asked the page to run the AI-vs-AI self-play walkthrough");
  }
}

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

static std::wstring UiBaseUrl(const char* tag) {
  std::wstring url = L"https://gbcalc.test/calc.html";
  if (tag && std::string(tag) == "rv")  url += L"?rv=1";
  if (tag && std::string(tag) == "vis") url += L"?vis=1";
  return url;
}

static void SetupUiServing(ICoreWebView2* wv, const char* tag) {
  std::wstring base = UiBaseUrl(tag);
  
  EventRegistrationToken rtok = {};
  HRESULT rh = wv->add_WebResourceRequested(&g_resHandler, &rtok);
  HRESULT hf = wv->AddWebResourceRequestedFilter(L"https://gbcalc.test/*",
                                                 COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  char bb[220];
  snprintf(bb, sizeof(bb),
           "[%s] UI via in-process interceptor (zero-TCP hardlink) add=0x%08lX filter=0x%08lX base=%ls",
           tag ? tag : "wv2", (unsigned long)rh, (unsigned long)hf, base.c_str());
  LogMsg(bb);
  EventRegistrationToken ptok = {};
  wv->add_ProcessFailed(new ProcFailHandler(base), &ptok);
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
        
        ICoreWebView2Settings3* st3 = nullptr;
        if (SUCCEEDED(st->QueryInterface(__uuidof(ICoreWebView2Settings3), (void**)&st3)) && st3) {
          st3->put_IsZoomControlEnabled(FALSE);
          st3->Release();
        }
        st->Release();
      }
      
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
      
      SetupUiServing(g_webview, "wv2");
      LogBoot("controller ready");
      g_webview->Navigate(MainNavUrl(UiBaseUrl(nullptr).c_str()).c_str());
      LogMsg("[wv2] navigated to " + WideToUtf8(MainNavUrl(UiBaseUrl(nullptr).c_str())));   
    }
    
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

static std::wstring UiFile() {
  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  return Join(std::wstring(tmp), L"GomokuTrainer.ui");
}

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
  
  g_uiLangEn = (lang.rfind("en", 0) == 0);
  LogMsg("[ui] splash prefs loaded (theme=" + theme + " bg=" + bg + " lang=" + lang + ")");
}

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

static void ApplyDarkTitleBar(HWND h, bool dark) {
  if (!h || !IsWindow(h)) return;
  BOOL v = dark ? TRUE : FALSE;
  if (FAILED(DwmSetWindowAttribute(h, 20, &v, sizeof(v)))) {
    DwmSetWindowAttribute(h, 19, &v, sizeof(v));
  }
}

static void SetWebviewBg(ICoreWebView2Controller* ctl, COLORREF c) {
  if (!ctl) return;
  ICoreWebView2Controller2* c2 = nullptr;
  if (FAILED(ctl->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&c2)) || !c2) return;
  COREWEBVIEW2_COLOR col = { 255, GetRValue(c), GetGValue(c), GetBValue(c) };   
  c2->put_DefaultBackgroundColor(col);
  c2->Release();
}

static void RevealMainPage() {
  g_mainPageShown = true;
  if (g_controller) g_controller->put_IsVisible(TRUE);
  if (g_hwnd && IsWindow(g_hwnd)) InvalidateRect(g_hwnd, nullptr, TRUE);
}

static const wchar_t* kBrandName = L"Meter Gomoku Trainer";

static const wchar_t* kBrandNameRv = L"Gomoku Review";

static COLORREF BrandFg() {
  return g_uiDark ? RGB(0x8c, 0xa6, 0xc0) : RGB(0x5b, 0x7a, 0x99);
}

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
    
    int dpi = GetDeviceCaps(dc, LOGPIXELSY);
    HFONT f = CreateFontW(-MulDiv(22, dpi, 72), 0, 0, 0, FW_SEMIBOLD, TRUE , FALSE, FALSE,
                          ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                          CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, BrandFontFace());
    HGDIOBJ old = SelectObject(dc, f);
    SetBkMode(dc, TRANSPARENT);
    
    const wchar_t* kMeter = L"Meter";
    size_t mlen = wcslen(kMeter);
    bool hasMeter = (wcsncmp(brand, kMeter, mlen) == 0 && brand[mlen] == L' ');
    const wchar_t* rest = hasMeter ? (brand + mlen) : brand;   
    SIZE sm = { 0, 0 }, sr = { 0, 0 };
    GetTextExtentPoint32W(dc, kMeter, (int)mlen, &sm);
    GetTextExtentPoint32W(dc, rest, (int)wcslen(rest), &sr);
    RECT rc2;
    GetClientRect(h, &rc2);
    int tx = rc2.left + ((rc2.right - rc2.left) - (sm.cx + sr.cx)) / 2;
    int ty = rc2.top + ((rc2.bottom - rc2.top) - sr.cy) / 2;
    if (hasMeter) {
      SetTextColor(dc, RGB(0x3d, 0x9b, 0xd6));                 
      TextOutW(dc, tx, ty, kMeter, (int)mlen);
    }
    SetTextColor(dc, BrandFg());
    TextOutW(dc, tx + sm.cx, ty, rest, (int)wcslen(rest));
    SelectObject(dc, old);
    DeleteObject(f);
  }
  EndPaint(h, &ps);
}

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

static bool g_rvWanted = false;      
static bool g_rvShown = false;       
static bool g_rvPageReady = false;   
static const UINT_PTR kRvTimerPrewarm = 2;   

static const UINT kMsgPrewarmRv = WM_APP + 1;

static void SetRvBackground(const std::string& hex) {
  if (!g_rvController || hex.size() < 7 || hex[0] != '#') return;
  ICoreWebView2Controller2* c2 = nullptr;
  if (FAILED(g_rvController->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&c2)) || !c2) return;
  unsigned r = 0, g = 0, b = 0;
  if (sscanf(hex.c_str(), "#%2x%2x%2x", &r, &g, &b) == 3) {
    COREWEBVIEW2_COLOR col = { 255, (BYTE)r, (BYTE)g, (BYTE)b };   
    c2->put_DefaultBackgroundColor(col);
    LogMsg("[rv] default background = " + hex);
  }
  c2->Release();
}

static void ShowReviewWindow() {
  if (!g_rvHwnd || g_rvShown) return;
  g_rvShown = true;
  ShowWindow(g_rvHwnd, SW_SHOWNORMAL);
  SetForegroundWindow(g_rvHwnd);
  LogMsg("[rv] review window shown");
}

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
      return 1;                                  
    case WM_PAINT:
      PaintSplash(h, g_rvPageReady, kBrandNameRv);  
      return 0;
    case WM_SIZE:
      LayoutRvWebView();
      return 0;
    
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      
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
      
      PostMessageW(g_hwnd, kMsgPrewarmRv, 0, 0);
      return 0;                          
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
      ApplyDarkTitleBar(g_rvHwnd, g_uiDark);           
      RevealRvPage();                                 
      SetRvBackground(JsonStrAfter(s, "\"bg\":"));     
      if (!g_rvWanted) {
        
        LogMsg("[rv] prewarmed and hidden (page ready, waiting for the user)");
        return S_OK;
      }
      LogMsg("[rv] review page ready");
      if (!g_rvPending.empty()) {
        std::string p = g_rvPending;
        g_rvPending.clear();
        PostToRvPage(p);
      }
      ShowReviewWindow();                              
      return S_OK;
    }
    
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
      SavePngFromPage(s, g_rvHwnd);       
      return S_OK;
    }
    
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
    
    SetupUiServing(g_rvWebview, "rv");
    EventRegistrationToken tok = {};
    g_rvWebview->add_WebMessageReceived(new RvMsgHandler(), &tok);
    g_rvWebview->Navigate(UiBaseUrl("rv").c_str());
    
    SetWebviewBg(ctl, g_uiBg);
    ctl->put_IsVisible(FALSE);
    LayoutRvWebView();
    LogMsg("[rv] navigated to calc.html?rv=1");
    return S_OK;
  }
};

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

static void PrewarmReviewWindow() {
  if (g_rvHwnd || g_rvCreating || !g_env) return;
  LogMsg("[rv] prewarming the review window (hidden, so the first open is instant)");
  CreateReviewWindow();
}

static void OpenReviewWindow(const std::string& recordJson) {
  std::string rec = recordJson.empty() ? std::string("{\"moves\":[]}") : recordJson;
  LogMsg("[rv] openReview record " + std::to_string(rec.size()) + " bytes");
  std::string msg = "{\"type\":\"reviewData\",\"record\":" + rec + "}";
  g_rvWanted = true;
  if (g_rvHwnd) {                                
    if (IsIconic(g_rvHwnd)) ShowWindow(g_rvHwnd, SW_RESTORE);
    if (g_rvPageReady) PostToRvPage(msg);
    else g_rvPending = msg;                      
    
    ShowReviewWindow();
    
    SetForegroundWindow(g_rvHwnd);
    return;
  }
  g_rvPending = msg;
  if (g_rvCreating || !g_env) {                  
    LogMsg(g_rvCreating ? "[rv] queued (window is being created)"
                        : "[rv] queued (webview2 env not ready)");
    
    if (g_rvHwnd) ShowReviewWindow();
    return;
  }
  CreateReviewWindow();
  if (g_rvHwnd) {
    
    ShowReviewWindow();
  }
}

static const wchar_t* kVisCls = L"GbCalcVis";
static const wchar_t* kVisTitle = L"识图 · Gomoku Vision";

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
    COREWEBVIEW2_COLOR col = { 255, (BYTE)r, (BYTE)g, (BYTE)b };   
    c2->put_DefaultBackgroundColor(col);
    LogMsg("[vis] default background = " + hex);
  }
  c2->Release();
}

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
      
      PaintSplash(h, g_visPageReady, kBrandNameVis);
      return 0;
    case WM_SIZE:
      LayoutVisWebView();
      return 0;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      
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
      return 0;                          
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
    
    if (s.find("\"visShot\"") != std::string::npos) {
      PostMessageW(g_hwnd, kMsgVisShot, 0, 0);
      return S_OK;
    }
    
    if (s.find("\"openImage\"") != std::string::npos) {
      OpenImageFromPage(s);
      return S_OK;
    }
    
    if (s.find("\"visRecognize\"") != std::string::npos) {
      std::thread(RunVisionForVis, s).detach();
      return S_OK;
    }
    
    if (s.find("\"visToTrainer\"") != std::string::npos) {
      std::string payload = JsonSubObject(s, "\"payload\"");
      if (!payload.empty()) {
        PostToPageSoon("{\"type\":\"external\",\"payload\":" + JsonQuote(payload) + "}");
        LogMsg("[vis] forwarded board to the trainer (" + std::to_string(payload.size()) + " bytes)");
      }
      return S_OK;
    }
    
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
    
    SetWebviewBg(ctl, g_uiBg);
    ctl->put_IsVisible(FALSE);
    LayoutVisWebView();
    LogMsg("[vis] navigated to calc.html?vis=1");
    return S_OK;
  }
};

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

static void OpenVisWindow() {
  LogMsg("[vis] openVis requested");
  PrewarmVisionServiceAsync();   
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
    case kMsgPrewarmRv:                        
      PrewarmReviewWindow();
      return 0;
    case kMsgVisShot:                          
      StartVisShotFlow();
      return 0;
    case WM_ERASEBKGND:
      
      return 1;
    case WM_PAINT:
      
      PaintSplash(h, g_mainPageShown, kBrandName);
      return 0;
    case WM_SIZE:
      LayoutWebView();
      return 0;
    case kMsgFlushOutbox:
      
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
      
      g_engineFlushPending = false;
      nativeeng::FlushToPage();
      return 0;
    case WM_TIMER:
      
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
      
      if (w == kMainTimerOutbox) {
        KillTimer(h, kMainTimerOutbox);
        std::vector<std::string> pg, rv;
        pg.swap(g_outboxPage);
        rv.swap(g_outboxRv);
        for (size_t i = 0; i < pg.size(); ++i) PostToPage(pg[i]);
        for (size_t i = 0; i < rv.size(); ++i) PostToRvPage(rv[i]);
        return 0;
      }
      
      if (w == kMainTimerHook) {
        KillTimer(h, kMainTimerHook);
        FireTestHooks();
        return 0;
      }
      
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
      
      if (w == kRvTimerPrewarm) {
        KillTimer(h, kRvTimerPrewarm);
        PrewarmReviewWindow();
        return 0;
      }
      
      if (w == kRvTimerTestOpen) {
        KillTimer(h, kRvTimerTestOpen);
        PostToPage("{\"type\":\"testOpenReview\"}");
        LogMsg("[rv] test hook (delayed): asked the page to open a review window");
        return 0;
      }
      
      if (w == kMainTimerSysMem) {
        PostToPage(SysMemJson());
        return 0;
      }
      break;
    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)l;
      
      int mw = GbPx(h, kMainMinCssW), mh = GbPx(h, kMainMinCssH);
      GbClampToWorkArea(h, mw, mh);
      mm->ptMinTrackSize.x = mw;
      mm->ptMinTrackSize.y = mh;
      return 0;
    }
    case WM_COPYDATA: {
      
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
    
    case WM_QUERYENDSESSION:
      return TRUE;
    case WM_ENDSESSION:
      if (w) { SaveWinPos(); DestroyWindow(h); }
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

static std::wstring WebView2UserDataDir() {
  wchar_t exePath[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, exePath, MAX_PATH);
  std::wstring oldDir = std::wstring(exePath) + L".WebView2";   
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

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
  g_bootT0 = GetTickCount();                 
  g_hInst = hInst;
  
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == FALSE) {
    SetProcessDPIAware();
  }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  nativeeng::EnsureJob();   
                            
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
  wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(1));         
  wc.hIconSm = LoadIconW(hInst, MAKEINTRESOURCEW(1));
  RegisterClassExW(&wc);

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
  
  {
    int mw = GbPx(nullptr, kMainMinCssW), mh = GbPx(nullptr, kMainMinCssH);
    GbClampToWorkArea(nullptr, mw, mh);
    if (w < mw) w = mw;
    if (h < mh) h = mh;
  }
  
  LoadUiPrefs();
  g_hwnd = CreateWindowExW(0, kCls, kTitle,
                           WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                           x, y, w, h, nullptr, nullptr, hInst, nullptr);
  if (!g_hwnd) { LogMsg("[boot] CreateWindowEx failed"); return 1; }
  ApplyDarkTitleBar(g_hwnd, g_uiDark);
  ShowWindow(g_hwnd, maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
  UpdateWindow(g_hwnd);          
  LogBoot("window shown");
  
  SetTimer(g_hwnd, kMainTimerReload, 10000, nullptr);  
  {
    char dv[8] = {0};
    if (GetEnvironmentVariableA("GB_TEST_DIAG", dv, sizeof(dv)) && dv[0] == '1')
      SetTimer(g_hwnd, kMainTimerEval, 25000, nullptr);  
  }

  LogMsg("[boot] GomokuTrainer starting (exe dir " + WideToUtf8(ExeDir()) + ")");
  
  std::wstring wv2udf = WebView2UserDataDir();
  
  ClearWebViewCache(wv2udf, "启动");
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, wv2udf.c_str(), nullptr, new EnvHandler());
  LogBoot("wv2 env requested");

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
#ifdef GB_SUITE_ENGINE
  
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
  nativeeng::ShutdownAllEngines();   
                                     
  nativeeng::CloseJobHandle();
  
  ClearWebViewCache(WebView2UserDataDir(), "退出");
  
  std::thread([] {
    Sleep(1500);
    if (UpdDirSize(WebView2UserDataDir()) >= kUpdCleanLimit) UpdSweepCacheDirs();
  }).detach();
  if (mx) CloseHandle(mx);
  CoUninitialize();
  return 0;
}
