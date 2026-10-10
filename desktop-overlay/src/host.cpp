/* Meter Gomoku Assistant overlay host - Win32 overlay, screen capture, vision pipe, native RapFi engine. */


#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <winhttp.h>
#include <gdiplus.h>
#include <objbase.h>
#include <dwmapi.h>       
#include <commctrl.h>     
#include <commdlg.h>      
#include <shlobj.h>       

#include "WebView2.h"
#include "ui_crypto.h"   

#ifndef GET_X_LPARAM
#define GET_X_LPARAM(lp) ((int)(short)LOWORD(lp))
#endif
#ifndef GET_Y_LPARAM
#define GET_Y_LPARAM(lp) ((int)(short)HIWORD(lp))
#endif

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include <mutex>
#include <algorithm>
#include <intrin.h>     
#include <immintrin.h>  

static std::wstring ExeDir() {  wchar_t buf[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring p(buf);
  size_t s = p.find_last_of(L"\\/");
  return s == std::wstring::npos ? std::wstring(L".") : p.substr(0, s);
}

static bool FileExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool DirExists(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring Join(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  if (a.back() == L'\\' || a.back() == L'/') return a + b;
  return a + L"\\" + b;
}

static std::wstring InstanceSuffix() {
  wchar_t b[64] = {0};
  if (!GetEnvironmentVariableW(L"GB_INSTANCE_ID", b, 64) || !b[0]) return L"";
  std::wstring s(b), out;
  for (size_t i = 0; i < s.size(); ++i) {
    wchar_t c = s[i];
    if ((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'z') ||
        (c >= L'A' && c <= L'Z') || c == L'-') out.push_back(c);
  }
  return out.empty() ? L"" : (L"_" + out);
}

static std::wstring SuiteRoot() {
  std::wstring d = ExeDir();
  for (int i = 0; i < 5; ++i) {
    
    if (FileExists(Join(d, L"overlay\\panel.html")) ||
        FileExists(Join(d, L"overlay\\panel.html.enc"))) return d;
    if (FileExists(Join(d, L"GomokuVision.exe"))) return d;
    
    if (FileExists(Join(d, L"Web GomokuEngine.exe"))) return d;
    if (FileExists(Join(d, L"GomokuEngine.exe"))) return d;
    if (FileExists(Join(d, L"Meter engine-server\\Web GomokuEngine.exe")) ||
        FileExists(Join(d, L"Meter engine-server\\GomokuEngine.exe")))
      return Join(d, L"Meter engine-server");
    
    if (DirExists(Join(d, L"engine-server"))) return d;
    size_t s = d.find_last_of(L"\\/");
    if (s == std::wstring::npos) break;
    d = d.substr(0, s);
  }
  return ExeDir();
}

static std::wstring Canonical(const std::wstring& p) {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetFullPathNameW(p.c_str(), MAX_PATH * 2, buf, nullptr);
  if (!n || n >= MAX_PATH * 2) return p;
  return std::wstring(buf, n);
}

static std::wstring UiDir() {
  std::wstring root = SuiteRoot();
  std::vector<std::wstring> cands;
  cands.push_back(Join(ExeDir(), L"overlay"));
  cands.push_back(Join(root, L"overlay"));
  cands.push_back(Join(ExeDir(), L"ui"));
  cands.push_back(Join(ExeDir(), L"..\\ui"));
  cands.push_back(Join(root, L"desktop-overlay\\ui"));
  for (size_t i = 0; i < cands.size(); ++i)
    if (FileExists(Join(cands[i], L"panel.html"))) return Canonical(cands[i]);
  return Canonical(Join(ExeDir(), L"overlay"));
}

static std::wstring LogDir() {
  std::wstring d = Join(ExeDir(), L"logs");
  CreateDirectoryW(d.c_str(), nullptr);
  return d;
}

static std::mutex g_logMutex;
static std::wstring g_logCur;                 
static long long g_logStart = 0;              
static const long long LOG_SLICE_MS = 15LL * 60 * 1000;   

static long long NowMs() { return (long long)GetTickCount64(); }

static std::wstring LogTimeStampName() {
  SYSTEMTIME st; GetLocalTime(&st);
  wchar_t b[64];
  swprintf_s(b, L"overlay-%04d%02d%02d-%02d%02d%02d.log",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  return Join(LogDir(), b);
}

static void PruneOldLogs() {
  WIN32_FIND_DATAW fd;
  std::wstring pat = Join(LogDir(), L"overlay-*.log");
  HANDLE h = FindFirstFileW(pat.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  std::vector<std::wstring> files;
  do { files.push_back(Join(LogDir(), fd.cFileName)); } while (FindNextFileW(h, &fd));
  FindClose(h);
  if ((int)files.size() > 500) {
    std::sort(files.begin(), files.end());   
    int del = (int)files.size() - 500;
    for (int i = 0; i < del; ++i) DeleteFileW(files[i].c_str());
  }
}

static std::wstring CurrentLogFile() {
  long long now = NowMs();
  if (g_logCur.empty() || (now - g_logStart) >= LOG_SLICE_MS) {
    g_logCur = LogTimeStampName();
    g_logStart = now;
    PruneOldLogs();
  }
  return g_logCur;
}

static LONG WINAPI CrashFilter(EXCEPTION_POINTERS* ep) {
  char b[256];
  unsigned long code = ep && ep->ExceptionRecord ? (unsigned long)ep->ExceptionRecord->ExceptionCode : 0;
  void* addr = (ep && ep->ExceptionRecord) ? ep->ExceptionRecord->ExceptionAddress : nullptr;
  snprintf(b, sizeof(b), "[crash] code=0x%08lX addr=%p", code, addr);
  FILE* f = _wfopen(Join(LogDir(), L"crash.log").c_str(), L"ab");
  if (f) { fwrite(b, 1, strlen(b), f); fwrite("\r\n", 1, 2, f); fclose(f); }
  return EXCEPTION_EXECUTE_HANDLER;
}

static bool g_hasConsole = false;

static bool ShowConsoleRequested() {
  wchar_t v[8] = {0};
  return GetEnvironmentVariableW(L"GB_SHOW_CONSOLE", v, 8) && v[0] == L'1';
}

static bool UnderTestEnv() {
  LPWCH env = GetEnvironmentStringsW();
  if (!env) return false;
  bool found = false;
  for (LPWCH p = env; *p; p += wcslen(p) + 1) {
    if (wcsncmp(p, L"GB_TEST_", 8) == 0) { found = true; break; }
  }
  FreeEnvironmentStringsW(env);
  return found;
}
static HWND g_panel = nullptr;   

static bool g_pageReady = false;                  
static bool g_showFallback = false;               
static std::wstring g_fallbackMsg;
static std::atomic<int> g_lastProcFailKind(-1);   
static std::atomic<bool> g_reloadRequested(false);
static int g_reloadTries = 0;

static std::atomic<int> g_childLaunchFails(0);
static bool g_safeRetried = false;        

static bool g_noSafeRetry = false;
static HANDLE g_suiteMutex = nullptr;     

static int g_panelOffX = -1;    
static int g_panelOffY = -1;

static int g_panelHdrH = 34;

static int g_panelMinH = 0;
static int g_panelNatH = 0;
static double g_panelNatCss = 0.0;

static int g_panelDragW = 0;        

static std::vector<std::pair<int, int>> g_panelBtnX;

static std::vector<HWND> g_wvSubclassed;

static bool g_panelDragging = false;

static RECT g_panelApplied = {0, 0, 0, 0};

static bool g_exiting = false;

static int g_panelRecoveries = 0;

static BOOL WINAPI CtrlHandler(DWORD type) {
  if (type == CTRL_CLOSE_EVENT || type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT) {
    if (g_panel) PostMessageW(g_panel, WM_CLOSE, 0, 0);
    Sleep(400);
    ExitProcess(0);
  }
  return FALSE;
}

static void SetupConsole() {
  wchar_t off[8] = {0};
  if (GetEnvironmentVariableW(L"GB_NO_CONSOLE", off, 8) && off[0] == L'1') return;
  bool ownConsole = false;                 
  if (AttachConsole(ATTACH_PARENT_PROCESS)) {
    g_hasConsole = true;                   
  } else if (AllocConsole()) {
    g_hasConsole = true;
    ownConsole = true;
  }
  if (!g_hasConsole) return;
  FILE* f = nullptr;
  freopen_s(&f, "CONOUT$", "w", stdout);
  freopen_s(&f, "CONOUT$", "w", stderr);
  freopen_s(&f, "CONIN$", "r", stdin);
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  SetConsoleTitleW(L"Gomoku Desktop Assistant - runtime log (close this window to quit)");
  SetConsoleCtrlHandler(CtrlHandler, TRUE);
  
  if (ownConsole && !ShowConsoleRequested()) {
    if (HWND cw = GetConsoleWindow()) ShowWindow(cw, SW_HIDE);
  }
  printf("\n");
  printf("==================================================================\n");
  printf("  Gomoku Desktop Assistant (screen-recognition build)\n");
  printf("  Starting up: corner L-brackets -> board blue-violet frame -> floating control panel\n");
  printf("  Runtime log is written to the log file; set GB_SHOW_CONSOLE=1 to show this window.\n");
  printf("==================================================================\n\n");
  fflush(stdout);
}

static void ConsoleLine(const std::string& utf8) {
  if (!g_hasConsole) return;
  fputs(utf8.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static std::wstring LogFile() {
  wchar_t b[MAX_PATH * 2] = {0};
  if (GetEnvironmentVariableW(L"GB_LOG_FILE", b, MAX_PATH * 2) && b[0]) return std::wstring(b);
  return CurrentLogFile();
}

static void LogMsg(const std::string& utf8) {
  ConsoleLine(utf8);
  std::wstring path;
  wchar_t envb[MAX_PATH * 2] = {0};
  if (GetEnvironmentVariableW(L"GB_LOG_FILE", envb, MAX_PATH * 2) && envb[0]) {
    path = envb;
  } else {
    std::lock_guard<std::mutex> lk(g_logMutex);
    path = CurrentLogFile();
  }
  FILE* f = _wfopen(path.c_str(), L"ab");
  if (!f) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  char head[32];
  int n = snprintf(head, sizeof(head), "[%02d:%02d:%02d] ", st.wHour, st.wMinute, st.wSecond);
  fwrite(head, 1, (size_t)n, f);
  fwrite(utf8.data(), 1, utf8.size(), f);
  fwrite("\r\n", 1, 2, f);
  fclose(f);
}

static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

namespace {

struct HttpCtx {
  CRITICAL_SECTION cs;
  HINTERNET session = nullptr;
  HttpCtx() { InitializeCriticalSection(&cs); }
  ~HttpCtx() {
    if (session) WinHttpCloseHandle(session);
    DeleteCriticalSection(&cs);
  }
};
HttpCtx g_http;                                   

struct HttpEndpoint {
  int port = 0;
  HINTERNET conn = nullptr;                       
};
HttpEndpoint g_ep[3];                             

HINTERNET HttpSession() {
  EnterCriticalSection(&g_http.cs);
  if (!g_http.session)
    g_http.session = WinHttpOpen(L"gb", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  HINTERNET s = g_http.session;
  LeaveCriticalSection(&g_http.cs);
  return s;
}

HINTERNET HttpConnFor(int port, bool forceNew) {
  EnterCriticalSection(&g_http.cs);
  if (forceNew) {
    for (auto& e : g_ep) {
      if (e.port == port && e.conn) { WinHttpCloseHandle(e.conn); e.conn = nullptr; e.port = 0; }
    }
  } else {
    for (auto& e : g_ep) {
      if (e.port == port && e.conn) { LeaveCriticalSection(&g_http.cs); return e.conn; }
    }
  }
  HINTERNET c = g_http.session
      ? WinHttpConnect(g_http.session, L"127.0.0.1", (INTERNET_PORT)port, 0)
      : nullptr;
  if (c) {
    bool stored = false;
    for (auto& e : g_ep) {
      if (!e.conn) { e.port = port; e.conn = c; stored = true; break; }
    }
    if (!stored) {          
      if (g_ep[0].conn) WinHttpCloseHandle(g_ep[0].conn);
      g_ep[0].port = port;
      g_ep[0].conn = c;
    }
  }
  LeaveCriticalSection(&g_http.cs);
  return c;
}

bool HttpOnce(HINTERNET conn, const wchar_t* method, const wchar_t* path,
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

std::string HttpRequest(int port, const wchar_t* method, const wchar_t* path,
                        const std::string& body, const wchar_t* hdr, const DWORD t4[4],
                        int* statusOut) {
  std::string out;
  if (!HttpSession()) return out;
  for (int attempt = 0; attempt < 2; ++attempt) {
    HINTERNET conn = HttpConnFor(port, attempt > 0);
    if (!conn) break;
    int code = 0;
    if (HttpOnce(conn, method, path, body, hdr, t4, &code, out)) {
      if (statusOut) *statusOut = code;
      return out;
    }
    out.clear();
  }
  return out;
}

const DWORD* HttpTimeoutHealth() {
  static const DWORD t[4] = {250, 250, 250, 250};
  return t;
}
const DWORD* HttpTimeoutData() {
  static const DWORD t[4] = {2000, 2000, 15000, 15000};
  return t;
}

}  

static bool PortAlive(int port) {
  int code = 0;
  HttpRequest(port, L"GET", L"/health", std::string(), nullptr, HttpTimeoutHealth(), &code);
  return code == 200;
}

static std::string HttpPost(int port, const wchar_t* path, const std::string& body) {
  return HttpRequest(port, L"POST", path, body, L"Content-Type: application/json",
                     HttpTimeoutData(), nullptr);
}

static bool JsonNumberIn(const std::string& s, const char* key, double& out) {
  std::string k = std::string("\"") + key + "\"";
  size_t i = s.find(k);
  if (i == std::string::npos) return false;
  i = s.find(':', i + k.size());
  if (i == std::string::npos) return false;
  i++;
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) i++;
  char* end = nullptr;
  double v = strtod(s.c_str() + i, &end);
  if (end == s.c_str() + i) return false;
  out = v;
  return true;
}

static bool JsonBoolIn(const std::string& s, const char* key, bool& out) {
  std::string k = std::string("\"") + key + "\"";
  size_t i = s.find(k);
  if (i == std::string::npos) return false;
  i = s.find(':', i + k.size());
  if (i == std::string::npos) return false;
  i++;
  while (i < s.size() && s[i] == ' ') i++;
  if (s.compare(i, 4, "true") == 0) { out = true; return true; }
  if (s.compare(i, 5, "false") == 0) { out = false; return true; }
  return false;
}

static bool JsonSetBoolFirst(std::string& s, const char* key, bool val) {
  std::string k = std::string("\"") + key + "\"";
  size_t kp = s.find(k);
  if (kp == std::string::npos) return false;
  size_t c = s.find(':', kp + k.size());
  if (c == std::string::npos) return false;
  size_t t = s.find_first_not_of(" \t", c + 1);
  if (t == std::string::npos) return false;
  if (val) {
    if (s.compare(t, 5, "false") != 0) return false;
    s.replace(t, 5, "true");
    return true;
  }
  if (s.compare(t, 4, "true") != 0) return false;
  s.replace(t, 4, "false");
  return true;
}

static bool JsonBoardRect(const std::string& s, RECT& out) {
  size_t i = s.find("\"board_rect\"");
  if (i == std::string::npos) return false;
  size_t b = s.find('{', i);
  size_t e = s.find('}', b == std::string::npos ? i : b);
  if (b == std::string::npos || e == std::string::npos) return false;
  std::string seg = s.substr(b, e - b + 1);
  double x = 0, y = 0, w = 0, h = 0;
  if (!JsonNumberIn(seg, "x", x) || !JsonNumberIn(seg, "y", y) ||
      !JsonNumberIn(seg, "w", w) || !JsonNumberIn(seg, "h", h)) return false;
  out.left = (LONG)llround(x);
  out.top = (LONG)llround(y);
  out.right = (LONG)llround(x + w);
  out.bottom = (LONG)llround(y + h);
  return true;
}

static std::vector<double> JsonNumberArray(const std::string& s, size_t from) {
  std::vector<double> out;
  size_t i = from;
  while (i < s.size()) {
    while (i < s.size() && !((s[i] >= '0' && s[i] <= '9') || s[i] == '-' || s[i] == '+' || s[i] == '.')) {
      if (s[i] == ']') return out;
      ++i;
    }
    if (i >= s.size()) break;
    const char* p = s.c_str() + i;
    char* end = nullptr;
    double v = strtod(p, &end);
    if (end == p) { ++i; continue; }
    out.push_back(v);
    i = static_cast<size_t>(end - s.c_str());
  }
  return out;
}

static bool WNumAfter(const std::wstring& w, const wchar_t* key, double& out) {
  size_t p = w.find(key);
  if (p == std::wstring::npos) return false;
  out = _wtof(w.c_str() + p + wcslen(key));
  return true;
}

static bool WStrAfter(const std::wstring& w, const wchar_t* key, std::wstring& out) {
  size_t p = w.find(key);
  if (p == std::wstring::npos) return false;
  size_t s = p + wcslen(key);              
  size_t e = w.find(L'"', s);
  if (e == std::wstring::npos) return false;
  out = w.substr(s, e - s);
  return true;
}

struct HeatCell { int x, y, tier; wchar_t label[16]; };
#define GB_HEAT_MAX 96
static HeatCell g_heat[GB_HEAT_MAX];
static std::atomic<int> g_heatN(0);
static std::atomic<int> g_heatGap(0);
static int g_guideX = 0, g_guideY = 0;
static std::atomic<int> g_guideR(0);
static std::atomic<bool> g_guideOn(false);

static RECT g_guideAnchor = { 0, 0, 0, 0 };
static RECT g_heatAnchor  = { 0, 0, 0, 0 };

struct BalCell { int x, y, seq; wchar_t color; };
#define GB_BAL_MAX 10
static BalCell g_bal[GB_BAL_MAX];
static std::atomic<int> g_balN(0);

static std::atomic<bool> g_scanHideBal(false);
static std::atomic<int> g_balGap(0);
static RECT g_balAnchor = { 0, 0, 0, 0 };

static int ParseHeatCells(const std::wstring& s, HeatCell* out, int cap) {
  int n = 0;
  size_t i = 0;
  while (i < s.size() && n < cap) {
    
    double v[3] = {0, 0, 0};
    int got = 0;
    while (got < 3) {
      while (i < s.size() && !((s[i] >= L'0' && s[i] <= L'9') || s[i] == L'-')) ++i;
      if (i >= s.size()) break;
      wchar_t* end = nullptr;
      double d = wcstod(s.c_str() + i, &end);
      if (end == s.c_str() + i) { ++i; continue; }
      v[got++] = d;
      i = static_cast<size_t>(end - s.c_str());
      if (i < s.size() && s[i] == L',') ++i;      
    }
    if (got < 3) break;
    out[n].x = static_cast<int>(llround(v[0]));
    out[n].y = static_cast<int>(llround(v[1]));
    int t = static_cast<int>(llround(v[2]));        
    if (t < 1) t = 1; else if (t > 4) t = 4;
    out[n].tier = t;
    
    int ln = 0;
    out[n].label[0] = 0;
    while (i < s.size() && s[i] != L';') {
      wchar_t c = s[i];
      if (((c >= L'0' && c <= L'9') || (c >= L'A' && c <= L'Z') ||
           (c >= L'a' && c <= L'z') || c == L'+' || c == L'-') && ln < 15) {
        out[n].label[ln++] = c;
      }
      ++i;
    }
    out[n].label[ln] = 0;
    if (i < s.size()) ++i;                        
    ++n;
  }
  return n;
}

static int ParseBalCells(const std::wstring& s, BalCell* out, int cap) {
  int n = 0;
  size_t i = 0;
  while (i < s.size() && n < cap) {
    double v[3] = { 0, 0, 0 };
    int got = 0;
    while (got < 3) {
      while (i < s.size() && !((s[i] >= L'0' && s[i] <= L'9') || s[i] == L'-')) ++i;
      if (i >= s.size()) break;
      wchar_t* end = nullptr;
      double d = wcstod(s.c_str() + i, &end);
      if (end == s.c_str() + i) { ++i; continue; }
      v[got++] = d;
      i = static_cast<size_t>(end - s.c_str());
      if (i < s.size() && s[i] == L',') ++i;      
    }
    if (got < 3) break;
    out[n].x = static_cast<int>(llround(v[0]));
    out[n].y = static_cast<int>(llround(v[1]));
    int q = static_cast<int>(llround(v[2]));
    if (q < 1) q = 1; else if (q > 10) q = 10;
    out[n].seq = q;
    out[n].color = 0;
    
    if (i < s.size() && (s[i] == L'w' || s[i] == L'b')) {
      out[n].color = s[i];
      ++i;
    }
    while (i < s.size() && s[i] != L';') ++i;     
    if (i < s.size()) ++i;
    ++n;
  }
  return n;
}

static std::atomic<bool> g_adBusy(false);

static std::atomic<bool> g_balBusy(false);
static void PostToPanel(const std::string& jsonUtf8);   

static void AutoDropPost(HWND target, int x, int y, int count) {
  LPARAM lp = MAKELPARAM((SHORT)x, (SHORT)y);
  PostMessageW(target, WM_MOUSEMOVE, 0, lp);
  for (int i = 0; i < count; ++i) {
    PostMessageW(target, WM_LBUTTONDOWN, MK_LBUTTON, lp);
    PostMessageW(target, WM_LBUTTONUP, 0, lp);
    if (i < count - 1) Sleep(120);
  }
}

static void AutoDropSendInput(int x, int y, int count) {
  POINT old = { 0, 0 };
  GetCursorPos(&old);
  int W = GetSystemMetrics(SM_CXSCREEN), H = GetSystemMetrics(SM_CYSCREEN);
  auto absNorm = [W, H](int v, int total) -> DWORD {
    return (DWORD)llround((double)v * 65535.0 / (double)(total > 0 ? total : 1));
  };
  for (int i = 0; i < count; ++i) {
    INPUT mv = {}; mv.type = INPUT_MOUSE;
    mv.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
    mv.mi.dx = absNorm(x, W); mv.mi.dy = absNorm(y, H);
    SendInput(1, &mv, sizeof(mv));
    Sleep(30);
    INPUT down = {}; down.type = INPUT_MOUSE;
    down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    SendInput(1, &down, sizeof(down));
    Sleep(40);
    INPUT up = {}; up.type = INPUT_MOUSE;
    up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, &up, sizeof(up));
    if (i < count - 1) Sleep(120);
  }
  INPUT back = {}; back.type = INPUT_MOUSE;              
  back.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
  back.mi.dx = absNorm(old.x, W); back.mi.dy = absNorm(old.y, H);
  SendInput(1, &back, sizeof(back));
}

static void AutoDropRealClick(int x, int y, int count) {
  POINT old = { 0, 0 };
  GetCursorPos(&old);
  for (int i = 0; i < count; ++i) {
    SetCursorPos(x, y);
    Sleep(40);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    Sleep(60);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    if (i < count - 1) Sleep(140);
  }
  SetCursorPos(old.x, old.y);                          
}

static void AutoDropRun(int x, int y, int count, bool force, bool real) {
  if (g_adBusy.exchange(true)) return;                   
  std::thread([x, y, count, force, real] {
    RECT wr_tmp;
    const char* pipe = "post";
    if (real) {                                          
      pipe = "real";
      AutoDropRealClick(x, y, count);
    } else if (force) {
      pipe = "sendinput";
      AutoDropSendInput(x, y, count);
    } else {
      POINT pt = { x, y };
      
      HWND target = WindowFromPoint(pt);
      if (target && GetWindowRect(target, &wr_tmp)) {
        AutoDropPost(target, x - wr_tmp.left, y - wr_tmp.top, count);
      } else {
        pipe = "sendinput";
        AutoDropSendInput(x, y, count);
      }
    }
    char msg[160];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"autodropDone\",\"pipeline\":\"%s\",\"x\":%d,\"y\":%d,\"count\":%d}",
             pipe, x, y, count);
    PostToPanel(msg);
    LogMsg(std::string("[autodrop] done pipeline=") + pipe + " (" + std::to_string(x) + "," +
           std::to_string(y) + ") x" + std::to_string(count));
    g_adBusy = false;
  }).detach();
}

static HINSTANCE g_hInst = nullptr;
static HWND g_overlay = nullptr;
static ICoreWebView2Controller* g_controller = nullptr;
static ICoreWebView2* g_webview = nullptr;

static RECT g_wvBounds = {-1, -1, -1, -1};
static std::atomic<bool> g_running(true);
static std::atomic<bool> g_hasBoard(false);
static std::atomic<bool> g_regionDirty(false);   
static RECT g_boardRect = {0, 0, 0, 0};    

struct StarMark { int x, y; };
static StarMark g_stars[5] = {{0, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0}};
static std::atomic<int> g_starN(0);
static std::atomic<int> g_starGap(0);      

static RECT g_panelCss = {0, 0, 0, 0};     
static double g_dpi = 1.0;

static double g_pageDpr = 0.0;
static ULONG_PTR g_gdiToken = 0;
static std::wstring g_uiDir;
static ICoreWebView2Environment* g_env = nullptr;   

#define COL_SCREEN_R 47
#define COL_SCREEN_G 216
#define COL_SCREEN_B 255

#define COL_BOARD_R 102
#define COL_BOARD_G 51
#define COL_BOARD_B 230

#define PANEL_RADIUS_CSS 0

#define PANEL_DESIGN_W 225                
#define PANEL_DESIGN_H 610                

static bool FixedPanelSizeEnabled() {
  wchar_t v[16] = {0};
  if (GetEnvironmentVariableW(L"GB_PANEL_FIXED_SIZE", v, 16) && v[0])
    return !(v[0] == L'0' && v[1] == L'\0');
  return true;
}

static double EffectiveDpr();   

static double PanelSizeK() {
  
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  double k = 1.0;
  if (sh >= 1200) {                       
    double sx = (double)sw / 1920.0, sy = (double)sh / 1080.0;
    k = (sx < sy ? sx : sy);
    if (k < 1.0) k = 1.0;
    if (k > 2.2) k = 2.2;
  }
  double dpr = EffectiveDpr();
  if (!(dpr >= 0.5)) dpr = 1.0;
  if (dpr > k) k = dpr;                    
  return k;
}
static void GoldenPanelSize(int* pw, int* ph) {
  double k = PanelSizeK();
  int w = (int)llround((double)PANEL_DESIGN_W * k);
  int h = (int)llround((double)PANEL_DESIGN_H * k);
  if (w < 180) w = 180;
  if (h < 300) h = 300;
  if (ph) *ph = h;
  if (pw) *pw = w;
}

static HRGN MakePanelRegion(int w, int h, int radius) {
  if (radius <= 2) return CreateRectRgn(0, 0, w + 1, h + 1);
  return CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
}

static void RefreshPanelHitSurface() {
  if (!g_panel) return;
  LONG ex = GetWindowLongW(g_panel, GWL_EXSTYLE);
  if (!(ex & WS_EX_LAYERED)) return;          
  const UINT flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
  SetWindowLongW(g_panel, GWL_EXSTYLE, ex & ~((LONG)WS_EX_LAYERED));
  SetWindowPos(g_panel, nullptr, 0, 0, 0, 0, flags);
  SetWindowLongW(g_panel, GWL_EXSTYLE, ex);
  SetWindowPos(g_panel, nullptr, 0, 0, 0, 0, flags);
  LogMsg("[panel] layered hit-surface refreshed (panel resized -> bottom row clickable again)");
}

static bool SelfCaptureAllowedForTest() {
  char v[8] = {0};
  if (GetEnvironmentVariableA("GB_TEST_CAPTURABLE", v, sizeof(v)) && v[0] == '1') return true;
  if (GetEnvironmentVariableA("GB_TEST_POS_CAPTURABLE", v, sizeof(v)) && v[0] == '1') return true;
  return false;
}

static double EffectiveDpr() {
  return (g_pageDpr >= 0.5 && g_pageDpr <= 6.0) ? g_pageDpr : g_dpi;
}

static std::wstring NavUrl() {
  wchar_t buf[2048] = {0};
  if (GetEnvironmentVariableW(L"GB_URL", buf, 2048) && buf[0]) return std::wstring(buf);
  return L"https://gb.local/panel.html";
}

static void LayoutWebView();

static void ApplyPanelZoom();
static void PostToPanel(const std::string& jsonUtf8);
static void ProbeWebView();

static void OpenPositionWindow();
static void StartSelectWindow();             
static void ClosePositionWindow();
static void RefreshPositionWindow();

static void NotifyPositionState();
static void OpenCalculatorWithBoard();   
static void ApplyPosAlpha();                       
static void ReportUiLook();                        
static void PosSavePng();                          
static void SplashDismiss();                       

static HWND g_posWnd = nullptr;

static HWND g_taskWnd = nullptr;
static bool g_taskbarMin = false;
static bool g_minPosWasVisible = false;
static LRESULT CALLBACK TaskWndProc(HWND h, UINT m, WPARAM wp, LPARAM lp);   
static void MinimizeToTaskbar();
static void RestoreFromTaskbar();

static HWND g_selectWnd = nullptr;            
static RECT g_scanRegion = {0, 0, 0, 0};      
static HBITMAP g_selBmp = nullptr;            
static int g_selBmpW = 0, g_selBmpH = 0;
static BYTE* g_selBits = nullptr;
static RECT g_selBtnRec = {0, 0, 0, 0};       
static RECT g_selBtnClose = {0, 0, 0, 0};     
static bool g_selApplied = false;             
static int  g_posHoverBtn = 0;               
static int  g_posPressBtn = 0;               
static bool g_posTracked = false;            
static int  g_posBoard[15][15] = {{0}};      
static int  g_posN = 15;
static bool g_posHasBoard = false;
static int  g_posCodeScroll = 0;             
static int  g_posCodeMaxScroll = 0;          

static int  g_posBlack = 0, g_posWhite = 0;

static bool g_posAbout = false;              
static int  g_posAboutScroll = 0;            
static int  g_posAboutMaxScroll = 0;         

static bool        g_uiDark = false;
static std::wstring g_uiLang = L"zh";
static int         g_uiOpacity = 100;
static void RunPageDiag();
static void EnableFallback();
static void SpawnDetached(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd);
static void RelaunchInSafeMode();
static void RestartForPanelRecovery();
static void ReassertTopMost();

static void EnsureWebViewSubclass();

static bool SafeModeEnabled() {
  wchar_t b[16] = {0};
  return GetEnvironmentVariableW(L"GB_WV2_SAFE", b, 16) && b[0] && b[0] != L'0';
}

static void ProbeWebView() {
  static int n = 0;
  ++n;
  
  if (g_showFallback) {
    if (g_panel) KillTimer(g_panel, 1);
    LogMsg("[probe] fell back to host display; stopping size/URL diagnostic probe");
    return;
  }
  
  if (g_pageReady && !g_reloadRequested.load()) return;
  std::wstring src;
  if (g_webview) {
    LPWSTR s = nullptr;
    if (SUCCEEDED(g_webview->get_Source(&s)) && s) { src.assign(s); CoTaskMemFree(s); }
  }
  RECT b = {0, 0, 0, 0};
  BOOL vis = FALSE;
  if (g_controller) {
    g_controller->get_Bounds(&b);
    g_controller->get_IsVisible(&vis);
  }
  char buf[512];
  snprintf(buf, sizeof(buf), "[probe#%d] source=%s bounds=%ldx%ld visible=%d",
           n, WideToUtf8(src).c_str(), (long)(b.right - b.left), (long)(b.bottom - b.top), (int)vis);
  LogMsg(buf);

  if (!g_showFallback && g_reloadRequested.exchange(false) && g_webview && g_reloadTries < 3) {
    ++g_reloadTries;
    snprintf(buf, sizeof(buf), "[wv2] page process crashed, auto-reloading panel (attempt %d)", g_reloadTries);
    LogMsg(buf);
    g_pageReady = false;
    if (g_controller) g_controller->put_IsVisible(TRUE);
    g_webview->Reload();
  }

  if (!SafeModeEnabled() && !g_safeRetried && !g_noSafeRetry && !g_pageReady &&
      g_childLaunchFails.load() >= 3) {
    RelaunchInSafeMode();
    return;
  }

  if (!g_pageReady && !g_showFallback) {
    const int failKind = g_lastProcFailKind.load();
    const bool browserDead = (failKind == 0);            
    if (browserDead || g_reloadTries >= 3 || n >= 8) {
      std::string logPath = WideToUtf8(Join(LogDir(), L"overlay-*.log"));
      char m[700];
      if (browserDead) {
        snprintf(m, sizeof(m),
                 "The panel page process has exited (kind=%d).\n\n"
                 "The rest of the program is still running: corner markers, board\n"
                 "recognition and the engine are all unaffected.\n\n"
                 "Full logs:\n%s", failKind, logPath.c_str());
      } else {
        snprintf(m, sizeof(m),
                 "The panel page was not ready within 12 seconds.\n\n"
                 "Common causes:\n"
                 "  - WebView2 runtime is missing or corrupted\n"
                 "  - Security software blocked the WebView2 child process\n"
                 "  - Graphics driver is malfunctioning\n\n"
                 "Full logs:\n%s", logPath.c_str());
      }
      g_fallbackMsg = Utf8ToWide(m);
      SplashDismiss();                   
      EnableFallback();
    }
  }

  if (n == 4) RunPageDiag();
}

static void DrawLBracket(Gdiplus::Graphics& g, float x0, float y0, float x1, float y1,
                         BYTE cr, BYTE cg, BYTE cb, float arm, float thick, float linkW = 1.4f) {
  float w = x1 - x0, h = y1 - y0;
  float a = arm;
  if (a > w / 2.4f) a = w / 2.4f;
  if (a > h / 2.4f) a = h / 2.4f;

  {
    
    Gdiplus::Pen pen(Gdiplus::Color(205, COL_SCREEN_R, COL_SCREEN_G, COL_SCREEN_B), linkW);
    g.DrawLine(&pen, x0 + a, y0, x1 - a, y0);
    g.DrawLine(&pen, x0 + a, y1, x1 - a, y1);
    g.DrawLine(&pen, x0, y0 + a, x0, y1 - a);
    g.DrawLine(&pen, x1, y0 + a, x1, y1 - a);
  }

  float p[8][4] = {
      {x0, y0 + a, x0, y0},
      {x0, y0, x0 + a, y0},
      {x1 - a, y0, x1, y0},
      {x1, y0, x1, y0 + a},
      {x1, y1 - a, x1, y1},
      {x1, y1, x1 - a, y1},
      {x0 + a, y1, x0, y1},
      {x0, y1, x0, y1 - a},
  };
  for (int pass = 0; pass < 2; ++pass) {
    Gdiplus::Color c = (pass == 0) ? Gdiplus::Color(92, cr, cg, cb) : Gdiplus::Color(255, cr, cg, cb);
    float t = (pass == 0) ? thick * 3.0f : thick;
    Gdiplus::Pen pen(c, t);
    pen.SetLineJoin(Gdiplus::LineJoinMiter);
    pen.SetStartCap(Gdiplus::LineCapFlat);
    pen.SetEndCap(Gdiplus::LineCapFlat);
    for (int i = 0; i < 8; ++i) g.DrawLine(&pen, p[i][0], p[i][1], p[i][2], p[i][3]);
  }
}

static void DrawStarMarks(Gdiplus::Graphics& g, float cx, float cy, float gap) {
  
  float arm = gap * 0.44f;
  
  float side = gap * 0.44f;
  if (arm < 9.0f) arm = 9.0f;
  if (arm > 40.0f) arm = 40.0f;
  if (side < 10.0f) side = 10.0f;
  if (side > 40.0f) side = 40.0f;
  float h = side * 0.5f;
  
  if (arm < h + gap * 0.14f) arm = h + gap * 0.14f;
  if (arm > 40.0f) arm = 40.0f;

  for (int pass = 0; pass < 2; ++pass) {
    
    Gdiplus::Color c = (pass == 0) ? Gdiplus::Color(84, 47, 216, 255)
                                   : Gdiplus::Color(255, 47, 216, 255);
    Gdiplus::Pen pen(c, (pass == 0) ? 6.5f : 3.2f);
    pen.SetStartCap(Gdiplus::LineCapRound);
    pen.SetEndCap(Gdiplus::LineCapRound);
    
    g.DrawLine(&pen, cx + h, cy, cx + arm, cy);
    g.DrawLine(&pen, cx - arm, cy, cx - h, cy);
    g.DrawLine(&pen, cx, cy + h, cx, cy + arm);
    g.DrawLine(&pen, cx, cy - arm, cx, cy - h);
  }

  {   
      
    const float dashPx = side * 0.18f;      
    const float gapPx = side * 0.12f;       
    for (int pass = 0; pass < 2; ++pass) {
      Gdiplus::Color c = (pass == 0) ? Gdiplus::Color(110, 47, 216, 255)
                                     : Gdiplus::Color(255, 47, 216, 255);
      
      const float w = (pass == 0) ? 2.4f : 1.2f;
      Gdiplus::Pen pen(c, w);
      Gdiplus::REAL pat[2] = {dashPx / w, gapPx / w};
      pen.SetDashPattern(pat, 2);
      g.DrawRectangle(&pen, cx - h, cy - h, side, side);
    }
  }
}

static void StarIndices(int size, int out[3]) {
  if (size == 13) { out[0] = 3; out[1] = 6; out[2] = 9; }
  else if (size == 19) { out[0] = 3; out[1] = 9; out[2] = 15; }
  else { out[0] = 3; out[1] = 7; out[2] = 11; }
}

static void DrawGuideCircle(Gdiplus::Graphics& g, float cx, float cy, float r) {
  if (r < 6.0f) r = 6.0f;
  if (r > 60.0f) r = 60.0f;
  for (int pass = 0; pass < 2; ++pass) {
    
    Gdiplus::Color c = (pass == 0) ? Gdiplus::Color(96, 59, 125, 216)
                                   : Gdiplus::Color(255, 59, 125, 216);
    Gdiplus::Pen pen(c, (pass == 0) ? 8.0f : 3.0f);
    g.DrawEllipse(&pen, cx - r, cy - r, r * 2.0f, r * 2.0f);
  }
  float dr = r * 0.15f;
  if (dr < 1.8f) dr = 1.8f;
  Gdiplus::SolidBrush dot(Gdiplus::Color(220, 59, 125, 216));
  g.FillEllipse(&dot, cx - dr, cy - dr, dr * 2.0f, dr * 2.0f);
}

static void DrawHeatCells(Gdiplus::Graphics& g) {
  int n = g_heatN.load();
  float gap = (float)g_heatGap.load();
  if (n <= 0 || gap < 4.0f) return;
  
  float dx = 0.0f, dy = 0.0f;
  RECT ha = g_heatAnchor;
  if (g_hasBoard.load() && ha.right > ha.left && ha.bottom > ha.top) {
    dx = (float)(g_boardRect.left - ha.left);
    dy = (float)(g_boardRect.top - ha.top);
  }
  float side = gap * 0.86f;
  
  float fsz = gap * 0.22f;
  if (fsz < 8.0f) fsz = 8.0f;
  if (fsz > 15.0f) fsz = 15.0f;
  Gdiplus::FontFamily fam(L"Segoe UI");
  Gdiplus::Font font(&fam, fsz, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  
  bool canText = (fam.GetLastStatus() == Gdiplus::Ok) && (font.GetLastStatus() == Gdiplus::Ok);
  Gdiplus::StringFormat sf;
  sf.SetAlignment(Gdiplus::StringAlignmentCenter);
  sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  sf.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  Gdiplus::SolidBrush halo(Gdiplus::Color(215, 0, 0, 0));
  Gdiplus::SolidBrush fg(Gdiplus::Color(255, 255, 255, 255));
  for (int i = 0; i < n && i < GB_HEAT_MAX; ++i) {
    const HeatCell& c = g_heat[i];
    const float px = (float)c.x + dx, py = (float)c.y + dy;
    int tier = c.tier < 1 ? 1 : (c.tier > 4 ? 4 : c.tier);
    int cr, cg, cb; BYTE a;
    
    switch (tier) {
      case 1: cr = 0;   cg = 191; cb = 165; a = 170; break;   
      case 2: cr = 67;  cg = 160; cb = 71;  a = 155; break;   
      case 3: cr = 255; cg = 127; cb = 159; a = 120; break;   
      default:cr = 255; cg = 179; cb = 193; a = 95;  break;   
    }
    Gdiplus::SolidBrush br(Gdiplus::Color(a, cr, cg, cb));
    g.FillRectangle(&br, px - side * 0.5f, py - side * 0.5f, side, side);

    if (!canText || !c.label[0]) continue;
    Gdiplus::RectF rc(px - side * 0.5f, py - side * 0.5f - 1.0f, side, side);
    
    for (int ox = -1; ox <= 1; ox += 2) {
      for (int oy = -1; oy <= 1; oy += 2) {
        Gdiplus::RectF ro(rc.X + ox * 1.3f, rc.Y + oy * 1.3f, rc.Width, rc.Height);
        g.DrawString(c.label, -1, &font, ro, &sf, &halo);
      }
    }
    g.DrawString(c.label, -1, &font, rc, &sf, &fg);
  }
}

static void AutoDropBalanced() {
  if (g_balBusy.exchange(true)) return;                  
  int n = g_balN.load();
  if (n <= 0 || n > GB_BAL_MAX) { g_balBusy = false; return; }
  RECT ba = g_balAnchor;
  long dx = 0, dy = 0;
  if (g_hasBoard.load() && ba.right > ba.left && ba.bottom > ba.top) {
    dx = g_boardRect.left - ba.left;
    dy = g_boardRect.top - ba.top;
  }
  LogMsg("[autodrop] balance mode: auto-dropping " + std::to_string(n) + " balanced points in seq order");
  for (int i = 0; i < n; ++i) {
    if (!g_running.load()) break;
    const BalCell& c = g_bal[i];
    int cx = c.x + (int)dx, cy = c.y + (int)dy;
    AutoDropRun(cx, cy, 1, true, false);
    for (int k = 0; k < 60 && g_adBusy.load(); ++k) Sleep(50);  
    Sleep(500);                                                 
  }
  LogMsg("[autodrop] balance mode finished");
  g_balBusy = false;
}
static void DrawBalCircles(Gdiplus::Graphics& g) {
  int n = g_balN.load();
  float gap = (float)g_balGap.load();
  if (n <= 0) return;
  
  if (g_scanHideBal.load()) return;
  float dx = 0.0f, dy = 0.0f;
  RECT ba = g_balAnchor;
  if (g_hasBoard.load() && ba.right > ba.left && ba.bottom > ba.top) {
    dx = (float)(g_boardRect.left - ba.left);
    dy = (float)(g_boardRect.top - ba.top);
  }
  float r = (gap > 4.0f) ? gap * 0.46f : 18.0f;   
  if (r < 6.0f) r = 6.0f;
  if (r > 60.0f) r = 60.0f;
  
  float fsz = gap * 0.44f;
  if (fsz < 15.0f) fsz = 15.0f;
  if (fsz > 34.0f) fsz = 34.0f;
  Gdiplus::FontFamily fam(L"Segoe UI");
  Gdiplus::Font font(&fam, fsz, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
  bool canText = (fam.GetLastStatus() == Gdiplus::Ok) && (font.GetLastStatus() == Gdiplus::Ok);
  Gdiplus::StringFormat sf;
  sf.SetAlignment(Gdiplus::StringAlignmentCenter);
  sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  sf.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  Gdiplus::SolidBrush halo(Gdiplus::Color(215, 0, 0, 0));
  Gdiplus::SolidBrush fg(Gdiplus::Color(255, 255, 255, 255));
  for (int i = 0; i < n && i < GB_BAL_MAX; ++i) {
    const BalCell& c = g_bal[i];
    const float cx = (float)c.x + dx, cy = (float)c.y + dy;
    
    Gdiplus::Color haloC, ringC;
    if (c.color == L'w') {
      haloC = Gdiplus::Color(96, 126, 200, 255);    
      ringC = Gdiplus::Color(255, 77, 178, 255);    
    } else if (c.color == L'b') {
      haloC = Gdiplus::Color(96, 196, 165, 245);    
      ringC = Gdiplus::Color(255, 176, 138, 240);   
    } else {
      haloC = Gdiplus::Color(96, 139, 92, 246);     
      ringC = Gdiplus::Color(255, 124, 58, 237);    
    }
    for (int pass = 0; pass < 2; ++pass) {
      Gdiplus::Color col = (pass == 0) ? haloC : ringC;
      Gdiplus::Pen pen(col, (pass == 0) ? 8.0f : 3.0f);
      g.DrawEllipse(&pen, cx - r, cy - r, r * 2.0f, r * 2.0f);
    }
    if (!canText) continue;
    wchar_t num[8];
    swprintf(num, 8, L"%d", c.seq);
    Gdiplus::RectF rc(cx - r, cy - r, r * 2.0f, r * 2.0f);
    for (int ox = -1; ox <= 1; ox += 2) {
      for (int oy = -1; oy <= 1; oy += 2) {
        Gdiplus::RectF ro(rc.X + ox * 1.3f, rc.Y + oy * 1.3f, rc.Width, rc.Height);
        g.DrawString(num, -1, &font, ro, &sf, &halo);
      }
    }
    g.DrawString(num, -1, &font, rc, &sf, &fg);
  }
}

#define MARKS_MARGIN 48                     
static HWND g_marksWnd = nullptr;           
static bool g_marksImmune = false;          
static bool g_marksProbed = false;          
static RECT g_marksRect = {0, 0, 0, 0};     

static void PaintMarksWindow();
static void PositionMarksWindow(bool repaint);

static void PaintGuideLayers(Gdiplus::Graphics& g, float ox, float oy, bool screenBracket) {
  g.TranslateTransform(-ox, -oy);

  if (!g_scanHideBal.load()) {
    DrawHeatCells(g);
    DrawBalCircles(g);
    if (g_guideOn.load()) {
      float gr = (float)g_guideR.load();
      if (gr <= 0.0f) {
        
        float g2 = (float)g_starGap.load();
        gr = (g2 > 4.0f) ? g2 * 0.46f : 18.0f;
      }
      
      float gdx = 0.0f, gdy = 0.0f;
      RECT ga = g_guideAnchor;
      if (g_hasBoard.load() && ga.right > ga.left && ga.bottom > ga.top) {
        gdx = (float)(g_boardRect.left - ga.left);
        gdy = (float)(g_boardRect.top - ga.top);
      }
      DrawGuideCircle(g, (float)g_guideX + gdx, (float)g_guideY + gdy, gr);
    }
  }

  if (screenBracket) {
    
    float m = 2.0f;
    float arm = (float)((GetSystemMetrics(SM_CXSCREEN) < GetSystemMetrics(SM_CYSCREEN)
                             ? GetSystemMetrics(SM_CXSCREEN) : GetSystemMetrics(SM_CYSCREEN)) * 0.075);
    if (arm < 64) arm = 64;
    if (arm > 132) arm = 132;
    
    DrawLBracket(g, m, m, (float)GetSystemMetrics(SM_CXSCREEN) - m, (float)GetSystemMetrics(SM_CYSCREEN) - m,
                 COL_SCREEN_R, COL_SCREEN_G, COL_SCREEN_B, arm, 6.0f, 2.8f);
  }

  if (g_hasBoard.load()) {
    RECT r = g_boardRect;
    float bw = (float)(r.right - r.left), bh = (float)(r.bottom - r.top);
    if (bw > 8 && bh > 8) {
      
      float sp = (float)g_starGap.load();
      if (sp <= 4.0f) sp = bw / 14.0f;
      float e = sp * 0.6f + 6.0f;
      
      float barm = ((bw < bh ? bw : bh) + 0.5f) / 15.0f;
      if (barm < 14) barm = 14;              
      
      float bth = (barm > 50) ? 2.4f : 2.0f;
      DrawLBracket(g, r.left - e, r.top - e, r.right + e, r.bottom + e,
                   COL_BOARD_R, COL_BOARD_G, COL_BOARD_B, barm, bth);
    }
    
    int sn = g_starN.load();
    float gap = (float)g_starGap.load();
    for (int i = 0; i < sn && i < 5; ++i) {
      DrawStarMarks(g, (float)g_stars[i].x, (float)g_stars[i].y, gap);
    }
  }
  g.ResetTransform();
}

static void PaintMarksWindow() {
  if (!g_marksWnd || !IsWindow(g_marksWnd)) return;
  const int W = g_marksRect.right - g_marksRect.left;
  const int H = g_marksRect.bottom - g_marksRect.top;
  if (W <= 0 || H <= 0) return;

  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = W;
  bi.bmiHeader.biHeight = -H;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;

  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) {
    if (bmp) DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return;
  }
  HGDIOBJ old = SelectObject(mem, bmp);
  ZeroMemory(bits, (size_t)W * H * 4);
  {
    Gdiplus::Bitmap gb(W, H, W * 4, PixelFormat32bppPARGB, (BYTE*)bits);
    Gdiplus::Graphics g(&gb);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
    PaintGuideLayers(g, (float)g_marksRect.left, (float)g_marksRect.top, false);
  }
  POINT src = {0, 0};
  SIZE size = {W, H};
  POINT dst = {g_marksRect.left, g_marksRect.top};
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(g_marksWnd, screen, &dst, &size, mem, &src, 0, &bf, ULW_ALPHA);
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
}

static void PositionMarksWindow(bool repaint) {
  if (!g_marksWnd || !IsWindow(g_marksWnd)) return;
  if (!g_hasBoard.load()) {
    if (IsWindowVisible(g_marksWnd)) ShowWindow(g_marksWnd, SW_HIDE);
    return;
  }
  RECT want = g_boardRect;
  want.left -= MARKS_MARGIN; want.top -= MARKS_MARGIN;
  want.right += MARKS_MARGIN; want.bottom += MARKS_MARGIN;
  const int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  if (want.left < 0) want.left = 0;
  if (want.top < 0) want.top = 0;
  if (want.right > sw) want.right = sw;
  if (want.bottom > sh) want.bottom = sh;
  bool moved = (want.left != g_marksRect.left || want.top != g_marksRect.top ||
                want.right != g_marksRect.right || want.bottom != g_marksRect.bottom);
  g_marksRect = want;
  if (moved) {
    SetWindowPos(g_marksWnd, HWND_TOPMOST,
                 want.left, want.top, want.right - want.left, want.bottom - want.top,
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);
    PaintMarksWindow();
  } else if (repaint) {
    if (!IsWindowVisible(g_marksWnd)) ShowWindow(g_marksWnd, SW_SHOWNOACTIVATE);
    PaintMarksWindow();
  }
}

static void ProbeMarksImmunity(HWND w) {
  g_marksProbed = true;
  const int PW = 96, PH = 64;
  RECT pr = {8, 8, 8 + PW, 8 + PH};
  g_marksRect = pr;
  SetWindowPos(w, HWND_TOPMOST, pr.left, pr.top, PW, PH, SWP_NOACTIVATE);
  
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = PW; bi.bmiHeader.biHeight = -PH;
  bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
  HDC sdc = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(sdc);
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(sdc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) { if (bmp) DeleteObject(bmp); DeleteDC(mem); ReleaseDC(nullptr, sdc); return; }
  {
    Gdiplus::Bitmap gb(PW, PH, PW * 4, PixelFormat32bppPARGB, (BYTE*)bits);
    Gdiplus::Graphics g(&gb);
    Gdiplus::SolidBrush b(Gdiplus::Color(255, 255, 0, 255));
    g.FillRectangle(&b, 0, 0, PW, PH);
  }
  POINT src = {0, 0};
  SIZE size = {PW, PH};
  POINT dst = {pr.left, pr.top};
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(w, sdc, &dst, &size, mem, &src, 0, &bf, ULW_ALPHA);
  ShowWindow(w, SW_SHOWNOACTIVATE);
  Sleep(150);                                   
  HDC cap = CreateCompatibleDC(sdc);
  HBITMAP cb = CreateCompatibleBitmap(sdc, PW, PH);
  HGDIOBJ old = SelectObject(cap, cb);
  BitBlt(cap, 0, 0, PW, PH, sdc, pr.left, pr.top, SRCCOPY | CAPTUREBLT);   
  int hit = 0;
  for (int y = 0; y < PH; ++y) {
    for (int x = 0; x < PW; ++x) {
      COLORREF c = GetPixel(cap, x, y);
      if (GetRValue(c) > 200 && GetBValue(c) > 200 && GetGValue(c) < 80) hit++;
    }
  }
  SelectObject(cap, old);
  DeleteObject(cb);
  DeleteDC(cap);
  g_marksImmune = (hit < PW * PH / 20);         
  LogMsg(std::string("[boot] marks-layer capture probe: ") +
         (g_marksImmune ? "immune (markers never enter recognition)" :
                          "NOT immune (old OS / WDA ineffective -> scan-hide fallback)")
         + " hit=" + std::to_string(hit) + "/" + std::to_string(PW * PH));
  
  ZeroMemory(bits, (size_t)PW * PH * 4);
  UpdateLayeredWindow(w, sdc, &dst, &size, mem, &src, 0, &bf, ULW_ALPHA);
  ShowWindow(w, SW_HIDE);
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, sdc);
  g_marksRect = {0, 0, 0, 0};
}

static void EnsureMarksWindow(HINSTANCE inst) {
  if (g_marksWnd && IsWindow(g_marksWnd)) return;
  WNDCLASSEXW mc;
  ZeroMemory(&mc, sizeof(mc));
  mc.cbSize = sizeof(mc);
  mc.lpfnWndProc = DefWindowProcW;             
  mc.hInstance = inst;
  mc.lpszClassName = L"GbMarksLayer";
  RegisterClassExW(&mc);
  g_marksWnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      L"GbMarksLayer", L"", WS_POPUP, 0, 0, 10, 10, nullptr, nullptr, inst, nullptr);
  if (!g_marksWnd) { LogMsg("[boot] marks-layer window creation failed"); return; }
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x11
#endif
  if (SelfCaptureAllowedForTest()) {
    LogMsg("[boot] (test) self-capture allowed -> marks layer left capturable on purpose");
    g_marksImmune = false;                     
  } else {
    BOOL wdaOk = SetWindowDisplayAffinity(g_marksWnd, WDA_EXCLUDEFROMCAPTURE);
    if (wdaOk) ProbeMarksImmunity(g_marksWnd);
    else LogMsg("[boot] marks-layer SetWindowDisplayAffinity failed -> scan-hide fallback");
  }
}

static void PaintOverlay() {
  int W = GetSystemMetrics(SM_CXSCREEN);
  int H = GetSystemMetrics(SM_CYSCREEN);
  if (W <= 0 || H <= 0) return;

  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = W;
  bi.bmiHeader.biHeight = -H;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;

  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) {
    if (bmp) DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return;
  }
  HGDIOBJ old = SelectObject(mem, bmp);
  ZeroMemory(bits, (size_t)W * H * 4);

  static unsigned backdrop = 0;        
  static bool backdropInited = false;
  if (!backdropInited) {
    backdropInited = true;
    char v[32] = {0};
    if (GetEnvironmentVariableA("GB_TEST_BACKDROP", v, sizeof(v)) && v[0]) {
      unsigned r = 0, g = 0, b = 0;
      if (sscanf(v, "%2x%2x%2x", &r, &g, &b) == 3) {
        backdrop = 0xFF000000u | (b << 16) | (g << 8) | r;   
      }
    }
  }

  {
    Gdiplus::Bitmap gb(W, H, W * 4, PixelFormat32bppPARGB, (BYTE*)bits);
    Gdiplus::Graphics g(&gb);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);

    if (!g_marksImmune) {
      PaintGuideLayers(g, 0.0f, 0.0f, true);
    } else {
      
      float m = 2.0f;
      float arm = (float)((W < H ? W : H) * 0.075);
      if (arm < 64) arm = 64;
      if (arm > 132) arm = 132;
      DrawLBracket(g, m, m, (float)W - m, (float)H - m,
                   COL_SCREEN_R, COL_SCREEN_G, COL_SCREEN_B, arm, 6.0f, 2.8f);
    }
  }

  if (backdrop) {
    unsigned* px = (unsigned*)bits;
    for (size_t i = 0; i < (size_t)W * H; ++i) px[i] = backdrop;
  }

  POINT src = {0, 0};
  SIZE size = {W, H};
  POINT dst = {0, 0};
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(g_overlay, screen, &dst, &size, mem, &src, 0, &bf, ULW_ALPHA);

  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
}

static std::wstring UiPathFromUri(const std::wstring& uri) {
  std::wstring u = uri;
  size_t p = u.find(L"://");
  if (p != std::wstring::npos) u = u.substr(p + 3);
  p = u.find(L'/');
  if (p == std::wstring::npos) return L"panel.html";      
  std::wstring path = u.substr(p + 1);
  p = path.find(L'?');
  if (p != std::wstring::npos) path = path.substr(0, p);
  if (path.empty()) path = L"panel.html";
  return path;
}

static LPCWSTR UiMimeFor(const std::wstring& path) {
  if (path.size() >= 5 && path.rfind(L".html") == path.size() - 5) return L"text/html; charset=utf-8";
  if (path.size() >= 3 && path.rfind(L".js") == path.size() - 3) return L"application/javascript; charset=utf-8";
  if (path.size() >= 4 && path.rfind(L".css") == path.size() - 4) return L"text/css; charset=utf-8";
  return L"application/octet-stream";
}

#ifdef GB_ASSISTANT_STANDALONE

static std::string JsonQuote(const std::string& s);   
static void EnsureDepJob();                           
static HANDLE DepJob();                               
namespace nativeeng {

static const int LANE_COUNT = 3;
static const char* const kLaneName[LANE_COUNT] = {"main", "sub", "fwd"};

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
static bool    g_probed  = false;
static bool    g_avail   = false;
static std::string g_diag;

static std::vector<std::string> g_badVariants;

static bool g_exhausted = false;
static bool g_smokePassed = false;   

static bool IsBadVariant(const std::string& v) {
  for (const std::string& b : g_badVariants) if (b == v) return true;
  return false;
}
static void MarkBadVariant(const std::string& v) {
  if (v.empty() || IsBadVariant(v)) return;
  g_badVariants.push_back(v);
}
static void ResetBadVariants() { g_badVariants.clear(); }
static std::string g_variant;
static std::wstring g_dir;

static int LaneIndex(const std::string& name) {
  for (int i = 0; i < LANE_COUNT; i++) if (name == kLaneName[i]) return i;
  return -1;
}

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
  if (HANDLE jb = DepJob()) AssignProcessToJobObject(jb, pi.hProcess);   
  CloseHandle(inR);
  CloseHandle(outW);  const char* script =
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
  
  if (g_exhausted) return;
  g_probed = true;
  g_smokePassed = false;
  std::wstring dir = Join(ExeDir(), L"rapfi-native");
  if (!FileExists(Join(dir, L"config.toml"))) {
    LogMsg("[engine] rapfi-native/config.toml 不存在（单机版随包必带）→ 引擎不可用");
    g_diag = "缺少 rapfi-native\\ 引擎目录（安装不完整）";
    return;
  }
  g_dir = dir;
  EnsureDepJob();
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
        g_smokePassed = true;      
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
    if (IsBadVariant(v)) continue;
    if (!VariantCpuOk(v, caps)) continue;
    if (firstOk.empty()) firstOk = v;
    if (SmokeVariantOk(dir, v)) { g_variant = v; g_smokePassed = true; break; }
    LogMsg("[engine] variant=" + std::string(v) + " 冒烟失败（多半是 CPU 实际不支持该指令集）→ 降一档");
  }
  if (g_variant.empty()) {
    
    g_variant = firstOk;
    g_smokePassed = false;
    if (g_variant.empty() && FileExists(Join(dir, L"RapfiEngine-sse.exe"))) {
      g_variant = "sse";
      g_smokePassed = false;
    }
  }
  if (g_variant.empty()) {
    g_diag = "rapfi-native/ 里没有可在本机运行的引擎 exe（文件缺失或 CPU 不支持）";
    LogMsg("[engine] rapfi-native/ 里没有可用引擎 exe");
    return;
  }
  g_avail = true;
  
  if (g_smokePassed) {
    FILE* f = _wfopen(Join(dir, L".variant-ok").c_str(), L"wb");
    if (f) {
      std::string rec = g_variant + " " + CpuFingerprint();
      fwrite(rec.data(), 1, rec.size(), f);
      fclose(f);
    }
  }
  if (g_smokePassed) {
    LogMsg("[engine] 原生 Rapfi 可用：variant=" + g_variant + " dir=" + WideToUtf8(dir));
  } else {
    
    LogMsg("[engine] 所有变体冒烟均未通过，暂用兜底 variant=" + g_variant +
           "（不写缓存，下次启动会重新探测；若仍起不来请看面板诊断）");
  }
}

static bool Available() { Probe(); return g_avail; }

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
      if (line.rfind("ERROR", 0) == 0) LogMsg("[engine:" + std::string(kLaneName[idx]) + "] " + line);
      std::lock_guard<std::mutex> lk(e.mu);
      if (e.lines.size() >= 40000) { e.lines.pop_front(); e.dropped++; }
      e.lines.push_back(line);
      e.seq++;
    }
    
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
    LogMsg("[engine:" + std::string(kLaneName[idx]) + "] " + d);
    if (downgrade) {
      
      const std::string failed = g_variant;
      MarkBadVariant(failed);
      bool exhausted = true;
      for (const char* cand : kVariantOrder) {
        if (!IsBadVariant(cand) &&
            FileExists(Join(g_dir, std::wstring(L"RapfiEngine-") + Utf8ToWide(cand) + L".exe")))
          { exhausted = false; break; }
      }
      g_variant.clear(); g_probed = false; g_avail = false;
      DeleteFileW(Join(g_dir, L".variant-ok").c_str());
      if (exhausted) {
        
        std::string why;
        for (const std::string& b : g_badVariants) { if (!why.empty()) why += "、"; why += b; }
        g_diag = "引擎变体已全部尝试仍无法启动（试过：" + why +
                 "）。多为缺少 Microsoft Visual C++ Redistributable x64，"
                 "或被安全软件隔离 —— 请安装运行库并把本目录加入白名单后重开软件。";
        g_exhausted = true;      
        LogMsg("[engine] " + g_diag);
      } else {
        LogMsg("[engine] 变体已降档：" + failed + " → 黑名单累计 " +
               std::to_string(g_badVariants.size()) + " 个，下次启动引擎时重挑可用 ISA");
      }
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
    LogMsg("[engine:" + std::string(kLaneName[idx]) + "] spawn 失败 err=" + std::to_string(ec));
    return false;
  }
  CloseHandle(pi.hThread);
  if (HANDLE jb = DepJob()) AssignProcessToJobObject(jb, pi.hProcess);   

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
  LogMsg("[engine:" + std::string(kLaneName[idx]) + "] 已启动 " + WideToUtf8(exe) + " (gen=" + std::to_string(myGen) + ")");
  return true;
}

static bool Spawn(int idx);
static bool Ensure(int idx);       

static bool Spawn(int idx) {
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  return SpawnLocked(idx);
}

static bool RespawnFresh(int idx) {
  ResetBadVariants();
  g_exhausted = false;
  g_variant.clear();
  g_probed = false;
  g_avail = false;
  LogMsg("[engine] 收到重置指令：清空变体黑名单，重新探测本机 ISA");
  return Ensure(idx);
}

static bool Ensure(int idx) {
  Probe();
  if (!g_avail) return false;
  std::lock_guard<std::mutex> lk(g_eng[idx].spawnMu);
  if (g_eng[idx].alive.load()) return true;
  return SpawnLocked(idx);
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

}  

static std::string JsonQuote(const std::string& s) {
  std::string o = "\"";
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04X", c); o += b; }
    else o += c;
  }
  o += "\"";
  return o;
}

static int PhysCoreCount() {
  SYSTEM_INFO si = {};
  GetSystemInfo(&si);
  return (int)si.dwNumberOfProcessors;
}

static long long MemAvailMB() {
  MEMORYSTATUSEX ms = {}; ms.dwLength = sizeof(ms);
  GlobalMemoryStatusEx(&ms);
  return (long long)(ms.ullAvailPhys / (1024 * 1024));
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
    payload = std::string("{\"available\":") + (nativeeng::g_avail ? "true" : "false") +
              ",\"variant\":" + JsonQuote(nativeeng::g_variant) +
              ",\"cpus\":" + std::to_string((int)std::thread::hardware_concurrency()) +
              ",\"physCores\":" + std::to_string(PhysCoreCount()) +
              ",\"memAvailMB\":" + std::to_string(MemAvailMB()) +
              ",\"lanes\":[\"main\",\"sub\",\"fwd\"]" +
              (nativeeng::g_diag.empty() ? std::string() : ",\"diag\":" + JsonQuote(nativeeng::g_diag)) +
              "}";
  } else if (idx < 0) {
    payload = "{\"error\":\"bad lane\"}";
  } else if (route == "cmd") {
    bool ok = nativeeng::WriteEnsured(idx, reqBody);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "ensure") {
    bool ok = nativeeng::Ensure(idx);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "reset") {
    
    bool ok = nativeeng::RespawnFresh(idx);
    payload = std::string("{\"ok\":") + (ok ? "true" : "false") + "}";
  } else if (route == "out") {
    uint64_t since = (uint64_t)strtoull(qget("since").c_str(), nullptr, 10);
    payload = nativeeng::Poll(idx, since);
  } else {
    payload = "{\"error\":\"unknown engine route\"}";
  }
  return payload;
}
#endif  

template <class T>
class Cb : public T {
  std::atomic<ULONG> m_ref;
 public:
  Cb() : m_ref(1) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = static_cast<T*>(this);
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)++m_ref; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = (ULONG)--m_ref;
    if (r == 0) delete this;
    return r;
  }
 protected:
  virtual ~Cb() {}
};

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

#ifdef GB_ASSISTANT_STANDALONE
    
    {
      std::wstring upath = uri, uquery;
      size_t sp = uri.find(L"://");
      if (sp != std::wstring::npos) {
        upath = uri.substr(sp + 3);
        size_t sl = upath.find(L'/');
        upath = (sl == std::wstring::npos) ? L"" : upath.substr(sl);
      }
      size_t q = upath.find(L'?');
      if (q != std::wstring::npos) { uquery = upath.substr(q + 1); upath = upath.substr(0, q); }
      if (upath.rfind(L"/engine/", 0) == 0) {
        std::string route = WideToUtf8(upath.substr(8));
        std::string query = WideToUtf8(uquery);
        std::string body;
        {
          IStream* cs = nullptr;
          if (SUCCEEDED(req->get_Content(&cs)) && cs) {
            char b[4096]; ULONG n = 0;
            for (;;) {
              if (FAILED(cs->Read(b, sizeof(b), &n)) || n == 0) break;
              body.append(b, n);
              if (body.size() > (4u << 20)) break;   
            }
            cs->Release();
          }
        }
        req->Release();
        std::string payload = NativeEngineRouteJson(route, query, body);
        std::vector<uint8_t> content(payload.begin(), payload.end());
        IStream* stream = SHCreateMemStream(content.data(), (UINT)content.size());
        if (stream && g_env) {
          ICoreWebView2WebResourceResponse* resp = nullptr;
          if (SUCCEEDED(g_env->CreateWebResourceResponse(stream, 200, L"OK",
              L"application/json; charset=utf-8\r\nCache-Control: no-store", &resp)) && resp) {
            args->put_Response(resp);
            resp->Release();
          }
          stream->Release();
        }
        return S_OK;
      }
    }
#endif
    req->Release();

    std::wstring path = UiPathFromUri(uri);
    std::vector<uint8_t> content;
    bool ok = false;
    const char* how = "none";
    
    std::wstring enc = Join(g_uiDir, path + L".enc");
    if (FileExists(enc) && gbReadEncFile(enc, content)) { ok = true; how = "enc"; }
    else if (FileExists(enc)) { how = "enc-decrypt-FAILED"; }
    
    if (!ok) {
      std::wstring plain = Join(g_uiDir, path);
      if (FileExists(plain)) {
        std::ifstream f(plain, std::ios::binary);
        if (f) { content.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()); ok = true; how = "plain"; }
      }
    }
#ifdef GB_ASSISTANT_STANDALONE
    
    if (ok && path == L"panel.html") {
      std::string html(content.begin(), content.end());
      const char* flag = "<script>var GB_STANDALONE=true;var GB_NO_WASM=true;</script>";
      size_t hp = html.find("<head>");
      if (hp == std::string::npos) hp = html.find("<HEAD>");
      if (hp != std::string::npos) html.insert(hp + 6, flag);
      else html = std::string(flag) + html;
      content.assign(html.begin(), html.end());
    }
#endif
    { char rb[512];
      snprintf(rb, sizeof(rb), "[res] %s path=%ls how=%s bytes=%zu", WideToUtf8(uri).c_str(), path.c_str(), how, content.size());
      LogMsg(rb); }
    
    if (!ok || content.empty()) {
      ICoreWebView2WebResourceResponse* nf = nullptr;
      IStream* empty = SHCreateMemStream((const BYTE*)"", 0);
      if (empty && g_env) {
        if (SUCCEEDED(g_env->CreateWebResourceResponse(empty, 404, L"Not Found", L"text/plain", &nf)) && nf) {
          args->put_Response(nf);
          nf->Release();
        }
      }
      if (empty) empty->Release();
      return S_OK;
    }

    IStream* stream = SHCreateMemStream(content.data(), (UINT)content.size());
    if (!stream) { LogMsg("[res] SHCreateMemStream failed"); return S_OK; }
    ICoreWebView2WebResourceResponse* resp = nullptr;
    HRESULT hr = g_env ? g_env->CreateWebResourceResponse(stream, 200, L"OK", UiMimeFor(path), &resp) : E_FAIL;
    if (SUCCEEDED(hr) && resp) {
      HRESULT pr = args->put_Response(resp);      
      if (FAILED(pr)) { char rb[128]; snprintf(rb, sizeof(rb), "[res] put_Response hr=0x%08lX", (unsigned long)pr); LogMsg(rb); }
      resp->Release();
    } else {
      char rb[128]; snprintf(rb, sizeof(rb), "[res] CreateWebResourceResponse hr=0x%08lX", (unsigned long)hr); LogMsg(rb);
    }
    stream->Release();
    return S_OK;
  }
};

class ScriptHandler : public Cb<ICoreWebView2ExecuteScriptCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, LPCWSTR resultJson) override {
    char buf[900];
    snprintf(buf, sizeof(buf), "[diag] ExecuteScript hr=0x%08lX result=%s",
             (unsigned long)hr, resultJson ? WideToUtf8(resultJson).substr(0, 700).c_str() : "(null)");
    LogMsg(buf);
    return S_OK;
  }
};

static void RunPageDiag() {
  if (!g_webview) return;
  HRESULT hr = g_webview->ExecuteScript(
      L"JSON.stringify({ready:document.readyState,"
      L"scripts:document.scripts.length,"
      L"kids:document.body?document.body.children.length:-1,"
      L"htmlLen:document.documentElement.innerHTML.length,"
      L"title:document.title,href:location.href})",
      new ScriptHandler());
  char buf[128];
  snprintf(buf, sizeof(buf), "[diag] launching page self-check hr=0x%08lX", (unsigned long)hr);
  LogMsg(buf);
}

class ProcFailHandler : public Cb<ICoreWebView2ProcessFailedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) override {
    int kind = -1, reason = -1;
    long long exitCode = 0;
    if (args) {
      COREWEBVIEW2_PROCESS_FAILED_KIND k = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
      args->get_ProcessFailedKind(&k);
      kind = (int)k;
      ICoreWebView2ProcessFailedEventArgs2* a2 = nullptr;
      if (SUCCEEDED(args->QueryInterface(__uuidof(ICoreWebView2ProcessFailedEventArgs2), (void**)&a2)) && a2) {
        COREWEBVIEW2_PROCESS_FAILED_REASON r = COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED;
        a2->get_Reason(&r);
        reason = (int)r;
        INT32 ec = 0;
        a2->get_ExitCode(&ec);
        exitCode = ec;
        a2->Release();
      }
    }
    char buf[256];
    snprintf(buf, sizeof(buf), "[wv2] * process failed kind=%d reason=%d exitCode=%lld", kind, reason, exitCode);
    LogMsg(buf);
    g_lastProcFailKind.store(kind);
    if (reason == 2) g_childLaunchFails.fetch_add(1);   
    
    if (kind == 1 || kind == 2 || kind == 3) g_reloadRequested.store(true);
    
    if (kind == 0 || kind == 1 || kind == 2) g_pageReady = false;
    return S_OK;
  }
};

static HRESULT DupWStr(const std::wstring& s, LPWSTR* out) {
  if (!out) return E_POINTER;
  size_t n = (s.size() + 1) * sizeof(wchar_t);
  LPWSTR p = (LPWSTR)CoTaskMemAlloc(n);
  if (!p) return E_OUTOFMEMORY;
  memcpy(p, s.c_str(), n);
  *out = p;
  return S_OK;
}

class EnvOptions : public ICoreWebView2EnvironmentOptions {
  std::atomic<ULONG> m_ref;
  std::wstring m_args;
 public:
  explicit EnvOptions(const std::wstring& args) : m_ref(1), m_args(args) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    
    if (riid == IID_IUnknown || riid == IID_ICoreWebView2EnvironmentOptions) {
      *ppv = static_cast<ICoreWebView2EnvironmentOptions*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)++m_ref; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = (ULONG)--m_ref;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE get_AdditionalBrowserArguments(LPWSTR* v) override { return DupWStr(m_args, v); }
  HRESULT STDMETHODCALLTYPE put_AdditionalBrowserArguments(LPCWSTR v) override { m_args = v ? v : L""; return S_OK; }
  HRESULT STDMETHODCALLTYPE get_Language(LPWSTR* v) override { return DupWStr(L"zh-CN", v); }
  HRESULT STDMETHODCALLTYPE put_Language(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE get_TargetCompatibleBrowserVersion(LPWSTR* v) override {
    return DupWStr(L"152.0.4191.47", v);   
  }
  HRESULT STDMETHODCALLTYPE put_TargetCompatibleBrowserVersion(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE get_AllowSingleSignOnUsingOSPrimaryAccount(BOOL* v) override {
    if (v) *v = FALSE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE put_AllowSingleSignOnUsingOSPrimaryAccount(BOOL) override { return S_OK; }
};

static std::wstring WebView2Args() {
  wchar_t buf[512] = {0};
  if (GetEnvironmentVariableW(L"GB_WV2_ARGS", buf, 512) && buf[0]) return std::wstring(buf);
  if (SafeModeEnabled()) {
    
    return L"--no-sandbox --disable-gpu --disable-gpu-compositing "
           L"--disable-features=RendererCodeIntegrity";
  }
  return L"";
}

static std::atomic<bool> g_ensureDepsRequested(false);

class MsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) override {
    LPWSTR raw = nullptr;
    std::wstring w;
    
    if (SUCCEEDED(args->TryGetWebMessageAsString(&raw)) && raw) {
      w = raw;
      CoTaskMemFree(raw);
    } else if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw) {
      w = raw;
      CoTaskMemFree(raw);
    }
    if (!w.empty()) {
      
      static int msgN = 0;
      if (w.find(L"\"panelRect\"") == std::wstring::npos && ++msgN <= 40) {
        LogMsg("[ui] received page message: " + WideToUtf8(w).substr(0, 220));
      }
      
      static int rectN = 0;
      if (w.find(L"\"panelRect\"") != std::wstring::npos) {
        if (++rectN > 1 && rectN % 4 == 0 && rectN <= 96) {
          LogMsg("[ui] panel geometry #" + std::to_string(rectN) + " " + WideToUtf8(w).substr(0, 220));
        }
      }
      
      if (w.find(L"\"type\":\"guide\"") != std::wstring::npos) {
        bool on = w.find(L"\"on\":true") != std::wstring::npos;
        double x = 0, y = 0, r = 0;
        WNumAfter(w, L"\"x\":", x);
        WNumAfter(w, L"\"y\":", y);
        WNumAfter(w, L"\"r\":", r);
        if (on) {
          g_guideX = static_cast<int>(llround(x));
          g_guideY = static_cast<int>(llround(y));
          g_guideR.store(static_cast<int>(llround(r)));
          
          g_guideAnchor = g_hasBoard.load() ? g_boardRect : RECT{ 0, 0, 0, 0 };
        }
        if (g_guideOn.exchange(on) != on && g_overlay) PostMessageW(g_overlay, WM_APP + 2, 0, 0);
        static bool toldGuide = false;
        if (on && !toldGuide) {
          toldGuide = true;
          char b[128];
          snprintf(b, sizeof(b), "[ui] guide circle: screen (%d, %d) radius %d", g_guideX, g_guideY, g_guideR.load());
          LogMsg(b);
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"ensureDeps\"") != std::wstring::npos) {
        g_ensureDepsRequested.store(true);
        return S_OK;
      }
      if (w.find(L"\"type\":\"heat\"") != std::wstring::npos) {
        bool on = w.find(L"\"on\":true") != std::wstring::npos;
        double gap = 0;
        WNumAfter(w, L"\"gap\":", gap);
        std::wstring cells;
        WStrAfter(w, L"\"cells\":\"", cells);
        int n = 0;
        if (on && !cells.empty()) n = ParseHeatCells(cells, g_heat, GB_HEAT_MAX);
        g_heatN.store(n);
        g_heatGap.store(static_cast<int>(llround(gap)));
        
        g_heatAnchor = (n > 0 && g_hasBoard.load()) ? g_boardRect : RECT{ 0, 0, 0, 0 };
        if (g_overlay) PostMessageW(g_overlay, WM_APP + 2, 0, 0);
        static bool toldHeat = false;
        if (n > 0 && !toldHeat) {
          toldHeat = true;
          LogMsg("[ui] heatmap: " + std::to_string(n) + " cells, gap " + std::to_string((int)llround(gap)));
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"balance\"") != std::wstring::npos) {
        bool on = w.find(L"\"on\":true") != std::wstring::npos;
        double gap = 0;
        WNumAfter(w, L"\"gap\":", gap);
        std::wstring cells;
        WStrAfter(w, L"\"cells\":\"", cells);
        int n = 0;
        if (on && !cells.empty()) n = ParseBalCells(cells, g_bal, GB_BAL_MAX);
        g_balN.store(n);
        g_balGap.store(static_cast<int>(llround(gap)));
        g_balAnchor = (n > 0 && g_hasBoard.load()) ? g_boardRect : RECT{ 0, 0, 0, 0 };
        if (g_overlay) PostMessageW(g_overlay, WM_APP + 2, 0, 0);
        static bool toldBal = false;
        if (n > 0 && !toldBal) {
          toldBal = true;
          LogMsg("[ui] balance points: " + std::to_string(n) + " cells, gap " + std::to_string((int)llround(gap)));
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"autodrop\"") != std::wstring::npos) {
        bool on = w.find(L"\"on\":true") != std::wstring::npos;
        if (!on) return S_OK;
        
        if (g_balN.load() > 0) { std::thread(AutoDropBalanced).detach(); return S_OK; }
        double x = 0, y = 0, cnt = 1;
        WNumAfter(w, L"\"x\":", x);
        WNumAfter(w, L"\"y\":", y);
        WNumAfter(w, L"\"count\":", cnt);
        bool force = w.find(L"\"force\":true") != std::wstring::npos;
        bool real = w.find(L"\"real\":true") != std::wstring::npos;
        if (x > 0 && y > 0 && cnt >= 1 && cnt <= 3)
          AutoDropRun((int)llround(x), (int)llround(y), (int)cnt, force, real);
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"status\"") != std::wstring::npos) {
        size_t tp = w.find(L"\"text\":\"");
        if (tp != std::wstring::npos) {
          std::wstring t = w.substr(tp + 8);
          size_t q = t.find(L'"');
          if (q != std::wstring::npos) t.resize(q);
          static std::wstring lastStatus;
          if (t != lastStatus) {
            lastStatus = t;
            LogMsg("[ui] status bar: " + WideToUtf8(t));
          }
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"log\"") != std::wstring::npos) {
        size_t tp = w.find(L"\"text\":\"");
        if (tp != std::wstring::npos) {
          std::wstring t = w.substr(tp + 8);
          size_t q = t.find(L'"');
          if (q != std::wstring::npos) t.resize(q);
          LogMsg("[ui] " + WideToUtf8(t));
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"dragStart\"") != std::wstring::npos) {
        LogMsg("[panel] page reported drag start -> handing off to native move loop");
        if (g_panel) PostMessageW(g_panel, WM_APP + 11, 0, 0);
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"savePosPng\"") != std::wstring::npos) {
        LogMsg("[ui] panel requested board PNG export (savePosPng)");
        PosSavePng();
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"quitApp\"") != std::wstring::npos) {
        LogMsg("[ui] panel requested full-app exit (quitApp)");
        g_exiting = true;
        if (g_panel) PostMessageW(g_panel, WM_CLOSE, 0, 0);
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"minToTaskbar\"") != std::wstring::npos) {
        LogMsg("[ui] panel requested minimize to taskbar");
        MinimizeToTaskbar();
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"footProbe\"") != std::wstring::npos) {
        std::wstring ids, extra;
        WStrAfter(w, L"\"ids\":\"", ids);
        WStrAfter(w, L"\"extra\":\"", extra);
        LogMsg("[probe] footbar keys: " + WideToUtf8(ids));
        LogMsg("[probe] panel/viewport:" + WideToUtf8(extra));
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"footClick\"") != std::wstring::npos) {
        std::wstring id;
        WStrAfter(w, L"\"id\":\"", id);
        LogMsg("[ui] panel received footbar click: " + WideToUtf8(id));
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"openPos\"") != std::wstring::npos) {
        int nth = 0;
        {
          size_t tp = w.find(L"\"try\":");
          if (tp != std::wstring::npos) nth = _wtoi(w.c_str() + tp + 6);
        }
        bool visible = (g_posWnd && IsWindow(g_posWnd) && IsWindowVisible(g_posWnd) &&
                        !IsIconic(g_posWnd));
        if (visible) {
          LogMsg("[ui] panel requested position window toggle -> close");
          ClosePositionWindow();
        } else {
          char b[96];
          snprintf(b, sizeof(b), "[ui] panel requested position window (openPos try=%d)", nth);
          LogMsg(b);
          OpenPositionWindow();      
        }
        NotifyPositionState();
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"posStats\"") != std::wstring::npos) {
        double bN = 0, wN = 0;
        WNumAfter(w, L"\"b\":", bN);
        WNumAfter(w, L"\"w\":", wN);
        if (bN >= 0 && bN <= 225 && wN >= 0 && wN <= 225) {
          g_posBlack = (int)bN; g_posWhite = (int)wN;
          if (g_posWnd && IsWindow(g_posWnd)) InvalidateRect(g_posWnd, nullptr, FALSE);
        }
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"openReview\"") != std::wstring::npos) {
        LogMsg("[ui] panel requested review (openReview)");
        OpenCalculatorWithBoard();
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"startAdjust\"") != std::wstring::npos) {
        LogMsg("[ui] panel requested manual-region adjust (startAdjust)");
        StartSelectWindow();
        return S_OK;
      }
      
      if (w.find(L"\"type\":\"uiLook\"") != std::wstring::npos) {
        double d = 0;
        
        bool bd = false;
        if (JsonBoolIn(WideToUtf8(w), "dark", bd)) g_uiDark = bd;
        std::wstring lang;
        if (WStrAfter(w, L"\"lang\":\"", lang)) g_uiLang = lang;
        if (JsonNumberIn(WideToUtf8(w), "opacity", d)) g_uiOpacity = (int)llround(d);
        static int lookN = 0;
        if (++lookN <= 6) LogMsg("[ui] look sync: " + WideToUtf8(w).substr(0, 200));
        ReportUiLook();
        return S_OK;
      }
      
      static bool firstRect = true;
      if (w.find(L"\"panelRect\"") != std::wstring::npos) {
        if (firstRect) {
          firstRect = false;
          LogMsg("[ui] panel reported position: " + WideToUtf8(w));
        }
        if (w.find(L"\"hidden\":true") != std::wstring::npos) return S_OK;
        
        double v[2] = {0, 0};
        const wchar_t* keys[2] = {L"\"w\":", L"\"h\":"};
        for (int i = 0; i < 2; ++i) {
          size_t p = w.find(keys[i]);
          if (p != std::wstring::npos) v[i] = _wtof(w.c_str() + p + wcslen(keys[i]));
        }
        
        size_t hp = w.find(L"\"hdrH\":");
        if (hp != std::wstring::npos) {
          double hv = _wtof(w.c_str() + hp + 7);
          if (hv >= 16 && hv <= 120) g_panelHdrH = (int)llround(hv);
        }
        
        size_t dp = w.find(L"\"dpr\":");
        if (dp != std::wstring::npos) {
          double dv = _wtof(w.c_str() + dp + 6);
          if (dv >= 0.5 && dv <= 6.0) g_pageDpr = dv;
        }
        
        size_t gp = w.find(L"\"dragW\":");
        if (gp != std::wstring::npos) {
          double gv = _wtof(w.c_str() + gp + 8);
          if (gv >= 16 && gv <= 4000) g_panelDragW = (int)llround(gv);
        }
        
        size_t bp = w.find(L"\"btnX\":\"");
        if (bp != std::wstring::npos) {
          std::wstring list = w.substr(bp + 8);
          size_t end = list.find(L'\"');
          if (end != std::wstring::npos) list.resize(end);
          std::vector<std::pair<int, int>> parsed;
          size_t i = 0;
          while (i < list.size()) {
            while (i < list.size() && !(list[i] >= L'0' && list[i] <= L'9')) ++i;
            if (i >= list.size()) break;
            int l = 0;
            while (i < list.size() && list[i] >= L'0' && list[i] <= L'9') l = l * 10 + (list[i++] - L'0');
            while (i < list.size() && !(list[i] >= L'0' && list[i] <= L'9')) ++i;
            if (i >= list.size()) break;
            int r = 0;
            while (i < list.size() && list[i] >= L'0' && list[i] <= L'9') r = r * 10 + (list[i++] - L'0');
            if (r > l && l >= 0 && r <= 4000) parsed.push_back(std::make_pair(l, r));
          }
          if (!parsed.empty()) {
            g_panelBtnX.swap(parsed);
            
            static std::wstring lastLogged;
            if (list != lastLogged) {
              lastLogged = list;
              LogMsg("[panel] title-bar button hitboxes " + std::to_string(g_panelBtnX.size()) +
                     " (CSS px): " + WideToUtf8(list) + "  drag zone = rest");
            }
          }
        }
        
        size_t mnp = w.find(L"\"hMin\":");
        if (mnp != std::wstring::npos) {
          double mv = _wtof(w.c_str() + mnp + 7);
          if (mv >= 40 && mv <= 4000) {
            double pd = (g_pageDpr > 0.3 && g_pageDpr < 8.0) ? g_pageDpr : 1.0;
            g_panelMinH = (int)llround(mv * pd);
          }
        }
        size_t ntp = w.find(L"\"hNat\":");
        if (ntp != std::wstring::npos) {
          double nv = _wtof(w.c_str() + ntp + 7);
          if (nv >= 120 && nv <= 8000) g_panelNatCss = nv;
        }
        if (v[0] > 20 && v[1] > 20) {
          g_panelCss.left = 0;
          g_panelCss.top = 0;
          g_panelCss.right = (LONG)llround(v[0]);
          g_panelCss.bottom = (LONG)llround(v[1]);
          if (g_panel) PostMessageW(g_panel, WM_APP + 1, 0, 0);
        }
      } else if (w.find(L"\"ready\"") != std::wstring::npos) {
        LogMsg("[ui] panel JS ready: " + WideToUtf8(w));
        
        NotifyPositionState();
      }
      
      if (w.find(L"\"type\":\"panelRect\"") != std::wstring::npos ||
          w.find(L"\"type\":\"ready\"") != std::wstring::npos) {
        g_pageReady = true;              
        SplashDismiss();                 
        
        static bool toldPosState = false;
        if (!toldPosState) { toldPosState = true; NotifyPositionState(); }
      }
    }
    return S_OK;
  }
};

class NavHandler : public Cb<ICoreWebView2NavigationCompletedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) override {
    BOOL ok = FALSE;
    COREWEBVIEW2_WEB_ERROR_STATUS st = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
    if (args) {
      args->get_IsSuccess(&ok);
      args->get_WebErrorStatus(&st);
    }
    char buf[512];
    snprintf(buf, sizeof(buf), "[wv2] navigation completed success=%d errStatus=%d", (int)ok, (int)st);
    LogMsg(buf);
    return S_OK;
  }
};

class DomHandler : public Cb<ICoreWebView2DOMContentLoadedEventHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2DOMContentLoadedEventArgs* args) override {
    UINT64 id = 0;
    if (args) args->get_NavigationId(&id);
    LogMsg("[wv2] DOMContentLoaded (DOM parsed)");
    return S_OK;
  }
};

static std::wstring TestProbeScript() {
  std::wstring s =
      L"(function(){try{"
      L"function snd(o){try{chrome.webview.postMessage(JSON.stringify(o));}catch(e){}}"
      L"window.addEventListener('error',function(e){snd({type:'pageError',msg:String(e.message),"
      L"src:String(e.filename),line:e.lineno,col:e.colno});});"
      L"window.addEventListener('unhandledrejection',function(e){snd({type:'pageReject',"
      L"msg:String(e.reason)});});"
      L"document.addEventListener('DOMContentLoaded',function(){snd({type:'domReady',"
      L"ready:document.readyState,scripts:document.scripts.length});});"
      L"window.addEventListener('load',function(){snd({type:'pageLoad',ready:document.readyState});});"
      L"}catch(e){}})();";
  
  int top = 0;
  {
    wchar_t v[16] = {0};
    if (GetEnvironmentVariableW(L"GB_TEST_OPACITY", v, 16) && v[0]) top = _wtoi(v);
    if (top < 25) top = 0;
    if (top > 100) top = 100;
  }
  if (top > 0) {
    
    wchar_t extra[640];
    swprintf(extra, 640,
             L"(function(){var n=0;function go(){"
             L"var r=document.getElementById('__gb_opacity_range');"
             L"if(!r){if(++n<60)setTimeout(go,150);return;}"
             L"r.value=%d;r.dispatchEvent(new Event('input',{bubbles:true}));"
             L"if(++n<8)setTimeout(go,300);}"
             L"setTimeout(go,400);})();",
             top);
    s += extra;
  }
  
  {
    wchar_t dv[16] = {0};
    bool wantDark = GetEnvironmentVariableW(L"GB_TEST_DARK", dv, 16) && dv[0] && dv[0] != L'0';
    if (wantDark) {
      
      s += L"(function(){var n=0;function go(){"
           L"var p=document.getElementById('__gb_panel');"
           L"var b=document.getElementById('__gb_dark');"
           L"if(!p||!b){if(++n<60)setTimeout(go,150);return;}"
           L"if(p.getAttribute('data-dark')!=='1')b.click();"
           L"if(++n<6)setTimeout(go,300);}"
           L"setTimeout(go,400);})();";
    }
  }
  return s;
}

static int g_wvRetry = 0;            

class CtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Controller* ctl) override {
    char buf[512];
    snprintf(buf, sizeof(buf), "[wv2] controller callback hr=0x%08lX", (unsigned long)hr);
    LogMsg(buf);
    if (FAILED(hr) || !ctl) {
      
      char eb[192];
      snprintf(eb, sizeof(eb),
               "[wv2] controller creation failed (hr=0x%08lX) -> retry %d/8 in 900ms",
               (unsigned long)hr, g_wvRetry + 1);
      LogMsg(eb);
      if (g_wvRetry < 8) {
        ++g_wvRetry;
        std::thread([]() {
          Sleep(900);
          if (g_overlay) PostMessageW(g_overlay, WM_APP + 3, 0, 0);
        }).detach();
      }
      return S_OK;
    }
    g_wvRetry = 0;
    g_controller = ctl;
    g_wvBounds = RECT{-1, -1, -1, -1};    
    g_controller->AddRef();
    ctl->get_CoreWebView2(&g_webview);
    if (g_webview) g_webview->AddRef();

    ICoreWebView2Controller2* ctl2 = nullptr;
    if (SUCCEEDED(ctl->QueryInterface(__uuidof(ICoreWebView2Controller2), (void**)&ctl2)) && ctl2) {
      COREWEBVIEW2_COLOR bg;
      bg.A = 0; bg.R = 0; bg.G = 0; bg.B = 0;
      ctl2->put_DefaultBackgroundColor(bg);
      ctl2->Release();
    }
    
    ApplyPanelZoom();
    if (g_webview) {
      
      {
        ICoreWebView2_2* wv2i = nullptr;
        if (SUCCEEDED(g_webview->QueryInterface(__uuidof(ICoreWebView2_2), (void**)&wv2i)) && wv2i) {
          EventRegistrationToken tokDom = {};
          HRESULT rd = wv2i->add_DOMContentLoaded(new DomHandler(), &tokDom);
          snprintf(buf, sizeof(buf), "[wv2] DOMContentLoaded registration hr=0x%08lX", (unsigned long)rd);
          LogMsg(buf);
          wv2i->Release();
        }
        LogMsg("[wv2] UI served by the .enc interceptor (no virtual-host mapping: it would shadow WebResourceRequested)");
      }
      
      HRESULT rap = g_webview->AddScriptToExecuteOnDocumentCreated(
          TestProbeScript().c_str(),
          nullptr);
      snprintf(buf, sizeof(buf), "[wv2] page probe injection hr=0x%08lX", (unsigned long)rap);
      LogMsg(buf);

      {
        EventRegistrationToken wrt = {};
        HRESULT rh = g_webview->add_WebResourceRequested(new ResHandler(), &wrt);
        
        HRESULT hf = g_webview->AddWebResourceRequestedFilter(L"https://gb.local/*",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        snprintf(buf, sizeof(buf),
                 "[wv2] resource interceptor registered add=0x%08lX filter=0x%08lX (decrypts .enc UI on the fly)",
                 (unsigned long)rh, (unsigned long)hf);
        LogMsg(buf);
      }

      EventRegistrationToken tok = {};
      HRESULT r1 = g_webview->add_WebMessageReceived(new MsgHandler(), &tok);
      HRESULT r2 = g_webview->add_NavigationCompleted(new NavHandler(), &tok);
      HRESULT r3 = g_webview->add_ProcessFailed(new ProcFailHandler(), &tok);
      snprintf(buf, sizeof(buf), "[wv2] event registration msg=0x%08lX nav=0x%08lX pf=0x%08lX",
               (unsigned long)r1, (unsigned long)r2, (unsigned long)r3);
      LogMsg(buf);
      HRESULT hn = g_webview->Navigate(NavUrl().c_str());
      snprintf(buf, sizeof(buf), "[wv2] Navigate hr=0x%08lX url=%s", (unsigned long)hn, WideToUtf8(NavUrl()).c_str());
      LogMsg(buf);
      
      if (g_panel) SetTimer(g_panel, 1, 1500, nullptr);
    }
    LogMsg("[wv2] prereqs ready, setting visible");
    HRESULT hv = ctl->put_IsVisible(TRUE);
    snprintf(buf, sizeof(buf), "[wv2] IsVisible hr=0x%08lX", (unsigned long)hv);
    LogMsg(buf);
    LayoutWebView();
    
    EnsureWebViewSubclass();
    LogMsg("[wv2] layout done");
    return S_OK;
  }
};

class EnvHandler : public Cb<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
 public:
  HRESULT STDMETHODCALLTYPE Invoke(HRESULT hr, ICoreWebView2Environment* env) override {
    if (FAILED(hr) || !env) { LogMsg("[wv2] environment creation failed"); return S_OK; }
    
    if (g_env) g_env->Release();
    g_env = env;
    g_env->AddRef();
    env->CreateCoreWebView2Controller(g_panel, new CtlHandler());
    return S_OK;
  }
};

static void LayoutWebView() {
  if (!g_controller) return;
  RECT r = {};
  GetClientRect(g_panel, &r);
  if (r.left == g_wvBounds.left && r.top == g_wvBounds.top &&
      r.right == g_wvBounds.right && r.bottom == g_wvBounds.bottom) {
    return;
  }
  g_wvBounds = r;
  g_controller->put_Bounds(r);
}

static void ApplyPanelZoom() {
  if (!g_controller) return;
  
  ICoreWebView2Controller3* ctl3 = nullptr;
  HRESULT hq = g_controller->QueryInterface(IID_PPV_ARGS(&ctl3));
  char zb[260];
  if (SUCCEEDED(hq) && ctl3) {
    
    double k = PanelSizeK();
    double dpr = EffectiveDpr();
    if (!(dpr >= 0.5)) dpr = 1.0;
    double zf = k / dpr;
    HRESULT hz = ctl3->put_ZoomFactor(zf);
    int pw = 0, ph = 0;
    GoldenPanelSize(&pw, &ph);
    snprintf(zb, sizeof(zb),
             "[panel] zoomFactor=%.3f (k=%.3f dpr=%.3f) hr=0x%08lX (window %dx%d, "
             "viewport=%d CSS px -> same font/layout as the bookmarklet build)",
             zf, k, dpr, (unsigned long)hz, pw, ph, (int)llround(pw / k));
    ctl3->Release();
  } else {
    snprintf(zb, sizeof(zb),
             "[panel] ICoreWebView2Controller3 unavailable hr=0x%08lX (zoom stays at the default 1.0)",
             (unsigned long)hq);
  }
  LogMsg(zb);
}

static void LoadPanelPos();
static void SavePanelPos();
static void PanelTopLeft(int w, int h, int* px, int* py);

static void ApplyPanelRect() {
  if (!g_panel || g_panelCss.right <= g_panelCss.left) return;
  
  if (g_taskbarMin) return;
  
  if (g_panelDragging) return;
  int w, h;
  if (FixedPanelSizeEnabled()) {
    
    GoldenPanelSize(&w, &h);          
    
    double dprH = EffectiveDpr();
    if (!(dprH >= 0.5)) dprH = 1.0;
    
    double cssH = (g_panelNatCss >= 160.0) ? g_panelNatCss
                                           : (double)(g_panelCss.bottom - g_panelCss.top);
    
    double kH = PanelSizeK();
    double cssMax = (double)GetSystemMetrics(SM_CYSCREEN) / kH - 16.0;
    if (cssH >= 160.0 && cssH <= cssMax) h = (int)llround(cssH * kH);
    
    g_panelNatH = h;
    
  } else {
    
    double dprOld = EffectiveDpr();
    w = (int)llround((g_panelCss.right - g_panelCss.left) * dprOld);
    h = (int)llround((g_panelCss.bottom - g_panelCss.top) * dprOld);
    
    int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
    if (w > sw - 8) w = sw - 8;
    if (h > sh - 8) h = sh - 8;
  }
  int x = 0, y = 0;
  PanelTopLeft(w, h, &x, &y);

  RECT want = {x, y, x + w, y + h};
  if (want.left == g_panelApplied.left && want.top == g_panelApplied.top &&
      want.right == g_panelApplied.right && want.bottom == g_panelApplied.bottom) {
    return;
  }
  g_panelApplied = want;

  SetWindowPos(g_panel, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  
  int rad = FixedPanelSizeEnabled() ? 0 : (int)llround((PANEL_RADIUS_CSS + 1) * EffectiveDpr());
  HRGN rgn = MakePanelRegion(w, h, rad);
  if (rgn) SetWindowRgn(g_panel, rgn, TRUE);         
  
  RefreshPanelHitSurface();
  LayoutWebView();
  {
    
    char gb[320];
    snprintf(gb, sizeof(gb),
             "[panel] applied geometry window=(%d,%d) %dx%d  panelCSS=%.0fx%.0f dpr=%.3f"
             "  nat=%.0f min=%.0f%s",
             x, y, w, h, (double)(g_panelCss.right - g_panelCss.left),
             (double)(g_panelCss.bottom - g_panelCss.top), EffectiveDpr(),
             g_panelNatCss, (double)g_panelMinH,
             FixedPanelSizeEnabled() ? "  fixedSize=1" : "  fixedSize=0");
    LogMsg(gb);
  }
}

static void OnPanelDragEnd() {
  if (!g_panel) return;
  RECT wr;
  if (!GetWindowRect(g_panel, &wr)) return;
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  g_panelOffX = sw - wr.right;      
  g_panelOffY = sh - wr.bottom;
  SavePanelPos();
  char buf[192];
  snprintf(buf, sizeof(buf), "[panel] dragged, bottom-right offset (%d, %d) saved", g_panelOffX, g_panelOffY);
  LogMsg(buf);
  
  char msg[192];
  snprintf(msg, sizeof(msg), "{\"type\":\"panelMoved\",\"offX\":%d,\"offY\":%d}",
           g_panelOffX, g_panelOffY);
  PostToPanel(msg);
}

static void SpawnDetached(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd) {
  std::wstring cmd = L"\"" + exe + L"\"";
  if (!args.empty()) cmd += L" " + args;
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE,
                     CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr,
                     cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

static HANDLE g_depJob = nullptr;               
static HANDLE g_engineProc = nullptr;           
static HANDLE g_scanProc = nullptr;             
static std::atomic<bool> g_relaunching(false);  

static void EnsureDepJob() {
  if (g_depJob) return;
  g_depJob = CreateJobObjectW(nullptr, nullptr);
  if (!g_depJob) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li;
  ZeroMemory(&li, sizeof(li));
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_depJob, JobObjectExtendedLimitInformation, &li, sizeof(li))) {
    CloseHandle(g_depJob);
    g_depJob = nullptr;
  }
}

static HANDLE DepJob() { EnsureDepJob(); return g_depJob; }

static HANDLE SpawnDetachedOwned(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd,
                                 bool intoJob = true) {
  if (intoJob) EnsureDepJob();
  std::wstring cmd = L"\"" + exe + L"\"";
  if (!args.empty()) cmd += L" " + args;
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(0);
  if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr,
                      cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) return nullptr;
  if (intoJob && g_depJob && !AssignProcessToJobObject(g_depJob, pi.hProcess)) {
    LogMsg("[deps] AssignProcessToJobObject failed (exit cleanup falls back to explicit kill)");
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  return pi.hProcess;   
}

static void KillOwnedDeps() {
  if (g_scanProc) {
    DWORD code = 0;
    if (GetExitCodeProcess(g_scanProc, &code) && code != STILL_ACTIVE) {
      CloseHandle(g_scanProc);                      
    } else {
      LogMsg("[deps] overlay exiting -> terminating the recognition service (:8971) we spawned");
      TerminateProcess(g_scanProc, 0);
      CloseHandle(g_scanProc);
    }
    g_scanProc = nullptr;
  }
#ifdef GB_ASSISTANT_STANDALONE
  
  nativeeng::ShutdownAllEngines();
#else
  
  if (g_engineProc) { CloseHandle(g_engineProc); g_engineProc = nullptr; }
#endif
  
}

static void RelaunchInSafeMode() {
  g_safeRetried = true;                                  
  wchar_t exe[MAX_PATH * 2] = {0};
  if (!GetModuleFileNameW(nullptr, exe, MAX_PATH * 2)) return;
  LogMsg("[wv2] child process repeatedly failed to launch (LAUNCH_FAILED) -> restarting in safe mode once: "
         "disabled sandbox / GPU compositing and renderer code-integrity checks");
  
  SetEnvironmentVariableW(L"GB_WV2_SAFE", L"1");
  SetEnvironmentVariableW(L"GB_SAFE_RETRY", L"1");
  g_relaunching = true;   
  SpawnDetached(exe, L"", ExeDir());
  Sleep(250);
  if (g_panel) PostMessageW(g_panel, WM_CLOSE, 0, 0);
  else PostQuitMessage(0);
}

static void ReassertTopMost() {
  if (g_panelDragging || g_exiting) return;
  
  if (g_taskbarMin) return;
  
  if (g_overlay) {
    SetWindowPos(g_overlay, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  if (g_panel) {
    SetWindowPos(g_panel, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  if (g_posWnd && IsWindow(g_posWnd)) {
    SetWindowPos(g_posWnd, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
}

static void RestoreFromTaskbar() {
  if (!g_taskbarMin) return;
  g_taskbarMin = false;
  if (g_taskWnd && IsWindow(g_taskWnd)) ShowWindow(g_taskWnd, SW_HIDE);
  if (g_overlay) ShowWindow(g_overlay, SW_SHOWNOACTIVATE);
  if (g_panel) ShowWindow(g_panel, SW_SHOWNOACTIVATE);
  if (g_minPosWasVisible && g_posWnd && IsWindow(g_posWnd)) ShowWindow(g_posWnd, SW_SHOWNOACTIVATE);
  ReassertTopMost();
  LogMsg("[ui] restored from taskbar (overlay/panel/pos shown again)");
}

static void MinimizeToTaskbar() {
  if (g_exiting || g_taskbarMin) return;
  if (!g_taskWnd || !IsWindow(g_taskWnd)) {
    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = TaskWndProc;
    wc.hInstance = g_hInst;
    wc.lpszClassName = L"GbTaskbarHost";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    
    wc.hIcon = (HICON)LoadImageW(g_hInst, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                 GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_DEFAULTCOLOR);
    wc.hIconSm = (HICON)LoadImageW(g_hInst, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                   GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR);
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
      LogMsg("[ui] RegisterClassExW(GbTaskbarHost) failed -> minimize falls back to hide-body");
      return;
    }
    
    g_taskWnd = CreateWindowExW(0, L"GbTaskbarHost",
                                (g_uiLang == L"en") ? L"Gomoku Assistant" : L"\u4e94\u5b50\u68cb\u52a9\u624b",
                                WS_OVERLAPPED | WS_MINIMIZEBOX | WS_SYSMENU,
                                -32000, -32000, 160, 40,
                                nullptr, nullptr, g_hInst, nullptr);
    if (!g_taskWnd) { LogMsg("[ui] CreateWindowExW(GbTaskbarHost) failed"); return; }
  }
  g_taskbarMin = true;
  g_minPosWasVisible = (g_posWnd && IsWindow(g_posWnd) && IsWindowVisible(g_posWnd));
  if (g_posWnd && IsWindow(g_posWnd)) ShowWindow(g_posWnd, SW_HIDE);
  if (g_panel) ShowWindow(g_panel, SW_HIDE);
  if (g_overlay) ShowWindow(g_overlay, SW_HIDE);
  LogMsg("[ui] minimized to taskbar (panel/overlay/pos hidden, taskbar button shown)");
  ShowWindow(g_taskWnd, SW_SHOWMINIMIZED);
}

static LRESULT CALLBACK TaskWndProc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  switch (m) {
    case WM_SYSCOMMAND:
      
      if ((wp & 0xFFF0) == SC_RESTORE) { RestoreFromTaskbar(); return 0; }
      break;
    case WM_CLOSE:
      
      g_exiting = true;
      if (g_panel) PostMessageW(g_panel, WM_CLOSE, 0, 0);
      else PostQuitMessage(0);
      return 0;
    case WM_DESTROY:
      if (g_taskWnd == h) g_taskWnd = nullptr;
      return 0;
  }
  return DefWindowProcW(h, m, wp, lp);
}

static void RestartForPanelRecovery() {
  const int MAX_RECOVER = 3;
  if (g_panelRecoveries >= MAX_RECOVER) {
    LogMsg("[panel] panel has been destroyed abnormally " + std::to_string(g_panelRecoveries) +
           " times; stopping self-heal; overlay window and recognition keep running (no more process restart)");
    return;                                     
  }
  wchar_t exe[MAX_PATH * 2] = {0};
  if (!GetModuleFileNameW(nullptr, exe, MAX_PATH * 2)) return;
  ++g_panelRecoveries;
  char buf[256];
  snprintf(buf, sizeof(buf),
           "[panel] panel window destroyed abnormally -> restarting overlay process for self-heal (attempt %d/%d)",
           g_panelRecoveries, MAX_RECOVER);
  LogMsg(buf);
  g_exiting = true;                             
  g_relaunching = true;                         
  {
    
    wchar_t n[8] = {0};
    _snwprintf_s(n, _TRUNCATE, L"%d", g_panelRecoveries);
    SetEnvironmentVariableW(L"GB_PANEL_RECOVER", n);
    SetEnvironmentVariableW(L"GB_SAFE_RETRY", L"1");
  }
  SpawnDetached(exe, L"", ExeDir());
  Sleep(250);
  if (g_panel) PostMessageW(g_panel, WM_CLOSE, 0, 0);
  else PostQuitMessage(0);
}

static std::atomic<unsigned long long> g_engineSpawnedAt(0);
static std::atomic<unsigned long long> g_scanSpawnedAt(0);
#define SPAWN_COOLDOWN_MS 25000

static bool ClaimSpawnSlot(std::atomic<unsigned long long>& slot) {
  unsigned long long now = GetTickCount64();
  unsigned long long cur = slot.load();
  while (true) {
    if (now - cur < SPAWN_COOLDOWN_MS) return false;      
    if (slot.compare_exchange_weak(cur, now)) return true; 
  }
}

static bool KillProcessById(DWORD pid) {
  if (!pid) return false;
  HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
  if (!h) return false;
  TerminateProcess(h, (UINT)1);
  WaitForSingleObject(h, 3000);
  CloseHandle(h);
  return true;
}

static void EnsureEngine() {
#ifdef GB_ASSISTANT_STANDALONE
  
  return;
#else
  
  static std::atomic<int> seenAlive(0);
  static std::atomic<int> restarts(0);
  if (PortAlive(8964)) {
    
    int hcode = 0;
    std::string hj = HttpRequest(8964, L"GET", L"/api/health", std::string(), nullptr,
                                 HttpTimeoutHealth(), &hcode);
    if (hcode == 200 && hj.find("\"app\":\"GomokuEngine\"") != std::string::npos) {
      double zpid = 0, upMs = 0;
      JsonNumberIn(hj, "pid", zpid);
      JsonNumberIn(hj, "upMs", upMs);
      const bool lanesDead = hj.find("\"main\":true") == std::string::npos &&
                             hj.find("\"sub\":true") == std::string::npos;
      
      static std::atomic<int> zombieStrikes(0);
      if (!lanesDead || upMs < 20000.0) zombieStrikes.store(0);
      if (lanesDead && upMs >= 20000.0) {
        if (zombieStrikes.fetch_add(1) < 1) {
          LogMsg("[deps] engine on :8964 reports variants dead (strike 1, waiting for confirm)");
          if (seenAlive.exchange(1) == 0) {
            static std::atomic<bool> told(false);
            if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");
          }
          return;
        }
        zombieStrikes.store(0);
        LogMsg("[deps] engine on :8964 is a zombie (variants dead twice) -> killing it, starting a fresh one");
        KillProcessById((DWORD)zpid);
        Sleep(800);                                   
        seenAlive.exchange(0);                        
      } else if (hj.find("\"backend\":true") != std::string::npos &&
                 hj.find("\"parentAlive\":false") != std::string::npos) {
#ifdef GB_ASSISTANT_STANDALONE
        
        if (seenAlive.exchange(1) == 0) {
          static std::atomic<bool> told(false);
          if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");
        }
        return;
#else
        
        std::string body = "{\"pid\":" + std::to_string(GetCurrentProcessId()) + "}";
        std::string ar = HttpPost(8964, L"/api/adopt", body);
        if (ar.find("\"ok\":true") != std::string::npos) {
          static std::atomic<bool> adoptedTold(false);
          if (!adoptedTold.exchange(true))
            LogMsg("[deps] adopted orphan engine (previous host gone) -> ownership transferred");
        }
        if (seenAlive.exchange(1) == 0) {
          static std::atomic<bool> told(false);
          if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");
        }
        return;
#endif
      } else {
        
        if (seenAlive.exchange(1) == 0) {
          static std::atomic<bool> told(false);
          if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");
        }
        return;
      }
    } else {
      
      if (seenAlive.exchange(1) == 0)
        LogMsg("[deps] engine :8964 occupied by a non-responding process, reusing port (health probe failed)");
      return;
    }
  }
  if (seenAlive.exchange(0) == 1) {
    LogMsg("[deps] engine :8964 went down -> restarting it (restart #" +
           std::to_string(restarts.load() + 1) + ")");
  }
  std::wstring root = SuiteRoot();
  
  std::wstring exe = Join(root, L"Web GomokuEngine.exe");
  if (!FileExists(exe)) {
    exe = Join(root, L"GomokuEngine.exe");
    if (!FileExists(exe)) { LogMsg("[deps] engine exe not found (Web GomokuEngine.exe / GomokuEngine.exe)"); return; }
  }
  if (!ClaimSpawnSlot(g_engineSpawnedAt)) return;
  LogMsg("[deps] starting engine backend --as-backend (headless, no browser)");
  if (g_engineProc) CloseHandle(g_engineProc);  
  
#ifdef GB_ASSISTANT_STANDALONE
  g_engineProc = SpawnDetachedOwned(exe, L"--as-backend", root, true);
#else
  SetEnvironmentVariableW(L"GB_PARENT_PID", std::to_wstring(GetCurrentProcessId()).c_str());
  g_engineProc = SpawnDetachedOwned(exe, L"--as-backend", root, false);
#endif
  if (!g_engineProc) LogMsg("[deps] engine spawn failed (CreateProcessW) — patrol will retry");
  restarts.fetch_add(1);
#endif  
}

static int ScanPort() {
  static int p = 0;
  if (p) return p;
  char v[16] = {0};
  if (GetEnvironmentVariableA("GB_SCAN_PORT", v, sizeof(v)) && v[0]) {
    int n = atoi(v);
    if (n >= 1024 && n <= 65535) p = n;
  }
  if (!p) p = 8971;
  return p;
}

namespace {

struct VisScanPipe {
  CRITICAL_SECTION cs;
  HANDLE pipe = nullptr;        
  VisScanPipe() { InitializeCriticalSection(&cs); }
  ~VisScanPipe() {
    if (pipe) { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
    DeleteCriticalSection(&cs);
  }
};
VisScanPipe g_vscan;

bool VisPipeIo(HANDLE h, void* buf, unsigned n, bool write) {
  char* p = (char*)buf;
  while (n > 0) {
    unsigned x = 0; DWORD got = 0, put = 0;
    if ((write ? WriteFile(h, p, n, &put, nullptr) : ReadFile(h, p, n, &got, nullptr)) == 0)
      return false;
    x = write ? put : got;
    if (x == 0) return false;
    p += x; n -= x;
  }
  return true;
}

bool VisScanCall(const std::string& body, std::string& out) {
  char noPipe[8] = {0};
  if (GetEnvironmentVariableA("GB_NO_VISION_PIPE", noPipe, sizeof(noPipe)) && noPipe[0] == '1')
    return false;                                          
  VisScanPipe& c = g_vscan;
  EnterCriticalSection(&c.cs);
  bool ok = false;
  std::string resp;
  for (int attempt = 0; attempt < 2 && !ok; ++attempt) {   
    if (!c.pipe) {
      
      wchar_t pn[64];
      swprintf_s(pn, L"\\\\.\\pipe\\GomokuVision.scan.%d", ScanPort());
      HANDLE h = CreateFileW(pn,
                             GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                             OPEN_EXISTING, 0, nullptr);
      if (h == INVALID_HANDLE_VALUE) break;                
      c.pipe = h;
    }
    unsigned char hdr[12];
    unsigned opcode = 2, plen = (unsigned)body.size();
    memcpy(hdr, "GBV1", 4);
    memcpy(hdr + 4, &opcode, 4);
    memcpy(hdr + 8, &plen, 4);
    unsigned char rp[8];
    if (VisPipeIo(c.pipe, hdr, 12, true) &&
        (plen == 0 || VisPipeIo(c.pipe, (void*)body.data(), plen, true)) &&
        VisPipeIo(c.pipe, hdr, 12, false) && memcmp(hdr, "GBV1", 4) == 0) {
      unsigned rlen = 0;
      memcpy(&rlen, hdr + 8, 4);
      if (rlen == 8 && VisPipeIo(c.pipe, rp, 8, false)) {
        unsigned status = 0, n = 0;
        memcpy(&status, rp, 4);
        memcpy(&n, rp + 4, 4);
        std::vector<char> buf(n);
        if (status == 0 && VisPipeIo(c.pipe, buf.data(), n, false)) {
          resp.assign(buf.data(), n);
          ok = true;
        }
      }
    }
    if (!ok) {                                             
      DisconnectNamedPipe(c.pipe); CloseHandle(c.pipe);
      c.pipe = nullptr;
    }
  }
  if (ok) out = std::move(resp);
  LeaveCriticalSection(&c.cs);
  return ok;
}

}  

static void EnsureScanServer() {
  
  SetEnvironmentVariableW(L"GB_PARENT_PID", std::to_wstring(GetCurrentProcessId()).c_str());
  
  static std::atomic<int> seenAlive(0);
  static std::atomic<int> restarts(0);
  if (PortAlive(ScanPort())) {
    if (seenAlive.exchange(1) == 0) {
      static std::atomic<bool> told(false);
      if (!told.exchange(true)) LogMsg("[deps] recognition service :" + std::to_string(ScanPort()) +
                                       " already running, reusing it (not launching again)");
    }
    return;
  }
  if (seenAlive.exchange(0) == 1) {
    LogMsg("[deps] recognition service :" + std::to_string(ScanPort()) +
           " went down -> restarting it (restart #" + std::to_string(restarts.load() + 1) + ")");
  }
  std::wstring root = SuiteRoot();
  
  std::wstring exe = Join(Join(root, L"Vision"), L"GomokuVision.exe");
  std::wstring cwd = Join(root, L"Vision");
  if (!FileExists(exe)) {
    exe = Join(root, L"GomokuVision.exe");
    cwd = root;
  }
  if (!FileExists(exe)) {
    
    exe = Join(root, L"desktop-vision\\build\\GomokuVision.exe");
    cwd = Join(root, L"desktop-vision\\build");
  }
  if (!FileExists(exe)) {
    LogMsg("[deps] GomokuVision.exe not found, cannot start recognition service");
    return;
  }
  if (!ClaimSpawnSlot(g_scanSpawnedAt)) return;
  LogMsg("[deps] starting recognition service GomokuVision.exe --scan on :" +
         std::to_string(ScanPort()));
  if (g_scanProc) CloseHandle(g_scanProc);      
  g_scanProc = SpawnDetachedOwned(exe, L"--scan", cwd);
  if (!g_scanProc) LogMsg("[deps] recognition service spawn failed (CreateProcessW) — patrol will retry");
  restarts.fetch_add(1);
}

static void PrewarmRecognition() {
  for (int i = 0; i < 40 && g_running.load(); ++i) {
    if (PortAlive(ScanPort())) break;
    Sleep(150);
  }
  std::string body = "{\"size\":15,\"probe\":true}";
  std::string res;
  HttpPost(ScanPort(), L"/scan", body.c_str());
  LogMsg("[deps] recognition prewarmed (first probe scan sent, model should be resident)");
}

static void PostToPanel(const std::string& jsonUtf8) {
  std::wstring w = Utf8ToWide(jsonUtf8);
  if (w.empty()) return;
  if (!g_panel || !IsWindow(g_panel)) return;
  std::wstring* heap = new std::wstring(std::move(w));
  if (!PostMessageW(g_panel, WM_APP + 3, 0, (LPARAM)heap)) delete heap;
}

static std::vector<double> JsonArrayAfterKey(const std::string& s, size_t from, const char* key) {
  size_t k = s.find(key, from);
  if (k == std::string::npos) return std::vector<double>();
  size_t b = s.find('[', k + strlen(key));
  if (b == std::string::npos) return std::vector<double>();
  return JsonNumberArray(s, b + 1);
}

static void ParseStars(const std::string& s) {
  size_t g = s.find("\"geometry\"");
  if (g == std::string::npos) { g_starN.store(0); return; }
  std::vector<double> xs = JsonArrayAfterKey(s, g, "\"x_lines\"");
  std::vector<double> ys = JsonArrayAfterKey(s, g, "\"y_lines\"");
  int size = static_cast<int>(xs.size());
  if (size < 13 || static_cast<int>(ys.size()) != size) { g_starN.store(0); return; }

  int idx[3] = {3, 7, 11};
  StarIndices(size, idx);
  const int combos[5][2] = {
      {idx[1], idx[1]},                                     
      {idx[0], idx[0]}, {idx[2], idx[0]},                   
      {idx[0], idx[2]}, {idx[2], idx[2]},                   
  };
  StarMark tmp[5];
  for (int i = 0; i < 5; ++i) {
    tmp[i].x = static_cast<int>(llround(xs[combos[i][0]]));
    tmp[i].y = static_cast<int>(llround(ys[combos[i][1]]));
  }
  double gap = 0.0;
  size_t sp = s.find("\"spacing\"", g);
  if (sp != std::string::npos) {
    size_t colon = s.find(':', sp);
    if (colon != std::string::npos) gap = atof(s.c_str() + colon + 1);
  }
  if (gap <= 0 && size > 1) gap = (xs[size - 1] - xs[0]) / (size - 1);
  if (gap <= 4.0) { g_starN.store(0); return; }

  for (int i = 0; i < 5; ++i) g_stars[i] = tmp[i];
  g_starGap.store(static_cast<int>(llround(gap)));
  g_starN.store(5);
}

#define POS_PAD       12                      
#define POS_TITLE_H   30                      
#define POS_CELL      15                      
#define POS_GRID      (POS_CELL * 14)         
#define POS_COORD_W   13                      
#define POS_COORD_H   14                      

#define POS_COORD_GAP   6                     
#define POS_CARD_PX    4                      
#define POS_CARD_PT   (POS_COORD_H / 2 + 1)   
#define POS_CARD_PB   (POS_COORD_H + POS_COORD_GAP + 2)   
#define POS_CARD_W    (POS_GRID + POS_COORD_W * 2 + POS_CARD_PX * 2)   
#define POS_CARD_H    (POS_CARD_PT + POS_GRID + POS_CARD_PB)           
#define POS_CODE_H    84                      
#define POS_BTN_H     26                      
#define POS_BTN_INSET 10                      
#define POS_GAP       8
#define POS_W         (POS_PAD + POS_CARD_W + POS_PAD)         
#define POS_BY        (POS_TITLE_H + POS_GAP)                  
#define POS_OX        (POS_PAD + POS_CARD_PX + POS_COORD_W)    
#define POS_OY        (POS_BY + POS_CARD_PT)                   
#define POS_CODE_Y    (POS_BY + POS_CARD_H + POS_GAP)          
#define POS_BTN_Y     (POS_CODE_Y + POS_CODE_H + POS_GAP)      
#define POS_H         (POS_BTN_Y + POS_BTN_H + POS_PAD)        
#define POS_RADIUS    12                      
#define POS_TBTN_W    30                      
#define POS_BTN_W     ((POS_CARD_W - POS_BTN_INSET * 2 - POS_GAP) / 2)   
#define POS_BTN_X0    (POS_PAD + POS_BTN_INSET)                          
#define POS_BTN_X1    (POS_BTN_X0 + POS_BTN_W + POS_GAP)                 

static double g_posScale = 1.0;                
static inline int PX(int v) { return (int)llround((double)v * g_posScale); }
static inline Gdiplus::REAL PXF(double v) { return (Gdiplus::REAL)(v * g_posScale); }

enum { POSHIT_NONE = 0, POSHIT_MIN = 1, POSHIT_CLOSE = 2, POSHIT_COPY = 3, POSHIT_SAVE = 4, POSHIT_ABOUT = 5 };
#define POS_TBTN_ABOUT_W  40             
static int PosTitleHit(HWND h, const POINT& c) {
  RECT rc;
  GetClientRect(h, &rc);
  int bw = PX(POS_TBTN_W);
  int aw = PX(POS_TBTN_ABOUT_W);
  if (c.y < 0 || c.y > PX(POS_TITLE_H)) return POSHIT_NONE;
  if (c.x >= rc.right - bw) return POSHIT_CLOSE;
  if (c.x >= rc.right - bw - aw) return POSHIT_ABOUT;
  return POSHIT_NONE;
}

static int PosHitTest(HWND h, const POINT& c) {
  int t = PosTitleHit(h, c);
  if (t) return t;
  if (g_posAbout) return POSHIT_NONE;
  if (c.y >= PX(POS_BTN_Y) && c.y < PX(POS_BTN_Y + POS_BTN_H)) {
    int x0 = PX(POS_BTN_X0), w = PX(POS_BTN_W);
    if (c.x >= x0 && c.x < x0 + w) return POSHIT_COPY;
    if (c.x >= PX(POS_BTN_X1) && c.x < PX(POS_BTN_X1) + w) return POSHIT_SAVE;
  }
  return POSHIT_NONE;
}

static BYTE PosAlphaValue() {
  int op = g_uiOpacity;
  if (op < 25) op = 25;
  if (op > 100) op = 100;
  int v = 60 + (int)llround((double)(op - 25) * 40.0 / 75.0);   
  if (v < 60) v = 60;
  if (v > 100) v = 100;
  return (BYTE)llround(255.0 * (double)v / 100.0);
}

static std::wstring PosT(const wchar_t* zh, const wchar_t* en) {
  return (g_uiLang == L"en") ? std::wstring(en) : std::wstring(zh);
}

static std::wstring BuildPositionCode(std::string* totalOut = nullptr) {
  auto coord = [](int x, int y) {
    char b[8];
    snprintf(b, sizeof(b), "%c%d", (char)('A' + x), g_posN - y);
    return std::string(b);
  };
  std::string s = "Gomoku15";
  int nb = 0, nw = 0;
  std::string sb, sw, sa;                 
  for (int y = 0; y < g_posN; y++) {
    for (int x = 0; x < g_posN; x++) {
      int v = g_posBoard[y][x];
      if (!v) continue;
      std::string c = coord(x, y);
      sa += c;                            
      if (v == 1) { nb++; if (!sb.empty()) sb += ","; sb += c; }
      else        { nw++; if (!sw.empty()) sw += ","; sw += c; }
    }
  }
  s += "  B:" + std::to_string(nb) + "  W:" + std::to_string(nw) + "\n";
  
  s += "A: " + sa + "\n";
  s += "B: " + sb + "\n";
  s += "W: " + sw + "\n";
  if (totalOut) *totalOut = sa;          
  return Utf8ToWide(s);
}

static void PosCopyCode() {
  std::string total;
  BuildPositionCode(&total);
  if (total.empty()) {
    
    LogMsg("[pos] copy skipped: board is empty (no stones -> no total code)");
    return;
  }
  std::wstring code = Utf8ToWide(total);
  if (!OpenClipboard(g_posWnd)) {
    LogMsg("[pos] copy failed: OpenClipboard returned false");
    return;
  }
  EmptyClipboard();
  size_t bytes = (code.size() + 1) * sizeof(wchar_t);
  HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (h) {
    void* p = GlobalLock(h);
    if (p) { memcpy(p, code.c_str(), bytes); GlobalUnlock(h); }
    SetClipboardData(CF_UNICODETEXT, h);
  }
  CloseClipboard();
  LogMsg("[pos] total code copied to clipboard (" + std::to_string(total.size()) + " chars)");
}

static void PosSaveCode() {
  std::wstring code = BuildPositionCode();
  wchar_t name[MAX_PATH] = L"gomoku-position.txt";
  wchar_t path[MAX_PATH] = {0};
  OPENFILENAMEW ofn;
  ZeroMemory(&ofn, sizeof(ofn));
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = g_posWnd;
  ofn.lpstrFile = path;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrFileTitle = nullptr;
  ofn.lpstrFilter = L"Text files (*.txt)\0*.txt\0All files (*.*)\0*.*\0";
  ofn.nFilterIndex = 1;
  ofn.lpstrDefExt = L"txt";
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
  
  wchar_t desk[MAX_PATH] = {0};
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, 0, desk)) && desk[0]) {
    ofn.lpstrInitialDir = desk;
  }
  
  {
    SYSTEMTIME st; GetLocalTime(&st);
    swprintf(name, MAX_PATH, L"gomoku-position-%04d%02d%02d-%02d%02d%02d.txt",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  }
  wcsncpy_s(path, MAX_PATH, name, _TRUNCATE);

  if (!GetSaveFileNameW(&ofn)) return;                 
  std::string utf8 = WideToUtf8(code);
  
  std::string crlf;
  for (char c : utf8) { if (c == '\n') crlf += "\r\n"; else crlf += c; }
  FILE* f = nullptr;
  if (_wfopen_s(&f, path, L"wb") == 0 && f) {
    fwrite(crlf.data(), 1, crlf.size(), f);
    fclose(f);
    LogMsg("[pos] position saved to " + WideToUtf8(path));
  } else {
    LogMsg("[pos] failed to write position file");
  }
}

static void PosRoundPath(Gdiplus::GraphicsPath& p, Gdiplus::REAL x, Gdiplus::REAL y,
                         Gdiplus::REAL w, Gdiplus::REAL h, Gdiplus::REAL r) {
  Gdiplus::REAL d = r * 2;
  p.AddArc(x, y, d, d, 180, 90);
  p.AddArc(x + w - d, y, d, d, 270, 90);
  p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
  p.AddArc(x, y + h - d, d, d, 90, 90);
  p.CloseFigure();
}

static void PosTopRoundPath(Gdiplus::GraphicsPath& p, Gdiplus::REAL x, Gdiplus::REAL y,
                            Gdiplus::REAL w, Gdiplus::REAL h, Gdiplus::REAL r) {
  Gdiplus::REAL d = r * 2;
  p.AddArc(x, y, d, d, 180, 90);              
  p.AddArc(x + w - d, y, d, d, 270, 90);      
  p.AddLine(x + w, y + r, x + w, y + h);      
  p.AddLine(x + w, y + h, x, y + h);          
  p.CloseFigure();
}

static void DrawPosBoardCard(Gdiplus::Graphics& g, bool dk) {
  const Gdiplus::Color cCard  = dk ? Gdiplus::Color(255, 36, 40, 50)    : Gdiplus::Color(255, 255, 255, 255);
  const Gdiplus::Color cLine  = dk ? Gdiplus::Color(255, 62, 68, 84)    : Gdiplus::Color(255, 223, 226, 232);
  const Gdiplus::Color cGrid  = dk ? Gdiplus::Color(255, 96, 104, 126)  : Gdiplus::Color(255, 176, 184, 198);
  const Gdiplus::Color cSub   = dk ? Gdiplus::Color(255, 150, 158, 175) : Gdiplus::Color(255, 132, 138, 150);
  Gdiplus::FontFamily ff(L"Segoe UI");
  Gdiplus::Font fBody(&ff, PXF(10.5), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::SolidBrush bSub(cSub);
  Gdiplus::StringFormat sfc;
  sfc.SetAlignment(Gdiplus::StringAlignmentCenter);
  sfc.SetLineAlignment(Gdiplus::StringAlignmentCenter);

    Gdiplus::GraphicsPath cp;
    PosRoundPath(cp, PXF(POS_PAD), PXF(POS_BY), PXF(POS_CARD_W), PXF(POS_CARD_H), PXF(10));
    Gdiplus::SolidBrush cb(cCard);
    g.FillPath(&cb, &cp);
    Gdiplus::Pen bp(cLine, PXF(1));
    g.DrawPath(&bp, &cp);

    const Gdiplus::REAL bx = PXF(POS_OX), by = PXF(POS_OY), span = PXF(POS_GRID);
    
    Gdiplus::Pen lp(cGrid, PXF(1));
    for (int i = 0; i < g_posN; i++) {
      Gdiplus::REAL o = PXF(POS_CELL * i);
      g.DrawLine(&lp, bx, by + o, bx + span, by + o);
      g.DrawLine(&lp, bx + o, by, bx + o, by + span);
    }
    
    int si[3];
    StarIndices(g_posN, si);
    Gdiplus::SolidBrush stb(cGrid);
    for (int a = 0; a < 3; a++) for (int b = 0; b < 3; b++) {
      Gdiplus::REAL sx = bx + PXF(POS_CELL * si[a]) - PXF(2);
      Gdiplus::REAL sy = by + PXF(POS_CELL * si[b]) - PXF(2);
      g.FillEllipse(&stb, sx, sy, PXF(4), PXF(4));
    }
    
    const Gdiplus::REAL sd = PXF(POS_CELL - 4), off = sd / 2.0f;
    Gdiplus::SolidBrush bk(Gdiplus::Color(255, 17, 17, 17));
    Gdiplus::SolidBrush wh(Gdiplus::Color(255, 252, 252, 252));
    Gdiplus::Pen wp(Gdiplus::Color(255, 150, 154, 163), PXF(1));
    
    Gdiplus::Pen kp(Gdiplus::Color(255, 232, 236, 245), PXF(1.2));
    for (int y = 0; y < g_posN; y++) {
      for (int x = 0; x < g_posN; x++) {
        int v = g_posBoard[y][x];
        if (!v) continue;
        Gdiplus::REAL cx = bx + PXF(POS_CELL * x) - off;
        Gdiplus::REAL cy = by + PXF(POS_CELL * y) - off;
        if (v == 1) {
          g.FillEllipse(&bk, cx, cy, sd, sd);
          if (dk) g.DrawEllipse(&kp, cx, cy, sd, sd);
        } else { g.FillEllipse(&wh, cx, cy, sd, sd); g.DrawEllipse(&wp, cx, cy, sd, sd); }
      }
    }
    if (!g_posHasBoard) {
      Gdiplus::RectF nr(PXF(POS_OX), PXF(POS_OY), span, span);
      g.DrawString(PosT(L"\u5c1a\u672a\u8bc6\u522b\u5230\u68cb\u76d8", L"No board detected yet").c_str(),
                   -1, &fBody, nr, &sfc, &bSub);
    }

    {
      
      Gdiplus::Font fCoord(&ff, PXF(8.0), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      Gdiplus::SolidBrush bc(cSub);
      
      Gdiplus::StringFormat sfRight, sfLeft, sfMid;
      sfRight.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
      sfLeft.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
      sfMid.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
      sfRight.SetAlignment(Gdiplus::StringAlignmentFar);       
      sfRight.SetLineAlignment(Gdiplus::StringAlignmentCenter);
      sfLeft.SetAlignment(Gdiplus::StringAlignmentNear);       
      sfLeft.SetLineAlignment(Gdiplus::StringAlignmentCenter);
      sfMid.SetAlignment(Gdiplus::StringAlignmentCenter);      
      sfMid.SetLineAlignment(Gdiplus::StringAlignmentCenter);

      const Gdiplus::REAL lw = PXF(POS_COORD_W), lh = PXF(POS_COORD_H);
      
      const Gdiplus::REAL gap = PXF(POS_COORD_GAP);            
      for (int i = 0; i < g_posN; i++) {
        wchar_t t[8];
        swprintf(t, 8, L"%d", g_posN - i);                     
        Gdiplus::REAL cy = by + PXF(POS_CELL * i) - lh / 2.0f;
        Gdiplus::RectF rl(bx - gap - lw, cy, lw, lh);          
        g.DrawString(t, -1, &fCoord, rl, &sfRight, &bc);
        Gdiplus::RectF rr(bx + span + gap, cy, lw, lh);        
        g.DrawString(t, -1, &fCoord, rr, &sfLeft, &bc);
      }
      for (int i = 0; i < g_posN; i++) {
        wchar_t t[2] = {(wchar_t)(L'A' + i), 0};
        Gdiplus::REAL cx = bx + PXF(POS_CELL * i);
        Gdiplus::RectF rb(cx - PXF(POS_CELL) / 2.0f, by + span + gap,
                          PXF(POS_CELL), lh);
        g.DrawString(t, -1, &fCoord, rb, &sfMid, &bc);
      }
    }
}

static const int kPosPngSize = 800;

static std::string EscapeJson(const std::string& in) {
  std::string o;
  o.reserve(in.size() + 8);
  for (size_t i = 0; i < in.size(); ++i) {
    const char c = in[i];
    if (c == '\\') { o += '\\'; o += '\\'; }
    else o += c;
  }
  return o;
}

static bool GetEncoderClsid(const wchar_t* mime, CLSID* out) {
  UINT num = 0, size = 0;
  if (Gdiplus::GetImageEncodersSize(&num, &size) != Gdiplus::Ok || size == 0) return false;
  std::vector<BYTE> buf(size);
  Gdiplus::ImageCodecInfo* info = (Gdiplus::ImageCodecInfo*)buf.data();
  if (Gdiplus::GetImageEncoders(num, size, info) != Gdiplus::Ok) return false;
  for (UINT i = 0; i < num; ++i) {
    if (info[i].MimeType && wcscmp(info[i].MimeType, mime) == 0) {
      *out = info[i].Clsid;
      return true;
    }
  }
  return false;
}

static bool RenderPositionPng(const std::wstring& path, std::string* errOut) {
  const double saved = g_posScale;
  const int cw = POS_W;                            
  const int ch = POS_CARD_H + POS_PAD * 2;         
  const double sc = (double)kPosPngSize / (double)(cw > ch ? cw : ch);
  g_posScale = sc;
  const int W = kPosPngSize, H = kPosPngSize;
  Gdiplus::Bitmap bmp(W, H, PixelFormat32bppARGB);
  bool drawn = false;
  {
    Gdiplus::Graphics g(&bmp);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
    g.Clear(Gdiplus::Color(255, 255, 255, 255));
    
    const double ox = ((double)kPosPngSize - cw * sc) / 2.0;
    const double oy = ((double)kPosPngSize - ch * sc) / 2.0;
    g.TranslateTransform((Gdiplus::REAL)ox,
                         (Gdiplus::REAL)(oy + (POS_PAD - POS_BY) * sc));
    DrawPosBoardCard(g, g_uiDark);
    drawn = (g.GetLastStatus() == Gdiplus::Ok);
  }
  g_posScale = saved;                                
  if (!drawn) { if (errOut) *errOut = "draw failed"; return false; }
  CLSID png;
  if (!GetEncoderClsid(L"image/png", &png)) { if (errOut) *errOut = "no png encoder"; return false; }
  if (bmp.Save(path.c_str(), &png, nullptr) != Gdiplus::Ok) {
    if (errOut) *errOut = "save failed";
    return false;
  }
  return true;
}

static void PosSavePng() {
  if (!g_posHasBoard) {
    LogMsg("[pos] save png skipped: no board recognized yet");
    PostToPanel("{\"type\":\"posSave\",\"ok\":false,\"reason\":\"noboard\"}");
    return;
  }
  std::wstring path;
  char tv[MAX_PATH * 2] = {0};
  DWORD tn = GetEnvironmentVariableA("GB_TEST_SAVE_POS_PNG", tv, sizeof(tv));
  if (tn > 0 && tn < sizeof(tv)) {
    path = Utf8ToWide(tv);
  } else {
    wchar_t buf[MAX_PATH] = {0};
    {
      SYSTEMTIME st;
      GetLocalTime(&st);
      swprintf(buf, MAX_PATH, L"gomoku-board-%04d%02d%02d-%02d%02d%02d.png",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    }
    OPENFILENAMEW ofn;
    ZeroMemory(&ofn, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = (g_posWnd && IsWindow(g_posWnd)) ? g_posWnd : g_panel;
    ofn.lpstrFile = buf;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrFilter = L"PNG \u56fe\u7247 (*.png)\0*.png\0\u6240\u6709\u6587\u4ef6 (*.*)\0*.*\0";
    ofn.nFilterIndex = 1;
    ofn.lpstrDefExt = L"png";
    ofn.lpstrTitle = L"\u4fdd\u5b58\u5c40\u9762\uff08\u68cb\u76d8\u56fe\u7247\uff09";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    wchar_t desk[MAX_PATH] = {0};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, 0, desk)) && desk[0]) {
      ofn.lpstrInitialDir = desk;
    }
    if (!GetSaveFileNameW(&ofn)) {                  
      LogMsg("[pos] save png cancelled by user");
      PostToPanel("{\"type\":\"posSave\",\"ok\":false,\"reason\":\"cancel\"}");
      return;
    }
    path = buf;
  }
  std::string err;
  if (RenderPositionPng(path, &err)) {
    LogMsg("[pos] board png saved: " + WideToUtf8(path));
    PostToPanel("{\"type\":\"posSave\",\"ok\":true,\"path\":\"" + EscapeJson(WideToUtf8(path)) + "\"}");
  } else {
    LogMsg("[pos] board png failed: " + err);
    PostToPanel("{\"type\":\"posSave\",\"ok\":false,\"reason\":\"" + EscapeJson(err) + "\"}");
  }
}

struct PosAboutPara { int kind; const wchar_t* zh; const wchar_t* en; };
static const PosAboutPara kPosAbout[] = {
  
  { 0, L"五子棋桌面助手 · Gomoku Assistant",
       L"Desktop Gomoku Assistant" },
  { 2, L"版本 v4.37 · 单桌面版（屏幕识别 + 原生引擎一体，全程本地离线运行）",
       L"Version v4.37 · Standalone edition (screen recognition + native engine, fully offline)" },
  { 1, L"使用方法",
       L"How to Use" },
  { 3, L"一、识别棋盘",
       L"1. Board Detection" },
  { 2, L"把五子棋棋盘完整地显示在屏幕上，不要被其它窗口遮挡。助手会自动寻找棋盘：当紫色 L 形角框与星位十字和棋盘网格对齐时，识别即成功，状态栏不再提示「未检测到棋盘」。若自动识别失败，可点面板上的「重新识别」立即重扫；棋盘摆放特殊时使用「手动调节」框住棋盘区域，点「识别」确认。",
       L"Keep the whole board visible on screen, not covered by other windows. The assistant detects it automatically: detection succeeds when the purple corner brackets and star crosses align with the grid. If it fails, press Re-scan, or use Manual adjust to frame the board area and confirm." },
  { 3, L"二、开启指导",
       L"2. Guidance" },
  { 2, L"在面板中选择我方执子（黑 / 白）与思考时间，点「分析」开启指导：蓝色圆圈 = 引擎推荐落点；热力色块 = 候选点强弱（青色最佳，其后按绿、粉、浅粉递减）；状态栏实时显示评估分。「局面」窗口可随时查看局面代码（总代码 / 黑 / 白），支持复制与导出。",
       L"Pick your side (black / white) and thinking time, then press Analyze: the blue circle marks the recommended move; heat blocks rank candidates (cyan best, then green / pink / pale pink); the status bar shows the live evaluation. The Position window lists the position code (all / black / white) for copy and export." },
  { 3, L"三、最小化与关闭",
       L"3. Minimize & Exit" },
  { 2, L"点标题栏「–」= 软件整体收进系统任务栏，桌面上不再显示任何窗口；点任务栏的「五子棋助手」图标即整体还原。点「×」= 退出整个程序：引擎与模型随之释放，再次打开时自动重新加载，无需任何手动操作。",
       L"The dash (–) tucks the whole app into the system taskbar with nothing left on the desktop; click the Gomoku Assistant taskbar icon to restore. The close button (×) exits the program: engine and models are released and reloaded automatically at the next launch." },
  { 3, L"四、跨机器自适应",
       L"4. Cross-machine Adaptation" },
  { 2, L"引擎启动时自动探测 CPU 指令集并选择最优变体（优先级：AVX-512 VNNI → AVX-VNNI → AVX-512 → AVX2 → SSE），选择结果与机器指纹绑定。把安装目录拷贝到其它电脑后，首次运行会自动重新探测并落位，全程无需手动配置；启动日志记录了每次选择与降级原因。",
       L"At startup the engine probes CPU instruction sets and picks the best variant (AVX-512 VNNI → AVX-VNNI → AVX-512 → AVX2 → SSE), bound to a machine fingerprint. Copy the folder to another PC and it re-probes automatically on first run; the log records every choice and downgrade." },
  { 1, L"功能",
       L"Features" },
  { 2, L"· 自动识别任意对局窗口中的 15 路棋盘，角框与星位标记核对定位，识别图层对自身绘制免疫",
       L"· Automatic 15-line board detection in any game window; alignment marks; recognition immune to its own drawings" },
  { 2, L"· 实时胜负评估与推荐落点（蓝圈）、候选热力图（四档名次色，独立副通道不打断主分析）",
       L"· Live evaluation and recommended move (blue circle); candidate heat map on a separate lane" },
  { 2, L"· 平衡选点与交换平衡；局面代码查看、复制与导出 PNG",
       L"· Balance moves and swap balance; position code view / copy / PNG export" },
  { 2, L"· 原生引擎五变体按 CPU 自动选型，随宿主生死回收，重启自动重载模型",
       L"· Five native engine variants auto-selected per CPU; engines die with the host and reload on restart" },
  { 2, L"· 中英双语、深浅主题、整窗透明度可调；最小化收进系统任务栏",
       L"· Bilingual UI, light / dark themes, window opacity; minimize to the system taskbar" },
  { 1, L"开源组件",
       L"Open-source Components" },
  { 2, L"· Rapfi —— 五子棋 / 连珠引擎内核（随本软件分发编译版，与宿主独立进程、标准输入输出通信）［GPL-3.0］",
       L"· Rapfi — Gomoku / Renju engine core (compiled build shipped with this app; separate process, stdio only) [GPL-3.0]" },
  { 2, L"· OpenCV —— 棋盘与棋子识别（静态链入 GomokuVision.exe，不额外分发 DLL）［Apache-2.0］",
       L"· OpenCV — board and stone recognition (statically linked into GomokuVision.exe) [Apache-2.0]" },
  { 2, L"· 思源黑体 Source Han Sans —— 界面字体［SIL Open Font License 1.1］",
       L"· Source Han Sans — UI typeface [SIL Open Font License 1.1]" },
  { 2, L"· Microsoft WebView2 —— 桌面界面运行时（由 Windows / Edge 提供，不随本软件分发）［专有］",
       L"· Microsoft WebView2 — desktop UI runtime (provided by Windows / Edge, not shipped) [Proprietary]" },
  { 2, L"说明：本软件自身的界面与配套代码以 MIT 许可发布；引擎以独立进程方式运行、仅通过标准输入输出与本软件通信，不与本软件合并为同一作品。随本软件分发 Rapfi 时已一并保留其许可证与源码获取方式（上游仓库 dhbloo/rapfi）。完整许可文本见安装目录《开源许可与版权声明》（LICENSES & COPYRIGHT NOTICES）。",
       L"Note: the UI and supporting code of this app are released under the MIT licence. The engine runs as a separate process communicating only via standard input/output, and is not merged into this work. Rapfi's licence text and source availability are shipped along with it (upstream: dhbloo/rapfi). Full licence texts are in LICENSES & COPYRIGHT NOTICES in the installation folder." },
  { 1, L"免责声明",
       L"Disclaimer" },
  { 2, L"本软件仅供五子棋学习、研究与娱乐使用。请遵守各对局平台的规则，勿将其用于正式比赛或其它违反平台规则的场合；使用本软件所产生的一切后果由使用者自行承担。",
       L"This software is for Gomoku study, research and entertainment only. Respect the rules of each game platform; do not use it in official tournaments or in any way that violates platform rules. Users assume all consequences of using this software." },
};

static Gdiplus::REAL PosAboutParaH(Gdiplus::Graphics* g, const PosAboutPara& p, Gdiplus::Font* f,
                                   Gdiplus::REAL tw, Gdiplus::StringFormat* sf,
                                   std::wstring* indentOut, const wchar_t** textOut,
                                   Gdiplus::RectF* measOut) {
  const wchar_t* s = (g_uiLang == L"en") ? p.en : p.zh;
  if (indentOut) indentOut->clear();
  *textOut = s;
  Gdiplus::RectF probe(0.0f, 0.0f, tw, 100000.0f);
  g->MeasureString(s, -1, f, probe, sf, measOut);
  return measOut->Height;
}
static Gdiplus::REAL PosAboutGapAfter(int kind) {
  return (kind == 0) ? PXF(12) : (kind == 1) ? PXF(7) : (kind == 3) ? PXF(5) : PXF(10);
}
static Gdiplus::REAL PosAboutGapBefore(int kind, bool first) {
  if (first) return 0;
  return (kind == 0) ? PXF(18) : (kind == 1) ? PXF(14) : (kind == 3) ? PXF(10) : 0;
}

static void PaintPosAboutPage(Gdiplus::Graphics& g, HWND h, int W, int H,
                              Gdiplus::Font* fH1, Gdiplus::Font* fH2, Gdiplus::Font* fBody,
                              const Gdiplus::Color& cH1, const Gdiplus::Color& cH2,
                              const Gdiplus::Color& cBody, const Gdiplus::Color& cSub,
                              const Gdiplus::Color& cLine) {
  const Gdiplus::REAL pad = PXF(POS_PAD);
  const Gdiplus::REAL ty = PXF(POS_TITLE_H + 8);
  const Gdiplus::REAL th = (Gdiplus::REAL)H - ty - PXF(6);
  const Gdiplus::REAL tw = (Gdiplus::REAL)W - pad * 2 - PXF(12);   

  const size_t NP = sizeof(kPosAbout) / sizeof(kPosAbout[0]);
  Gdiplus::REAL total = 0;
  for (size_t i = 0; i < NP; ++i) {
    Gdiplus::Font* f = (kPosAbout[i].kind == 2) ? fBody : fH2;   
    Gdiplus::StringFormat sf;
    std::wstring ind; const wchar_t* s = nullptr; Gdiplus::RectF m;
    PosAboutParaH(&g, kPosAbout[i], f, tw, &sf, &ind, &s, &m);
    total += PosAboutGapBefore(kPosAbout[i].kind, i == 0) + m.Height + PosAboutGapAfter(kPosAbout[i].kind);
  }
  int maxScroll = (int)ceil((double)(total - th));
  if (maxScroll < 0) maxScroll = 0;
  g_posAboutMaxScroll = maxScroll;
  if (g_posAboutScroll > maxScroll) g_posAboutScroll = maxScroll;
  if (g_posAboutScroll < 0) g_posAboutScroll = 0;

  Gdiplus::SolidBrush bH1(cH1), bH2(cH2), bBody(cBody);
  Gdiplus::StringFormat sfNear;                       
  sfNear.SetLineAlignment(Gdiplus::StringAlignmentNear);
  
  Gdiplus::StringFormat sfCenter;
  sfCenter.SetLineAlignment(Gdiplus::StringAlignmentNear);
  sfCenter.SetAlignment(Gdiplus::StringAlignmentCenter);

  Gdiplus::GraphicsState s1 = g.Save();
  g.SetClip(Gdiplus::RectF(0.0f, ty, (Gdiplus::REAL)W, th));   
  Gdiplus::REAL y = ty - (Gdiplus::REAL)g_posAboutScroll;
  for (size_t i = 0; i < NP; ++i) {
    const int kind = kPosAbout[i].kind;
    Gdiplus::Font* f = (kind == 2) ? fBody : fH2;                
    std::wstring ind; const wchar_t* s = nullptr; Gdiplus::RectF m;
    PosAboutParaH(&g, kPosAbout[i], f, tw, &sfNear, &ind, &s, &m);
    y += PosAboutGapBefore(kind, i == 0);
    Gdiplus::SolidBrush* b = (kind == 0) ? &bH1 : (kind == 1) ? &bH2 : &bBody;
    g.DrawString(s, -1, f, Gdiplus::RectF(pad, y, tw, m.Height + PXF(2)),
                 (kind == 0) ? &sfCenter : &sfNear, b);
    y += m.Height;
    if (kind == 0) {
      
      Gdiplus::Pen dl(cLine, PXF(1));
      g.DrawLine(&dl, pad, y + PosAboutGapAfter(kind) * 0.5f,
                 (Gdiplus::REAL)W - pad, y + PosAboutGapAfter(kind) * 0.5f);
    }
    y += PosAboutGapAfter(kind);
  }
  g.Restore(s1);

  if (maxScroll > 0) {
    const Gdiplus::REAL sw = PXF(3);
    const Gdiplus::REAL sx = (Gdiplus::REAL)W - sw - PXF(2);
    Gdiplus::SolidBrush trk(Gdiplus::Color(70, cSub.GetR(), cSub.GetG(), cSub.GetB()));
    g.FillRectangle(&trk, sx, ty, sw, th);
    double frac = (double)th / (double)(th + maxScroll);
    Gdiplus::REAL hh = (Gdiplus::REAL)(th * frac);
    if (hh < PXF(14)) hh = PXF(14);
    Gdiplus::REAL hy = ty + (Gdiplus::REAL)((th - hh) * ((double)g_posAboutScroll / (double)maxScroll));
    Gdiplus::SolidBrush thb(Gdiplus::Color(200, cSub.GetR(), cSub.GetG(), cSub.GetB()));
    Gdiplus::GraphicsPath hp2;
    PosRoundPath(hp2, sx, hy, sw, hh, sw / 2.0f);
    g.FillPath(&thb, &hp2);
  }
}

static const Gdiplus::FontFamily* PosUiFontFamily() {
  static const Gdiplus::FontFamily* fam = nullptr;
  if (fam) return fam;
  static const wchar_t* const kFams[] = {
    L"Source Han Sans SC", L"\u601d\u6e90\u9ed1\u4f53", L"Source Han Sans CN",
    L"Source Han Sans", L"Microsoft YaHei", L"Segoe UI",
  };
  for (const wchar_t* n : kFams) {
    Gdiplus::FontFamily* f = new Gdiplus::FontFamily(n);   
    if (f->GetLastStatus() == Gdiplus::Ok) { fam = f; return fam; }
    delete f;
  }
  fam = new Gdiplus::FontFamily(L"Segoe UI");
  return fam;
}

static void PaintPosition(HWND h) {
  RECT rc;
  GetClientRect(h, &rc);
  int W = rc.right - rc.left, H = rc.bottom - rc.top;
  if (W <= 0 || H <= 0) return;

  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = W;
  bi.bmiHeader.biHeight = -H;                 
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;

  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) {
    if (bmp) DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return;
  }
  HGDIOBJ old = SelectObject(mem, bmp);
  ZeroMemory(bits, (size_t)W * H * 4);        

  static unsigned s_posBackdrop = 0;
  static bool s_posBackdropInit = false;
  if (!s_posBackdropInit) {
    s_posBackdropInit = true;
    char v[32] = {0};
    if (GetEnvironmentVariableA("GB_TEST_POS_BACKDROP", v, sizeof(v)) && v[0]) {
      unsigned r = 0, g = 0, b = 0;
      if (sscanf(v, "%2x%2x%2x", &r, &g, &b) == 3) {
        s_posBackdrop = 0xFF000000u | (b << 16) | (g << 8) | r;    
      }
    }
  }

  {
    Gdiplus::Bitmap gb(W, H, W * 4, PixelFormat32bppPARGB, (BYTE*)bits);
    Gdiplus::Graphics g(&gb);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);

    const bool dk = g_uiDark;
    
    const Gdiplus::Color cBg    = dk ? Gdiplus::Color(255, 28, 31, 38)    : Gdiplus::Color(255, 250, 250, 252);
    const Gdiplus::Color cLine  = dk ? Gdiplus::Color(255, 62, 68, 84)    : Gdiplus::Color(255, 223, 226, 232);
    const Gdiplus::Color cText  = dk ? Gdiplus::Color(255, 228, 231, 238) : Gdiplus::Color(255, 30, 32, 38);
    const Gdiplus::Color cSub   = dk ? Gdiplus::Color(255, 150, 158, 175) : Gdiplus::Color(255, 132, 138, 150);
    const Gdiplus::Color cWhite = Gdiplus::Color(255, 255, 255, 255);
    const Gdiplus::Color cAccent = Gdiplus::Color(255, 59, 125, 216);   

    Gdiplus::GraphicsPath winPath;
    PosRoundPath(winPath, 0.0f, 0.0f, (Gdiplus::REAL)W, (Gdiplus::REAL)H, PXF(POS_RADIUS));
    { Gdiplus::SolidBrush b(cBg); g.FillPath(&b, &winPath); }
    { Gdiplus::Pen e(cLine, PXF(1)); g.DrawPath(&e, &winPath); }

    Gdiplus::FontFamily ff(L"Segoe UI");
    Gdiplus::Font fTitle(&ff, PXF(11.5), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::Font fGlyph(&ff, PXF(12.0), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
    Gdiplus::Font fBody(&ff, PXF(10.5), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
    
    Gdiplus::Font fBtn(&ff, PXF(13), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
    Gdiplus::SolidBrush bTitle(cWhite), bText(cText);   
    Gdiplus::StringFormat sfc;
    sfc.SetAlignment(Gdiplus::StringAlignmentCenter);
    sfc.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::StringFormat sfl;
    sfl.SetAlignment(Gdiplus::StringAlignmentNear);
    sfl.SetLineAlignment(Gdiplus::StringAlignmentCenter);

    {
      Gdiplus::GraphicsPath tp;
      PosTopRoundPath(tp, 0.0f, 0.0f, (Gdiplus::REAL)W, PXF(POS_TITLE_H), PXF(POS_RADIUS));
      Gdiplus::GraphicsState s0 = g.Save();
      g.SetClip(&tp);          
      Gdiplus::SolidBrush tb(cAccent);
      g.FillPath(&tb, &tp);

      std::wstring posTitleText = PosT(L"\u5c40\u9762", L"Position");
      if (g_posBlack + g_posWhite > 0) {
        wchar_t sb[96];
        if (g_uiLang == L"en")
          swprintf(sb, 96, L" Total%d\u00b7B%d\u00b7W%d", g_posBlack + g_posWhite, g_posBlack, g_posWhite);
        else
          swprintf(sb, 96, L" \u603b%d\u00b7\u9ed1%d\u00b7\u767d%d", g_posBlack + g_posWhite, g_posBlack, g_posWhite);
        posTitleText += sb;
      }
      Gdiplus::RectF tr(PXF(POS_PAD), 0.0f,
                        (Gdiplus::REAL)W - PXF(POS_TBTN_W + POS_TBTN_ABOUT_W + POS_PAD), PXF(POS_TITLE_H));
      g.DrawString(posTitleText.c_str(), -1, &fTitle, tr, &sfl, &bTitle);

      int bw = PX(POS_TBTN_W);
      int aw = PX(POS_TBTN_ABOUT_W);
      
      for (int k = 0; k < 2; k++) {
        int kind = (k == 0) ? POSHIT_CLOSE : POSHIT_ABOUT;
        int kw = (k == 1) ? aw : bw;
        
        Gdiplus::REAL bx = (k == 0) ? (Gdiplus::REAL)(W - bw)
                                    : (Gdiplus::REAL)(W - bw - aw);
        if (g_posAbout && kind == POSHIT_ABOUT) {
          
          Gdiplus::SolidBrush act(Gdiplus::Color(220, 245, 158, 11));   
          g.FillRectangle(&act, bx, 0.0f, (Gdiplus::REAL)kw, PXF(POS_TITLE_H));
        }
        if (g_posHoverBtn == kind || g_posPressBtn == kind) {
          Gdiplus::SolidBrush hb(Gdiplus::Color(kind == POSHIT_CLOSE ? 95 : 55, 255, 255, 255));
          g.FillRectangle(&hb, bx, 0.0f, (Gdiplus::REAL)kw, PXF(POS_TITLE_H));
        }
        Gdiplus::RectF r(bx, 0.0f, (Gdiplus::REAL)kw, PXF(POS_TITLE_H));
        if (kind == POSHIT_ABOUT) {
          
          Gdiplus::Font fAbout(&ff, PXF(9.5), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
          std::wstring ab = PosT(L"\u5173\u4e8e", L"About");
          g.DrawString(ab.c_str(), -1, &fAbout, r, &sfc, &bTitle);
        } else {
          g.DrawString(L"\u2715", -1, &fGlyph, r, &sfc, &bTitle);
        }
      }
      g.Restore(s0);
    }

    if (g_posAbout) {
      const Gdiplus::FontFamily* aff = PosUiFontFamily();
      Gdiplus::Font fH1(aff, PXF(16), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
      Gdiplus::Font fH2(aff, PXF(13), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
      Gdiplus::Font fAb(aff, PXF(11), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      const Gdiplus::Color cH1(255, 30, 100, 190);              
      const Gdiplus::Color cH2 = dk ? Gdiplus::Color(255, 125, 200, 240)
                                    : Gdiplus::Color(255, 72, 152, 208);   
      const Gdiplus::Color cAb = dk ? Gdiplus::Color(255, 235, 238, 245)
                                    : Gdiplus::Color(255, 20, 22, 28);     
      PaintPosAboutPage(g, h, W, H, &fH1, &fH2, &fAb, cH1, cH2, cAb, cSub, cLine);
    } else {
    
    DrawPosBoardCard(g, dk);

    {
      const Gdiplus::REAL kx = PXF(POS_PAD), ky = PXF(POS_CODE_Y);
      const Gdiplus::REAL kw = PXF(POS_CARD_W), kh = PXF(POS_CODE_H);
      Gdiplus::GraphicsPath kp;
      PosRoundPath(kp, kx, ky, kw, kh, PXF(8));
      Gdiplus::SolidBrush kb(dk ? Gdiplus::Color(255, 32, 36, 45) : Gdiplus::Color(255, 247, 248, 251));
      g.FillPath(&kb, &kp);
      { Gdiplus::Pen kln(cLine, PXF(1)); g.DrawPath(&kln, &kp); }

      Gdiplus::Font fCons(L"Consolas", PXF(10), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      Gdiplus::Font fCour(L"Courier New", PXF(10), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      Gdiplus::Font* fCode = (fCons.GetLastStatus() == Gdiplus::Ok) ? &fCons : &fCour;

      const Gdiplus::REAL pad = PXF(8);
      const Gdiplus::REAL tx = kx + pad, ty = ky + pad;
      const Gdiplus::REAL tw = kw - pad * 2, th = kh - pad * 2;
      std::wstring code = BuildPositionCode();

      Gdiplus::StringFormat sfCode;                        
      Gdiplus::RectF meas;
      Gdiplus::RectF probe(tx, 0.0f, tw, 100000.0f);
      g.MeasureString(code.c_str(), -1, fCode, probe, &sfCode, &meas);
      
      int maxScroll = (int)ceil((double)(meas.Height - th));
      if (maxScroll < 0) maxScroll = 0;
      g_posCodeMaxScroll = maxScroll;
      if (g_posCodeScroll > maxScroll) g_posCodeScroll = maxScroll;
      if (g_posCodeScroll < 0) g_posCodeScroll = 0;

      Gdiplus::SolidBrush bCode(cText);
      Gdiplus::GraphicsState s1 = g.Save();
      g.SetClip(Gdiplus::RectF(tx, ty, tw, th));           
      Gdiplus::RectF draw(tx, ty - (Gdiplus::REAL)g_posCodeScroll, tw, 100000.0f);
      g.DrawString(code.c_str(), -1, fCode, draw, &sfCode, &bCode);
      g.Restore(s1);

      if (maxScroll > 0) {
        Gdiplus::REAL sw = PXF(3), sx = kx + kw - PXF(7);
        Gdiplus::SolidBrush trk(Gdiplus::Color(90, cSub.GetR(), cSub.GetG(), cSub.GetB()));
        Gdiplus::GraphicsPath tp;
        PosRoundPath(tp, sx, ty, sw, th, sw / 2.0f);
        g.FillPath(&trk, &tp);
        double frac = (double)th / (double)(th + maxScroll);
        Gdiplus::REAL hh = (Gdiplus::REAL)(th * frac);
        if (hh < PXF(10)) hh = PXF(10);
        Gdiplus::REAL hy = ty + (Gdiplus::REAL)((th - hh) *
                            ((double)g_posCodeScroll / (double)maxScroll));
        Gdiplus::SolidBrush thb(Gdiplus::Color(190, cSub.GetR(), cSub.GetG(), cSub.GetB()));
        Gdiplus::GraphicsPath hp2;
        PosRoundPath(hp2, sx, hy, sw, hh, sw / 2.0f);
        g.FillPath(&thb, &hp2);
      }
    }

    {
      struct { int hit; const wchar_t* zh; const wchar_t* en; bool primary; } btns[2] = {
        { POSHIT_COPY, L"\u590d\u5236\u4ee3\u7801", L"Copy",          true  },
        { POSHIT_SAVE, L"\u4fdd\u5b58\u5c40\u9762", L"Save position", false },
      };
      for (int i = 0; i < 2; ++i) {
        Gdiplus::RectF r(PXF(i == 0 ? POS_BTN_X0 : POS_BTN_X1), PXF(POS_BTN_Y),
                         PXF(POS_BTN_W), PXF(POS_BTN_H));
        bool pressed = (g_posPressBtn == btns[i].hit);
        bool hover   = (g_posHoverBtn == btns[i].hit);
        Gdiplus::Color fill, line, text;
        if (btns[i].primary) {
          fill = pressed ? Gdiplus::Color(255, 45, 104, 186)
               : hover   ? Gdiplus::Color(255, 74, 138, 224)
                         : Gdiplus::Color(255, 59, 125, 216);
          line = fill;
          text = cWhite;
        } else {
          fill = dk ? (pressed ? Gdiplus::Color(255, 40, 44, 56)
                      : hover   ? Gdiplus::Color(255, 44, 49, 62)
                                : Gdiplus::Color(255, 34, 38, 48))
                    : (pressed ? Gdiplus::Color(255, 235, 240, 246)
                      : hover   ? Gdiplus::Color(255, 247, 249, 252)
                                : Gdiplus::Color(255, 255, 255, 255));
          line = dk ? Gdiplus::Color(255, 74, 81, 99) : Gdiplus::Color(255, 214, 219, 228);
          text = dk ? Gdiplus::Color(255, 200, 206, 220) : Gdiplus::Color(255, 68, 76, 92);
        }
        Gdiplus::GraphicsPath bp;
        PosRoundPath(bp, r.X, r.Y, r.Width, r.Height, PXF(5));   
        Gdiplus::SolidBrush fb(fill);
        g.FillPath(&fb, &bp);
        { Gdiplus::Pen lpen(line, PXF(1)); g.DrawPath(&lpen, &bp); }
        Gdiplus::SolidBrush tb(text);
        
        std::wstring label = PosT(btns[i].zh, btns[i].en);
        g.DrawString(label.c_str(), -1, &fBtn, r, &sfc, &tb);
      }
    }
    }   

    if (s_posBackdrop) {
      unsigned* px = (unsigned*)bits;
      for (size_t i = 0; i < (size_t)W * H; ++i) px[i] = s_posBackdrop;
    }
  }

  const BYTE A = PosAlphaValue();
  if (A < 255) {
    unsigned* px = (unsigned*)bits;
    size_t n = (size_t)W * H;
    for (size_t i = 0; i < n; ++i) {
      unsigned v = px[i];
      unsigned sa = (v >> 24) & 0xFFu;
      if (!sa) continue;                       
      unsigned na = (sa * A + 127u) / 255u;
      unsigned r = (((v >> 16) & 0xFFu) * A + 127u) / 255u;
      unsigned gg = (((v >> 8) & 0xFFu) * A + 127u) / 255u;
      unsigned b = ((v & 0xFFu) * A + 127u) / 255u;
      px[i] = (na << 24) | (r << 16) | (gg << 8) | b;
    }
  }

  {
    
    static int logN = 0;
    if (logN < 2) {
      ++logN;
      int n = 0;
      for (int y = 0; y < 15; y++) for (int x = 0; x < 15; x++) if (g_posBoard[y][x]) ++n;
      char db[192];
      snprintf(db, sizeof(db),
               "[pos] paint W=%d H=%d dpr=%.3f board=%d stones=%d alpha=%d maxScroll=%d",
               W, H, g_posScale, (int)g_posHasBoard, n, (int)A, g_posCodeMaxScroll);
      LogMsg(db);
    }
  }

  POINT src = {0, 0};
  SIZE size = {W, H};
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  
  UpdateLayeredWindow(h, screen, nullptr, &size, mem, &src, 0, &bf, ULW_ALPHA);

  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
}

static void ApplyPanelTransparency() {
  
  static bool logged = false;
  if (!logged) {
    logged = true;
    LogMsg("[panel] transparency = WS_EX_LAYERED|WS_EX_NOREDIRECTIONBITMAP + WebView2 alpha "
           "(no SetLayeredWindowAttributes, no acrylic, no blur)");
  }
}

static void ApplyPosAlpha() {
  if (!g_posWnd || !IsWindow(g_posWnd)) return;
  
  PaintPosition(g_posWnd);
}

static LRESULT CALLBACK PosProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_APP + 5:                       
      
      PaintPosition(h);
      return 0;
    case WM_MOUSEMOVE: {
      
      POINT c = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
      int hit = PosHitTest(h, c);
      if (hit != g_posHoverBtn) { g_posHoverBtn = hit; PaintPosition(h); }
      if (!g_posTracked) {
        TRACKMOUSEEVENT t = {sizeof(t), TME_LEAVE, h, 0};
        if (TrackMouseEvent(&t)) g_posTracked = true;
      }
      break;
    }
    case WM_MOUSELEAVE:
      g_posTracked = false;
      if (g_posHoverBtn) { g_posHoverBtn = POSHIT_NONE; PaintPosition(h); }
      return 0;
    case WM_SETCURSOR: {
      
      POINT c;
      if (GetCursorPos(&c) && ScreenToClient(h, &c) && PosHitTest(h, c)) {
        SetCursor(LoadCursor(nullptr, IDC_HAND));
        return TRUE;
      }
      break;
    }
    case WM_MOUSEWHEEL: {
      
      if (g_posAbout) {
        if (g_posAboutMaxScroll > 0) {
          int d = GET_WHEEL_DELTA_WPARAM(w);
          int step = PX(24);
          g_posAboutScroll -= (d / WHEEL_DELTA) * step;
          if (g_posAboutScroll < 0) g_posAboutScroll = 0;
          if (g_posAboutScroll > g_posAboutMaxScroll) g_posAboutScroll = g_posAboutMaxScroll;
          PaintPosition(h);
        }
        return 0;
      }
      if (g_posCodeMaxScroll > 0) {
        int d = GET_WHEEL_DELTA_WPARAM(w);
        int step = PX(16);
        g_posCodeScroll -= (d / WHEEL_DELTA) * step;
        if (g_posCodeScroll < 0) g_posCodeScroll = 0;
        if (g_posCodeScroll > g_posCodeMaxScroll) g_posCodeScroll = g_posCodeMaxScroll;
        PaintPosition(h);
        return 0;
      }
      break;
    }
    case WM_LBUTTONDOWN: {
      POINT c = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
      int hit = PosHitTest(h, c);
      if (hit) { g_posPressBtn = hit; SetCapture(h); PaintPosition(h); return 0; }
      break;
    }
    case WM_LBUTTONUP: {
      if (g_posPressBtn) {
        int was = g_posPressBtn;
        g_posPressBtn = POSHIT_NONE;
        if (GetCapture() == h) ReleaseCapture();
        POINT c = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
        PaintPosition(h);
        if (PosHitTest(h, c) == was) {          
          if (was == POSHIT_CLOSE) { ClosePositionWindow(); return 0; }
          if (was == POSHIT_ABOUT) {
            
            g_posAbout = !g_posAbout;
            g_posAboutScroll = 0;
            g_posAboutMaxScroll = 0;
            
            RECT wa;
            if (SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0)) {
              RECT wr;
              if (GetWindowRect(h, &wr)) {
                int baseH = PX(POS_H);
                int waH = wa.bottom - wa.top - 16;
                int wantH = g_posAbout ? ((baseH > (waH * 4) / 5) ? baseH : (waH * 4) / 5)
                                       : baseH;
                if (wantH > waH) wantH = waH;
                int y = wr.top;
                if (y + wantH > wa.bottom) y = (wa.bottom - wantH > 0) ? wa.bottom - wantH : 0;
                SetWindowPos(h, nullptr, wr.left, y, wr.right - wr.left, wantH,
                             SWP_NOZORDER | SWP_NOACTIVATE);
              }
            }
            PaintPosition(h);
            LogMsg(std::string("[pos] about page toggled -> ") + (g_posAbout ? "ON" : "OFF"));
            return 0;
          }
          if (was == POSHIT_COPY) { PosCopyCode(); return 0; }
          if (was == POSHIT_SAVE) { PosSaveCode(); return 0; }
        }
      }
      break;
    }
    case WM_NCHITTEST: {
      POINT pt = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
      POINT c = pt;
      ScreenToClient(h, &c);
      if (PosHitTest(h, c)) return HTCLIENT;                      
      if (c.y >= 0 && c.y <= PX(POS_TITLE_H)) return HTCAPTION;   
      return HTCLIENT;
    }
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
      
      PAINTSTRUCT ps;
      BeginPaint(h, &ps);
      EndPaint(h, &ps);
      PaintPosition(h);
      return 0;
    }
    case WM_DISPLAYCHANGE:                 
    case WM_DPICHANGED:
      PaintPosition(h);
      return 0;
    case WM_CLOSE: ClosePositionWindow(); return 0;
    case WM_DESTROY:
      
      g_posHoverBtn = POSHIT_NONE; g_posPressBtn = POSHIT_NONE; g_posTracked = false;
      g_posAbout = false; g_posAboutScroll = 0; g_posAboutMaxScroll = 0;   
      g_posWnd = nullptr;
      return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static void OpenPositionWindow() {
  if (g_posWnd && IsWindow(g_posWnd)) {           
    if (IsIconic(g_posWnd)) ShowWindow(g_posWnd, SW_RESTORE);
    ShowWindow(g_posWnd, SW_SHOWNOACTIVATE);      
    SetForegroundWindow(g_posWnd);
    PostMessageW(g_posWnd, WM_APP + 5, 0, 0);
    LogMsg("[pos] existing window restored (iconic/hidden -> shown, brought to front)");
    NotifyPositionState();
    return;
  }
  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = PosProc;
  wc.hInstance = g_hInst;
  wc.lpszClassName = L"GbPositionHost";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  RegisterClassExW(&wc);

  {
    double sw = (double)GetSystemMetrics(SM_CXSCREEN);
    double sh = (double)GetSystemMetrics(SM_CYSCREEN);
    double sx = sw / 1920.0, sy = sh / 1080.0;   
    double s = (sw < 800.0 || sh < 600.0) ? 0.75 : (sx < sy ? sx : sy);
    if (s < 0.75) s = 0.75;
    if (s > 2.2)  s = 2.2;
    g_posScale = s;
  }
  const int W = PX(POS_W), H = PX(POS_H);

  int x = 120, y = 120;
  if (g_panel && IsWindow(g_panel)) {
    RECT pr;
    if (GetWindowRect(g_panel, &pr)) {
      x = pr.left - W - 12;                      
      y = pr.top;
      if (x < 4) x = pr.right + 12;              
    }
  }
  if (y + H > GetSystemMetrics(SM_CYSCREEN) - 8) y = 8;
  
  {
    char v[32] = {0};
    if (GetEnvironmentVariableA("GB_TEST_POS_AT", v, sizeof(v)) && v[0]) {
      int tx = 0, ty = 0;
      if (sscanf(v, "%d,%d", &tx, &ty) == 2) { x = tx; y = ty; }
    }
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (y < 0) y = 0;

  g_posWnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED, L"GbPositionHost",
                             (g_uiLang == L"en") ? L"Position" : L"\u5c40\u9762",
                             WS_POPUP, x, y, W, H,
                             nullptr, nullptr, g_hInst, nullptr);
  if (!g_posWnd) { LogMsg("[pos] failed to create position window"); return; }

  {
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x11
#endif
    if (SelfCaptureAllowedForTest()) {
      LogMsg("[pos] (test) self-capture allowed -> window left capturable on purpose");
    } else if (SetWindowDisplayAffinity(g_posWnd, WDA_EXCLUDEFROMCAPTURE)) {
      LogMsg("[pos] excluded from screen capture (recognition is immune to this window; "
             "whatever it covers stays recognizable)");
    } else {
      
      LogMsg("[pos] note: SetWindowDisplayAffinity failed -> falling back to rect masking");
    }
  }

  g_posCodeScroll = 0;
  g_posCodeMaxScroll = 0;
  ApplyPosAlpha();                                
  ShowWindow(g_posWnd, SW_SHOWNOACTIVATE);
  PaintPosition(g_posWnd);                        
  {
    
    char pb[320];
    snprintf(pb, sizeof(pb),
             "[pos] geometry window=(%d,%d) %dx%d scale=%.3f (design %dx%d) "
             "card=%dx%d@(%d,%d) grid=%d@(%d,%d) coord=%dx%d code=%d btn=%dx%d@(%d,%d)",
             x, y, W, H, g_posScale, POS_W, POS_H,
             POS_CARD_W, POS_CARD_H, POS_PAD, POS_BY,
             POS_GRID, POS_OX, POS_OY, POS_COORD_W, POS_COORD_H,
             POS_CODE_Y, POS_BTN_W, POS_BTN_H, POS_BTN_X0, POS_BTN_Y);
    
    {
      std::string code = WideToUtf8(BuildPositionCode());
      size_t e1 = code.find('\n');
      size_t e2 = code.find('\n', e1 + 1);
      LogMsg("[pos] code: " + code.substr(0, e2 == std::string::npos ? code.size() : e2));
    }
    LogMsg(pb);
  }
  LogMsg("[pos] position window opened (owner-drawn + UpdateLayeredWindow)");
  NotifyPositionState();
}

static void ClosePositionWindow() {
  if (g_posWnd && IsWindow(g_posWnd)) DestroyWindow(g_posWnd);
  g_posWnd = nullptr;
  NotifyPositionState();
}

static void NotifyPositionState() {
  bool open = (g_posWnd && IsWindow(g_posWnd) && IsWindowVisible(g_posWnd));
  PostToPanel(open ? "{\"type\":\"posState\",\"open\":true}"
                   : "{\"type\":\"posState\",\"open\":false}");
}

static void RefreshPositionWindow() {
  if (g_posWnd && IsWindow(g_posWnd)) PostMessageW(g_posWnd, WM_APP + 5, 0, 0);
}

static void OpenCalculatorWithBoard() {
  std::string bl, wh;
  for (int y = 0; y < 15; ++y) {
    for (int x = 0; x < 15; ++x) {
      char b[48];
      if (g_posBoard[y][x] == 1) { snprintf(b, sizeof(b), "{\"x\":%d,\"y\":%d},", x, y); bl += b; }
      else if (g_posBoard[y][x] == 2) { snprintf(b, sizeof(b), "{\"x\":%d,\"y\":%d},", x, y); wh += b; }
    }
  }
  if (!bl.empty()) bl.pop_back();
  if (!wh.empty()) wh.pop_back();
  std::string json = "{\"src\":\"desktop\",\"rule\":0,\"black\":[" + bl + "],\"white\":[" + wh + "]}";

  wchar_t tmp[MAX_PATH] = {0};
  GetTempPathW(MAX_PATH, tmp);
  std::wstring inbox = Join(std::wstring(tmp), L"gb-calc-inbox.json");
  FILE* f = _wfopen(inbox.c_str(), L"wb");
  if (f) { fwrite(json.data(), 1, json.size(), f); fclose(f); }
  else { LogMsg("[review] failed to write inbox file"); return; }
  LogMsg("[review] board written to inbox: " + std::to_string(json.size()) +
         " bytes (black/white from last scan)");

  HWND calc = FindWindowW(L"GbCalcHost", nullptr);
  if (calc) {
    if (IsIconic(calc)) ShowWindow(calc, SW_RESTORE);
    SetForegroundWindow(calc);
    LogMsg("[review] calculator already running -> activated");
    return;
  }
  
  std::wstring dir = ExeDir();
  
  std::wstring exe = Join(dir, L"Desktop GomokuTrainer.exe");
  if (!FileExists(exe)) {
    std::wstring e2 = Join(dir, L"Desktop GomokuCalculator.exe");
    if (FileExists(e2)) { exe = e2; }
    else {
      size_t p = dir.find_last_of(L"\\/");
      std::wstring up = (p == std::wstring::npos) ? dir : dir.substr(0, p);
      std::wstring e3 = Join(up, L"Desktop GomokuTrainer.exe");
      if (FileExists(e3)) { exe = e3; }
      else {
        std::wstring e4 = Join(up, L"Desktop GomokuCalculator.exe");
        if (FileExists(e4)) exe = e4;
      }
    }
  }
  if (!FileExists(exe)) {
    LogMsg("[review] Desktop GomokuTrainer.exe not found next to overlay");
    PostToPanel("{\"type\":\"toast\",\"text\":\"\\u627e\\u4e0d\\u5230\\u4e94\\u5b50\\u68cb\\u7ec3\\u4e60\\u5668\\uff08Desktop GomokuTrainer.exe\\uff09\"}");
    return;
  }
  SpawnDetached(exe, L"", dir);
  LogMsg("[review] calculator launched");
}

#define SEL_TITLE_H 44                 
#define SEL_GRIP    10                 
#define SEL_BTN_W   78                 
#define SEL_CLOSE_W 62                 
#define SEL_BTN_GAP 8                  
#define SEL_EDGE    8                  

#define SEL_PURPLE_R 196
#define SEL_PURPLE_G 170
#define SEL_PURPLE_B 255

enum { SEL_NONE = 0, SEL_MOVE, SEL_L, SEL_R, SEL_T, SEL_B, SEL_TL, SEL_TR, SEL_BL, SEL_BR,
       SEL_BTN_REC = 100, SEL_BTN_CLOSE = 101 };

static int   g_selDragMode = SEL_NONE; 
static int   g_selHoverBtn = SEL_NONE; 
static int   g_selPressBtn = SEL_NONE; 

static double g_selScale = 1.0;
static inline int SEL_S(int v) { return (int)llround((double)v * g_selScale); }
static POINT g_selDragPt   = {0, 0};   
static RECT  g_selDragRect = {0, 0, 0, 0}; 

static std::wstring SelT(const wchar_t* zh, const wchar_t* en) {
  return (g_uiLang == L"en") ? std::wstring(en) : std::wstring(zh);
}

static void CloseSelectWindow() {
  
  if (g_scanRegion.right > g_scanRegion.left || g_scanRegion.bottom > g_scanRegion.top) {
    g_scanRegion = RECT{0, 0, 0, 0};
    LogMsg("[adjust] manual region cleared -> full-screen auto board detection restored");
    PostToPanel("{\"type\":\"region\",\"set\":false}");
  }
  g_selApplied = false;
  if (g_selectWnd && IsWindow(g_selectWnd)) DestroyWindow(g_selectWnd);
  g_selectWnd = nullptr;
  if (g_selBmp) { DeleteObject(g_selBmp); g_selBmp = nullptr; }
  g_selBits = nullptr; g_selBmpW = 0; g_selBmpH = 0;
  g_selDragMode = SEL_NONE; g_selHoverBtn = SEL_NONE; g_selPressBtn = SEL_NONE;
}

static int SelHit(HWND h, int mx, int my) {
  RECT rc; GetClientRect(h, &rc);
  int W = rc.right, H = rc.bottom;
  if (my >= 0 && my < SEL_S(SEL_TITLE_H)) {
    if (mx >= g_selBtnRec.left && mx < g_selBtnRec.right &&
        my >= g_selBtnRec.top && my < g_selBtnRec.bottom) return SEL_BTN_REC;
    if (mx >= g_selBtnClose.left && mx < g_selBtnClose.right &&
        my >= g_selBtnClose.top && my < g_selBtnClose.bottom) return SEL_BTN_CLOSE;
    return SEL_MOVE;                                  
  }
  bool L = (mx < SEL_S(SEL_GRIP)), R = (mx >= W - SEL_S(SEL_GRIP));
  bool T = (my < SEL_S(SEL_TITLE_H + SEL_GRIP)), B = (my >= H - SEL_S(SEL_GRIP));
  if (L && T) return SEL_TL;
  if (R && T) return SEL_TR;
  if (L && B) return SEL_BL;
  if (R && B) return SEL_BR;
  if (L) return SEL_L;
  if (R) return SEL_R;
  if (T) return SEL_T;
  if (B) return SEL_B;
  return SEL_NONE;                                    
}

static void SelApplyCursor(int hit) {
  LPCWSTR c = IDC_ARROW;
  switch (hit) {
    case SEL_MOVE: c = IDC_SIZEALL; break;
    case SEL_L: case SEL_R: c = IDC_SIZEWE; break;
    case SEL_T: case SEL_B: c = IDC_SIZENS; break;
    case SEL_TL: case SEL_BR: c = IDC_SIZENWSE; break;
    case SEL_TR: case SEL_BL: c = IDC_SIZENESW; break;
    default: break;
  }
  SetCursor(LoadCursor(nullptr, c));
}

static void SelRoundRect(Gdiplus::GraphicsPath& p, float x, float y, float w, float h, float r) {
  if (r > w / 2.0f) r = w / 2.0f;
  if (r > h / 2.0f) r = h / 2.0f;
  p.AddArc(x, y, r * 2, r * 2, 180, 90);
  p.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
  p.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
  p.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
  p.CloseFigure();
}

static void PaintSelect(HWND h) {
  RECT rc;
  GetClientRect(h, &rc);
  int W = rc.right - rc.left, H = rc.bottom - rc.top;
  if (W <= 0 || H <= 0) return;
  if (!g_selBmp || g_selBmpW != W || g_selBmpH != H) {
    if (g_selBmp) DeleteObject(g_selBmp);
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = W;
    bi.bmiHeader.biHeight = -H;               
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    HDC screen = GetDC(nullptr);
    g_selBmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, (void**)&g_selBits, nullptr, 0);
    ReleaseDC(nullptr, screen);
    g_selBmpW = W; g_selBmpH = H;
  }
  if (!g_selBmp || !g_selBits) return;

  Gdiplus::Bitmap gb(W, H, W * 4, PixelFormat32bppPARGB, g_selBits);
  Gdiplus::Graphics g(&gb);
  g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
  
  g.Clear(Gdiplus::Color(0, 0, 0, 0));

  const Gdiplus::Color pur(SEL_PURPLE_R, SEL_PURPLE_G, SEL_PURPLE_B);
  {   
    Gdiplus::SolidBrush tb(Gdiplus::Color(236, pur.GetRed(), pur.GetGreen(), pur.GetBlue()));
    g.FillRectangle(&tb, 0.0f, 0.0f, (Gdiplus::REAL)W, (Gdiplus::REAL)SEL_S(SEL_TITLE_H));
    Gdiplus::Pen ul(Gdiplus::Color(120, 255, 255, 255), 1.0f);
    g.DrawLine(&ul, 0.0f, (Gdiplus::REAL)SEL_S(SEL_TITLE_H) - 0.5f,
               (Gdiplus::REAL)W, (Gdiplus::REAL)SEL_S(SEL_TITLE_H) - 0.5f);
  }
  
  {
    Gdiplus::FontFamily ff(L"Segoe UI");
    
    Gdiplus::Font f(&ff, (Gdiplus::REAL)SEL_S(15), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::SolidBrush b(Gdiplus::Color(255, 48, 34, 66));
    std::wstring t = SelT(L"\u624b\u52a8\u8c03\u8282", L"Adjust");
    if (g_selApplied) t += SelT(L" \u00b7 \u5df2\u9501\u5b9a\u533a\u57df", L" \u00b7 Locked");
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    g.DrawString(t.c_str(), -1, &f, Gdiplus::PointF((Gdiplus::REAL)SEL_S(12), (Gdiplus::REAL)(SEL_S(SEL_TITLE_H) / 2)),
                 &sf, &b);
  }
  
  {
    int bh = SEL_S(SEL_TITLE_H - 8), by = SEL_S(4);
    int bx2 = W - SEL_S(SEL_EDGE) - SEL_S(SEL_CLOSE_W);
    int bx1 = bx2 - SEL_S(SEL_BTN_GAP) - SEL_S(SEL_BTN_W);
    g_selBtnRec   = {bx1, by, bx1 + SEL_BTN_W, by + bh};
    g_selBtnClose = {bx2, by, bx2 + SEL_CLOSE_W, by + bh};
    struct BtnDef { RECT r; int id; int rr, gg, bb; std::wstring t; };
    BtnDef defs[2] = {
      { g_selBtnRec,   SEL_BTN_REC,   148, 108, 238, SelT(L"\u8bc6\u522b", L"Scan")  },
      { g_selBtnClose, SEL_BTN_CLOSE, 214,  96,  96, SelT(L"\u5173\u95ed", L"Close") },
    };
    Gdiplus::FontFamily ff(L"Segoe UI");
    
    Gdiplus::Font f(&ff, (Gdiplus::REAL)SEL_S(14), Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::StringFormat sf(Gdiplus::StringFormatFlagsNoWrap);
    sf.SetAlignment(Gdiplus::StringAlignmentCenter);
    sf.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    for (int i = 0; i < 2; ++i) {
      const BtnDef& d = defs[i];
      bool hov = (g_selHoverBtn == d.id), prs = (g_selPressBtn == d.id);
      int r = d.rr, gg = d.gg, bb = d.bb;
      if (hov && !prs) { r += 24; gg += 24; bb += 12; }
      if (prs)         { r -= 26; gg -= 26; bb -= 20; }
      if (r < 0) r = 0; if (gg < 0) gg = 0; if (bb < 0) bb = 0;
      if (r > 255) r = 255; if (gg > 255) gg = 255; if (bb > 255) bb = 255;
      Gdiplus::GraphicsPath p;
      SelRoundRect(p, (float)d.r.left, (float)d.r.top,
                   (float)(d.r.right - d.r.left), (float)(d.r.bottom - d.r.top), 4.0f);
      Gdiplus::SolidBrush fb(Gdiplus::Color(255, (BYTE)r, (BYTE)gg, (BYTE)bb));
      g.FillPath(&fb, &p);
      Gdiplus::SolidBrush tb(Gdiplus::Color(255, 255, 255, 255));
      g.DrawString(d.t.c_str(), -1, &f,
                   Gdiplus::RectF((float)d.r.left, (float)d.r.top,
                                  (float)(d.r.right - d.r.left), (float)(d.r.bottom - d.r.top)),
                   &sf, &tb);
    }
  }
  
  {
    Gdiplus::Pen pen(pur, 2.0f);
    g.DrawRectangle(&pen, 1.0f, (Gdiplus::REAL)SEL_S(SEL_TITLE_H) + 1.0f,
                    (Gdiplus::REAL)(W - 2), (Gdiplus::REAL)(H - SEL_S(SEL_TITLE_H) - 2));
    Gdiplus::SolidBrush hb(pur);
    const int hs = SEL_S(8);   
    float pts[4][2] = {
      {1.0f, (float)SEL_S(SEL_TITLE_H) + 1.0f},
      {(float)(W - 1 - hs), (float)SEL_S(SEL_TITLE_H) + 1.0f},
      {1.0f, (float)(H - 1 - hs)},
      {(float)(W - 1 - hs), (float)(H - 1 - hs)},
    };
    for (int i = 0; i < 4; ++i) g.FillRectangle(&hb, pts[i][0], pts[i][1], (float)hs, (float)hs);
  }
  HDC sdc = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(sdc);
  HGDIOBJ old = SelectObject(mem, g_selBmp);
  POINT src = {0, 0};
  SIZE sz = {W, H};
  BLENDFUNCTION bf = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(h, sdc, nullptr, &sz, mem, &src, 0, &bf, ULW_ALPHA);
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(nullptr, sdc);
}

static void SelApplyRegion(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + SEL_S(SEL_TITLE_H);     
  if (wr.right - wr.left < 24 || wr.bottom - top < 24) return;
  g_scanRegion.left = wr.left; g_scanRegion.top = top;
  g_scanRegion.right = wr.right; g_scanRegion.bottom = wr.bottom;
  LogMsg("[adjust] region set: screen (" + std::to_string(wr.left) + "," +
         std::to_string(top) + ") " + std::to_string(wr.right - wr.left) + "x" +
         std::to_string(wr.bottom - top));
  PostToPanel("{\"type\":\"region\",\"set\":true}");
  g_selApplied = true;
  
  g_regionDirty.store(true);
  PaintSelect(h);
}

static LRESULT CALLBACK SelProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE:
      g_selDragMode = SEL_NONE;
      return 0;
    case WM_SETCURSOR:
      if (LOWORD(lp) == HTCLIENT) {
        POINT pt; GetCursorPos(&pt); ScreenToClient(h, &pt);
        SelApplyCursor(SelHit(h, pt.x, pt.y));
        return TRUE;
      }
      break;
    case WM_MOUSEMOVE: {
      int mx = GET_X_LPARAM(lp), my = GET_Y_LPARAM(lp);
      if (g_selDragMode != SEL_NONE && g_selDragMode != SEL_BTN_REC && g_selDragMode != SEL_BTN_CLOSE) {
        POINT pt; GetCursorPos(&pt);
        int dx = pt.x - g_selDragPt.x, dy = pt.y - g_selDragPt.y;
        RECT r = g_selDragRect;
        switch (g_selDragMode) {
          case SEL_MOVE:
            r.left += dx; r.right += dx; r.top += dy; r.bottom += dy; break;
          case SEL_L: r.left  += dx; break;
          case SEL_R: r.right += dx; break;
          case SEL_T: r.top   += dy; break;
          case SEL_B: r.bottom += dy; break;
          case SEL_TL: r.left += dx; r.top += dy; break;
          case SEL_TR: r.right += dx; r.top += dy; break;
          case SEL_BL: r.left += dx; r.bottom += dy; break;
          case SEL_BR: r.right += dx; r.bottom += dy; break;
          default: break;
        }
        int minW = SEL_S(140), minH = SEL_S(SEL_TITLE_H + 60);
        if (r.right - r.left < minW) {
          if (g_selDragMode == SEL_L || g_selDragMode == SEL_TL || g_selDragMode == SEL_BL)
            r.left = r.right - minW;
          else r.right = r.left + minW;
        }
        if (r.bottom - r.top < minH) {
          if (g_selDragMode == SEL_T || g_selDragMode == SEL_TL || g_selDragMode == SEL_TR)
            r.top = r.bottom - minH;
          else r.bottom = r.top + minH;
        }
        SetWindowPos(h, nullptr, r.left, r.top, r.right - r.left, r.bottom - r.top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        
        if (g_selApplied) { g_selApplied = false; PaintSelect(h); }
        else PaintSelect(h);
        return 0;
      }
      int hit = SelHit(h, mx, my);
      int hov = (hit == SEL_BTN_REC || hit == SEL_BTN_CLOSE) ? hit : SEL_NONE;
      if (hov != g_selHoverBtn) { g_selHoverBtn = hov; PaintSelect(h); }
      SelApplyCursor(hit);
      return 0;
    }
    case WM_LBUTTONDOWN: {
      int hit = SelHit(h, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
      if (hit == SEL_BTN_REC || hit == SEL_BTN_CLOSE) {
        g_selPressBtn = hit; PaintSelect(h);
        SetCapture(h);
        return 0;
      }
      if (hit == SEL_NONE) return 0;
      g_selDragMode = hit;
      GetCursorPos(&g_selDragPt);
      GetWindowRect(h, &g_selDragRect);
      SetCapture(h);
      return 0;
    }
    case WM_LBUTTONUP: {
      if (!GetCapture()) { ReleaseCapture(); return 0; }
      ReleaseCapture();
      if (g_selPressBtn != SEL_NONE) {
        int hit = SelHit(h, GET_X_LPARAM(lp), GET_Y_LPARAM(lp));
        int pressed = g_selPressBtn;
        g_selPressBtn = SEL_NONE;
        if (hit == pressed) {
          if (pressed == SEL_BTN_REC) SelApplyRegion(h);   
          
          else CloseSelectWindow();
          return 0;
        }
        PaintSelect(h);
        return 0;
      }
      g_selDragMode = SEL_NONE;
      return 0;
    }
    case WM_KEYDOWN:
      if (wp == VK_ESCAPE) { CloseSelectWindow(); return 0; }
      return 0;
    case WM_SIZE:
      PaintSelect(h);
      return 0;
    case WM_DESTROY:
      g_selectWnd = nullptr;
      return 0;
    default:
      break;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

static void StartSelectWindow() {
  
  {
    char v[64] = {0};
    if (GetEnvironmentVariableA("GB_TEST_SELECT", v, sizeof(v)) && v[0]) {
      int x, y, w, h;
      if (sscanf(v, "%d,%d,%d,%d", &x, &y, &w, &h) == 4 && w > 0 && h > 0) {
        g_scanRegion.left = x; g_scanRegion.top = y;
        g_scanRegion.right = x + w; g_scanRegion.bottom = y + h;
        LogMsg("[adjust] (test) region set by GB_TEST_SELECT: (" +
               std::to_string(x) + "," + std::to_string(y) + ") " +
               std::to_string(w) + "x" + std::to_string(h));
        PostToPanel("{\"type\":\"region\",\"set\":true}");
        return;
      }
    }
  }
  
  if (g_selectWnd && IsWindow(g_selectWnd)) return;

  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SelProc;
  wc.hInstance = g_hInst;
  wc.lpszClassName = L"GbSelectHost";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassExW(&wc);

  g_selScale = 1.0;
  int x, y, w = 420, h = 420 + SEL_TITLE_H;
  if (g_scanRegion.right > g_scanRegion.left && g_scanRegion.bottom > g_scanRegion.top) {
    
    x = g_scanRegion.left;
    y = g_scanRegion.top - SEL_TITLE_H;
    w = g_scanRegion.right - g_scanRegion.left;
    h = (g_scanRegion.bottom - g_scanRegion.top) + SEL_TITLE_H;
  } else {
    MONITORINFO mi = {}; mi.cbSize = sizeof(mi);
    HMONITOR mon = MonitorFromWindow(g_overlay ? g_overlay : GetDesktopWindow(),
                                     MONITOR_DEFAULTTOPRIMARY);
    RECT wa = {0, 0, 1920, 1080};
    if (GetMonitorInfoW(mon, &mi)) wa = mi.rcWork;
    x = wa.left + (wa.right - wa.left - w) / 2;
    y = wa.top + (wa.bottom - wa.top - h) / 2;
  }
  g_selApplied = (g_scanRegion.right > g_scanRegion.left && g_scanRegion.bottom > g_scanRegion.top);
  g_selectWnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                                L"GbSelectHost", nullptr, WS_POPUP,
                                x, y, w, h, nullptr, nullptr, g_hInst, nullptr);
  if (!g_selectWnd) { LogMsg("[adjust] failed to create select window"); return; }
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x11
#endif
  
  if (SelfCaptureAllowedForTest()) {
    LogMsg("[adjust] (test) self-capture allowed -> select window left capturable on purpose");
  } else {
    SetWindowDisplayAffinity(g_selectWnd, WDA_EXCLUDEFROMCAPTURE);
  }
  ShowWindow(g_selectWnd, SW_SHOWNORMAL);
  PaintSelect(g_selectWnd);
  LogMsg("[adjust] hollow region window opened (drag title to move, edges to resize)");
}

static void ReportUiLook() {
  if (g_posWnd && IsWindow(g_posWnd)) {
    ApplyPosAlpha();     
  }
}

static bool JsonIntInRange(const std::string& s, size_t from, size_t limit,
                           const char* key, int& out) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = s.find(k, from);
  if (p == std::string::npos || p >= limit) return false;
  size_t c = s.find(':', p + k.size());
  if (c == std::string::npos || c >= limit) return false;
  size_t d = c + 1;
  while (d < limit && (s[d] == ' ' || s[d] == '\t' || s[d] == '\r' || s[d] == '\n')) ++d;
  bool neg = false;
  if (d < limit && (s[d] == '-' || s[d] == '+')) { neg = (s[d] == '-'); ++d; }
  if (d >= limit || s[d] < '0' || s[d] > '9') return false;
  long v = 0;
  while (d < limit && s[d] >= '0' && s[d] <= '9') { v = v * 10 + (s[d] - '0'); ++d; }
  out = neg ? (int)-v : (int)v;
  return true;
}

static bool ParseStonesForPos(const std::string& json) {
  for (int y = 0; y < 15; y++) for (int x = 0; x < 15; x++) g_posBoard[y][x] = 0;
  const char* keys[2] = {"black", "white"};
  int colors[2] = {1, 2};
  int total = 0;
  for (int k = 0; k < 2; ++k) {
    std::string kk = std::string("\"") + keys[k] + "\"";
    size_t p = json.find(kk);
    if (p == std::string::npos) continue;
    size_t lb = json.find('[', p + kk.size());
    if (lb == std::string::npos) continue;
    size_t rb = json.find(']', lb);
    if (rb == std::string::npos) continue;
    size_t i = lb;
    while (i < rb) {
      int x = 0, y = 0;
      size_t px = json.find("\"x\"", i);
      if (px == std::string::npos || px >= rb) break;
      if (!JsonIntInRange(json, px, rb, "x", x)) break;
      size_t py = json.find("\"y\"", px);
      if (py == std::string::npos || py >= rb) break;
      if (!JsonIntInRange(json, py, rb, "y", y)) break;
      if (x >= 0 && x < 15 && y >= 0 && y < 15) { g_posBoard[y][x] = colors[k]; total++; }
      i = py + 3;
    }
  }
  g_posHasBoard = (total > 0);
  return g_posHasBoard;
}

static int ScanSleepMs(long long elapsedMs, bool fast, bool noBoard = false) {
  
  int period = noBoard ? 1000 : (fast ? 100 : 380);
  int s = period - (int)elapsedMs;
  if (s < 60) s = 60;                 
  if (s > period) s = period;
  return s;
}

static void NotifyEngineHostBye() {
#ifdef GB_ASSISTANT_STANDALONE
  
  return;
#else
  if (g_relaunching) return;            
  static const DWORD t[4] = {800, 800, 800, 800};
  HttpRequest(8964, L"POST", L"/api/hostbye", std::string("{}"),
              L"Content-Type: application/json", t, nullptr);
  LogMsg("[boot] host bye sent to engine (die-with-host unless bookmark clients remain)");
#endif
}

static HANDLE g_frameWatchEvt = nullptr;    

static DWORD WINAPI FrameWatchProc(LPVOID) {
  const int WH = 96;                        
  unsigned char prev[WH * WH];
  bool havePrev = false;
  RECT cached = {0, 0, 0, 0};               
  HDC screen = nullptr, mem = nullptr;
  HBITMAP bmp = nullptr;
  HGDIOBJ oldBmp = nullptr;
  void* bits = nullptr;

  auto releaseGdi = [&]() {
    if (mem && oldBmp) { SelectObject(mem, oldBmp); oldBmp = nullptr; }
    if (bmp) { DeleteObject(bmp); bmp = nullptr; }
    if (mem) { DeleteDC(mem); mem = nullptr; }
    if (screen) { ReleaseDC(NULL, screen); screen = nullptr; }
    bits = nullptr;
    havePrev = false;
  };
  auto ensureGdi = [&]() -> bool {
    if (mem) return true;
    screen = GetDC(NULL);
    if (!screen) return false;
    mem = CreateCompatibleDC(screen);
    if (!mem) { ReleaseDC(NULL, screen); screen = nullptr; return false; }
    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = WH;
    bi.bmiHeader.biHeight = -WH;            
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!bmp || !bits) { releaseGdi(); return false; }
    oldBmp = SelectObject(mem, bmp);
    SetStretchBltMode(mem, COLORONCOLOR);   
    return true;
  };

  LogMsg("[scan] frame watcher started (30fps pixel-diff on board rect; full OpenCV only on change)");

  while (g_running.load()) {
    Sleep(33);                              
    if (!g_hasBoard.load()) { havePrev = false; continue; }

    RECT b = g_boardRect;
    if (b.right <= b.left || b.bottom <= b.top) { havePrev = false; continue; }
    int mx = (b.right - b.left) / 20 + 8, my = (b.bottom - b.top) / 20 + 8;
    RECT watch = {b.left - mx, b.top - my, b.right + mx, b.bottom + my};
    if (!havePrev && !EqualRect(&watch, &cached)) { cached = watch; havePrev = false; }

    if (!ensureGdi()) { releaseGdi(); continue; }
    if (!StretchBlt(mem, 0, 0, WH, WH, screen,
                    watch.left, watch.top,
                    watch.right - watch.left, watch.bottom - watch.top,
                    SRCCOPY | CAPTUREBLT)) {
      releaseGdi();                         
      continue;
    }

    const unsigned char* p = (const unsigned char*)bits;
    int changed = 0;
    for (int i = 0; i < WH * WH; ++i) {
      const unsigned char* q = p + i * 4;   
      int g = (q[0] * 77 + q[1] * 151 + q[2] * 28) >> 8;
      if (havePrev) {
        int d = g - prev[i];
        if (d < 0) d = -d;
        if (d > 24) ++changed;
      }
      prev[i] = (unsigned char)g;
    }
    havePrev = true;
    if (changed >= 12) SetEvent(g_frameWatchEvt);
  }
  releaseGdi();
  return 0;
}

static const int FRAME_LOCK = 3;

static void ScanLoop() {
  int ticks = 0;
  bool toldOffline = false;
  bool wokeByWatch = false;         
  
  std::string lastScanKey;
  int fastStreak = 0;
  int missStreak = 0;
  
  std::vector<double> geoX, geoY;
  double geoSpacing = 0;
  RECT geoRect = {0, 0, 0, 0};
  while (g_running.load()) {
    
    if (g_regionDirty.exchange(false)) {
      geoSpacing = 0; geoX.clear(); geoY.clear();
      geoRect = {0, 0, 0, 0};
      g_hasBoard.store(false);
      g_boardRect = {0, 0, 0, 0};
      fastStreak = 0; missStreak = 0;
      lastScanKey.clear();
      LogMsg("[adjust] region changed -> locked geometry cleared, re-detect inside new region");
    }
    
    if (g_ensureDepsRequested.exchange(false)) { EnsureEngine(); EnsureScanServer(); }
    if (ticks % 5 == 0) { EnsureEngine(); EnsureScanServer(); }   

    std::string excl;
    {
      RECT rr;
      auto addRect = [&excl](HWND hw) {
        if (!hw || !IsWindow(hw)) return false;
        RECT r;
        if (!GetWindowRect(hw, &r)) return false;
        if (r.right <= r.left || r.bottom <= r.top) return false;
        char b[160];
        snprintf(b, sizeof(b), "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld},",
                 (long)r.left, (long)r.top, (long)(r.right - r.left), (long)(r.bottom - r.top));
        excl += b;
        return true;
      };
      addRect(g_panel);
      
      if (g_posWnd && IsWindow(g_posWnd)) {
        RECT r;
        if (GetWindowRect(g_posWnd, &r) && r.right > r.left && r.bottom > r.top) {
          const long E = 16;
          char b[160];
          snprintf(b, sizeof(b), "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld},",
                   (long)r.left - E, (long)r.top - E,
                   (long)(r.right - r.left) + 2 * E, (long)(r.bottom - r.top) + 2 * E);
          excl += b;
        }
      }
      
      if (g_hasBoard.load() && !g_marksImmune) {
        const RECT rb = g_boardRect;
        const long bw = rb.right - rb.left, bh = rb.bottom - rb.top;
        if (bw > 8 && bh > 8) {
          
          const long EDGE = 6, SPAN = 15;   
          const long BANDH = EDGE + SPAN - 1;  
          auto addBand = [&excl](long x, long y, long w, long h) {
            char b[128];
            snprintf(b, sizeof(b), "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld},", x, y, w, h);
            excl += b;
          };
          
          const long REACH = EDGE + SPAN + 2;   
          
          addBand(rb.left - REACH, rb.top - EDGE - SPAN, bw + 2 * REACH, BANDH);
          addBand(rb.left - REACH, rb.bottom + 1, bw + 2 * REACH, BANDH);
          
          addBand(rb.left - EDGE - SPAN, rb.top - REACH, BANDH, bh + 2 * REACH);
          addBand(rb.right + 1, rb.top - REACH, BANDH, bh + 2 * REACH);
        }
      }
      if (!excl.empty()) excl.pop_back();          
    }
    
    const bool probe = (ticks % 15 == 7);
    
    const bool rectStable =
        geoSpacing > 0 &&
        std::abs(geoRect.left - g_boardRect.left) <= 3 &&
        std::abs(geoRect.top - g_boardRect.top) <= 3 &&
        std::abs(geoRect.right - g_boardRect.right) <= 3 &&
        std::abs(geoRect.bottom - g_boardRect.bottom) <= 3;
    
    static int lockedGeoOn = -1;
    if (lockedGeoOn < 0) {
      char lv[8] = {0};
      lockedGeoOn = (GetEnvironmentVariableA("GB_LOCKED_GEO", lv, sizeof(lv)) && lv[0] == '0') ? 0 : 1;
    }
    
    const bool regionLocked =
        (g_scanRegion.right > g_scanRegion.left && g_scanRegion.bottom > g_scanRegion.top);
    
    const bool useLocked = lockedGeoOn == 1 && g_hasBoard.load() && missStreak == 0 && !probe &&
                           (regionLocked || (rectStable && (wokeByWatch || fastStreak > 0)));
    std::string body = "{\"size\":15";
    if (!excl.empty()) body += ",\"exclude\":[" + excl + "]";
    
    if (g_scanRegion.right > g_scanRegion.left && g_scanRegion.bottom > g_scanRegion.top) {
      char rb[128];
      snprintf(rb, sizeof(rb), ",\"region\":[%ld,%ld,%ld,%ld]",
               (long)g_scanRegion.left, (long)g_scanRegion.top,
               (long)(g_scanRegion.right - g_scanRegion.left),
               (long)(g_scanRegion.bottom - g_scanRegion.top));
      body += rb;
    }
    if (useLocked) {
      char nb[24];
      std::string gs = ",\"geometry\":{\"x_lines\":[";
      for (size_t i = 0; i < geoX.size(); ++i) {
        snprintf(nb, sizeof(nb), "%.2f", geoX[i]);
        gs += nb;
        if (i + 1 < geoX.size()) gs += ",";
      }
      gs += "],\"y_lines\":[";
      for (size_t i = 0; i < geoY.size(); ++i) {
        snprintf(nb, sizeof(nb), "%.2f", geoY[i]);
        gs += nb;
        if (i + 1 < geoY.size()) gs += ",";
      }
      snprintf(nb, sizeof(nb), "%.3f", geoSpacing);
      gs += "],\"spacing\":" + std::string(nb) + "}";
      body += gs;
    }
    if (probe) body += ",\"probe\":true";
    body += "}";

    const long long tScan0 = NowMs();
    
    const bool blinkMarks = !g_marksImmune &&
        (g_balN.load() > 0 || g_guideOn.load() || g_heatN.load() > 0);
    if (blinkMarks) {
      g_scanHideBal.store(true);
      if (g_overlay) { PostMessageW(g_overlay, WM_APP + 2, 0, 0); Sleep(80); }
    }
    std::string res;
    if (!VisScanCall(body, res))                                     
      res = HttpPost(ScanPort(), L"/scan", body.c_str());            
    if (blinkMarks) {
      g_scanHideBal.store(false);
      if (g_overlay) PostMessageW(g_overlay, WM_APP + 2, 0, 0);
    }
    const long long scanElapsed = NowMs() - tScan0;
    if (res.empty()) {
      if (!toldOffline) { toldOffline = true; PostToPanel("{\"type\":\"offline\"}"); }
      ++ticks;
      Sleep(ScanSleepMs(scanElapsed, false));
      continue;
    }
    toldOffline = false;

    bool found = false, suspect = false;
    JsonBoolIn(res, "found", found);
    JsonBoolIn(res, "suspect", suspect);
    
    if (g_marksImmune && suspect && found) {
      bool invNotSwamped = false;
      JsonBoolIn(res, "not_swamped", invNotSwamped);
      if (invNotSwamped) {
        
        JsonSetBoolFirst(res, "suspect", false);
        suspect = false;
        static long long lastLiftTold = 0;
        long long liftNow = NowMs();
        if (liftNow - lastLiftTold > 10000) {         
          lastLiftTold = liftNow;
          LogMsg("[scan] imbalance gate lifted (marks layer immune): reading accepted as real board");
        }
      }
    }
    RECT r = {0, 0, 0, 0};
    bool hasRect = found && !suspect && JsonBoardRect(res, r);

    if (hasRect && !g_hasBoard.load()) {
      const LONG TOL = 4;
      static RECT pendRect = {0, 0, 0, 0};
      static int pendStreak = 0;
      bool same = (labs(r.left - pendRect.left) <= TOL && labs(r.top - pendRect.top) <= TOL &&
                   labs(r.right - pendRect.right) <= TOL && labs(r.bottom - pendRect.bottom) <= TOL);
      if (same && pendStreak > 0) ++pendStreak;
      else { pendRect = r; pendStreak = 1; }
      if (pendStreak < FRAME_LOCK) {
        hasRect = false;
        
        JsonSetBoolFirst(res, "found", false);
        found = false;
        static long long lastPendTold = 0;
        long long pendNow = NowMs();
        if (pendNow - lastPendTold > 8000) {
          lastPendTold = pendNow;
          char pb2[160];
          snprintf(pb2, sizeof(pb2),
                   "[scan] board frame pending confirmation %d/%d (frame-first: no stones without a stable frame)",
                   pendStreak, FRAME_LOCK);
          LogMsg(pb2);
        }
      }
    }

    bool changed = false;
    if (hasRect) {
      missStreak = 0;
      
      if (g_hasBoard.load()) {
        const long CLAMP = 12, JUMP = 48;
        auto cedge = [CLAMP, JUMP](long prev, long next) {
          long d = next - prev;
          if (d > JUMP || d < -JUMP) return next;      
          if (d > CLAMP) return prev + CLAMP;          
          if (d < -CLAMP) return prev - CLAMP;
          return next;                                 
        };
        r.left = cedge(g_boardRect.left, r.left);
        r.top = cedge(g_boardRect.top, r.top);
        r.right = cedge(g_boardRect.right, r.right);
        r.bottom = cedge(g_boardRect.bottom, r.bottom);
      }
      if (r.left != g_boardRect.left || r.top != g_boardRect.top ||
          r.right != g_boardRect.right || r.bottom != g_boardRect.bottom) changed = true;
      g_boardRect = r;
      ParseStars(res);
      g_hasBoard = true;
      
      {
        size_t xi = res.find("\"x_lines\"");
        size_t yi = res.find("\"y_lines\"");
        double sp = 0;
        if (xi != std::string::npos && yi != std::string::npos &&
            JsonNumberIn(res, "spacing", sp) && sp > 0) {
          size_t xb = res.find('[', xi), yb = res.find('[', yi);
          if (xb != std::string::npos && yb != std::string::npos) {
            std::vector<double> nx = JsonNumberArray(res, xb + 1);
            std::vector<double> ny = JsonNumberArray(res, yb + 1);
            if (nx.size() >= 3 && nx.size() == ny.size()) {
              geoX = nx;
              geoY = ny;
              geoSpacing = sp;
              geoRect = r;
            }
          }
        }
      }
    } else {
      
      if (++missStreak >= 2) {
        if (g_hasBoard.exchange(false)) changed = true;   
        g_starN.store(0);
        g_guideOn.store(false);
        g_heatN.store(0);
      }
      
    }
    if (changed && g_overlay) PostMessageW(g_overlay, WM_APP + 2, 0, 0);

    bool ignoreFrame = false;      
    {
      bool hasNow = found && !suspect && ParseStonesForPos(res);

      if (hasNow) {
        int nEdge = (int)geoX.size();
        if (nEdge < 5 || nEdge > 15) nEdge = 15;
        int ring = 0, inner = 0;
        for (int yy = 0; yy < nEdge; yy++) {
          for (int xx = 0; xx < nEdge; xx++) {
            if (!g_posBoard[yy][xx]) continue;
            if (xx == 0 || yy == 0 || xx == nEdge - 1 || yy == nEdge - 1) ++ring;
            else ++inner;
          }
        }
        if (ring >= 12 && inner == 0) {
          hasNow = false;
          ignoreFrame = true;
          g_posHasBoard = false;
          
          geoSpacing = 0;
          geoRect = RECT{0, 0, 0, 0};
          geoX.clear();
          geoY.clear();
          for (int yy = 0; yy < 15; yy++) for (int xx = 0; xx < 15; xx++) g_posBoard[yy][xx] = 0;
          static long long lastRingTold = 0;
          long long ringNow = NowMs();
          if (ringNow - lastRingTold > 8000) {
            lastRingTold = ringNow;
            char rb2[160];
            snprintf(rb2, sizeof(rb2),
                     "[scan] rejected border-ring garbage: %d stones all on the outer edge, interior empty",
                     ring);
            LogMsg(rb2);
          }
        }
      }
      static bool hadBefore = false;
      if (hasNow || hadBefore != hasNow) RefreshPositionWindow();

      {
        int nb = 0, nw = 0;
        for (int yy = 0; yy < 15; yy++) {
          for (int xx = 0; xx < 15; xx++) {
            if (g_posBoard[yy][xx] == 1) ++nb;
            else if (g_posBoard[yy][xx] == 2) ++nw;
          }
        }
        static int prevNb = -1, prevNw = -1;
        if (nb != prevNb || nw != prevNw) {
          char pb[128];
          snprintf(pb, sizeof(pb), "[pos] stones updated: B=%d W=%d (recognized=%d)",
                   nb, nw, (int)hasNow);
          LogMsg(pb);
          prevNb = nb;
          prevNw = nw;
        }
      }
      hadBefore = hasNow;

      if (hasNow) {
        static bool copiedOnce = false;
        char cv[8] = {0};
        if (!copiedOnce && GetEnvironmentVariableA("GB_TEST_COPY_POS", cv, sizeof(cv)) &&
            cv[0] == '1') {
          copiedOnce = true;
          PosCopyCode();
        }
      }
    }

    if (probe) {
      double nb = 0;
      if (JsonNumberIn(res, "multi_board", nb) && nb >= 2) {
        static long long lastWarn = 0;
        long long now = NowMs();
        if (now - lastWarn > 20000) {                 
          lastWarn = now;
          PostToPanel("{\"type\":\"multiBoard\",\"n\":" + std::to_string((int)llround(nb)) + "}");
          char b[160];
          snprintf(b, sizeof(b),
                   "[scan] %d boards on screen - asking user to keep only one",
                   (int)llround(nb));
          LogMsg(b);
        }
      }
    }

    if (!ignoreFrame) PostToPanel("{\"type\":\"scan\",\"data\":" + res + "}");
    ++ticks;
    {
      
      size_t pb = res.find("\"black\"");
      std::string key = (pb == std::string::npos) ? res : res.substr(pb);
      if (key != lastScanKey) { lastScanKey = key; fastStreak = 3; }  
      else if (fastStreak > 0) { --fastStreak; }
      
      const bool watchable = g_hasBoard.load() && fastStreak == 0 && missStreak == 0;
      wokeByWatch = false;
      if (!watchable) {
        
        Sleep(ScanSleepMs(scanElapsed, fastStreak > 0,
                          !g_hasBoard.load() && missStreak > 0));
      } else {
        int remain = 2000 - (int)scanElapsed;      
        if (remain < 100) remain = 100;
        if (remain > 2000) remain = 2000;
        wokeByWatch =
            (WaitForSingleObject(g_frameWatchEvt, (DWORD)remain) == WAIT_OBJECT_0);
      }
    }
  }
}

static std::wstring PanelPosFile() {
  
  wchar_t ob[MAX_PATH * 2] = {0};
  if (GetEnvironmentVariableW(L"GB_PANEL_POS_FILE", ob, MAX_PATH * 2) && ob[0]) return std::wstring(ob);
  wchar_t local[MAX_PATH] = {0};
  std::wstring dir = ExeDir();
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) {
    dir = Join(local, L"GomokuOverlay");
    CreateDirectoryW(dir.c_str(), nullptr);
  }
  
  return Join(dir, L"panel-pos" + InstanceSuffix() + L".txt");
}

static void LoadPanelPos() {
  FILE* f = _wfopen(PanelPosFile().c_str(), L"rb");
  if (!f) return;
  int x = 18, y = 18;
  
  int got = fscanf(f, "%d %d", &x, &y);
  if (got >= 2) {
    if (x > -4000 && x < 4000) g_panelOffX = x;
    if (y > -4000 && y < 4000) g_panelOffY = y;
  }
  fclose(f);
}

static void SavePanelPos() {
  FILE* f = _wfopen(PanelPosFile().c_str(), L"wb");
  if (!f) return;
  fprintf(f, "%d %d\n", g_panelOffX, g_panelOffY);
  fclose(f);
}

static void PanelTopLeft(int w, int h, int* px, int* py) {
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  int ox = (g_panelOffX >= 0) ? g_panelOffX : (int)llround(18 * g_dpi);
  int oy = (g_panelOffY >= 0) ? g_panelOffY : (int)llround(18 * g_dpi);
  int x = sw - w - ox;
  int y = sh - h - oy;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  *px = x;
  *py = y;
}

static void PaintPanelFallback(HWND h) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(h, &ps);
  RECT rc;
  GetClientRect(h, &rc);
  HBRUSH bg = CreateSolidBrush(RGB(255, 255, 255));
  FillRect(dc, &rc, bg);
  DeleteObject(bg);

  RECT hdr = rc;
  hdr.bottom = hdr.top + (LONG)(44 * g_dpi);
  HBRUSH hb = CreateSolidBrush(RGB(242, 243, 245));
  FillRect(dc, &hdr, hb);
  DeleteObject(hb);

  SetBkMode(dc, TRANSPARENT);
  HFONT f1 = CreateFontW(-(LONG)(13 * g_dpi + 0.5), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET,
                         OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei");
  HFONT f2 = CreateFontW(-(LONG)(12 * g_dpi + 0.5), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                         OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei");

  RECT tr = hdr;
  tr.left += (LONG)(12 * g_dpi);
  SetTextColor(dc, RGB(29, 29, 31));
  HGDIOBJ old = SelectObject(dc, f1);
  DrawTextW(dc, L"Gomoku Assistant", -1, &tr, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

  SelectObject(dc, f2);
  SetTextColor(dc, RGB(90, 96, 104));
  RECT br = rc;
  br.left += (LONG)(12 * g_dpi);
  br.right -= (LONG)(12 * g_dpi);
  br.top = hdr.bottom + (LONG)(10 * g_dpi);
  DrawTextW(dc, g_fallbackMsg.c_str(), -1, &br, DT_LEFT | DT_TOP | DT_WORDBREAK);

  SelectObject(dc, old);
  DeleteObject(f1);
  DeleteObject(f2);
  EndPaint(h, &ps);
}

static void EnableFallback() {
  if (g_showFallback) return;
  g_showFallback = true;
  if (g_controller) g_controller->put_IsVisible(FALSE);
  LogMsg("[ui] panel page timed out, switching to host fallback (see text below)");
  if (g_panel) InvalidateRect(g_panel, nullptr, TRUE);
}

static bool PanelDragZoneHit(POINT screenPt) {
  if (!g_panel || !IsWindow(g_panel)) return false;
  POINT pt = screenPt;
  ScreenToClient(g_panel, &pt);
  RECT rc;
  GetClientRect(g_panel, &rc);
  double dpr = EffectiveDpr();
  int hdrH = (int)llround(g_panelHdrH * dpr);
  if (pt.y < 0 || pt.y >= hdrH) return false;
  if (pt.x < 0 || pt.x >= rc.right) return false;
  for (size_t i = 0; i < g_panelBtnX.size(); ++i) {
    int l = (int)llround(g_panelBtnX[i].first * dpr);
    int r = (int)llround(g_panelBtnX[i].second * dpr);
    if (pt.x >= l && pt.x < r) return false;      
  }
  if (g_panelBtnX.empty()) {
    
    int dragW = (g_panelDragW > 0) ? (int)llround(g_panelDragW * dpr) : (rc.right - (int)(96 * dpr));
    if (dragW > rc.right) dragW = rc.right;
    if (pt.x >= dragW) return false;
  }
  return true;
}

static LRESULT CALLBACK WvChildProc(HWND h, UINT m, WPARAM w, LPARAM l, UINT_PTR, DWORD_PTR) {
  if (m == WM_NCHITTEST) {
    LRESULT r = DefSubclassProc(h, m, w, l);
    
    if (r == HTCLIENT) {
      POINT pt = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
      if (PanelDragZoneHit(pt)) return HTTRANSPARENT;
    }
    return r;
  }
  return DefSubclassProc(h, m, w, l);
}

static BOOL CALLBACK SubclassChildProc(HWND h, LPARAM) {
  for (size_t i = 0; i < g_wvSubclassed.size(); ++i) {
    if (g_wvSubclassed[i] == h) return TRUE;               
  }
  if (SetWindowSubclass(h, WvChildProc, 0x9B01, 0)) g_wvSubclassed.push_back(h);
  return TRUE;
}

static void EnsureWebViewSubclass() {
  if (!g_panel || !IsWindow(g_panel)) return;
  for (size_t i = 0; i < g_wvSubclassed.size(); ++i) {
    if (!IsWindow(g_wvSubclassed[i])) g_wvSubclassed[i] = nullptr;   
  }
  const size_t before = g_wvSubclassed.size();
  EnumChildWindows(g_panel, SubclassChildProc, 0);
  if (g_wvSubclassed.size() != before) {
    
    char b[144];
    snprintf(b, sizeof(b), "[panel] drag hit-test hook attached to %u WebView2 child windows (cumulative %u)",
             (unsigned)(g_wvSubclassed.size() - before), (unsigned)g_wvSubclassed.size());
    LogMsg(b);
  }
}

static LRESULT CALLBACK OverlayProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_APP + 2:
      PaintOverlay();
      
      PositionMarksWindow(true);
      return 0;
    case WM_APP + 3:
      
      if (!g_controller && g_env && g_panel) {
        LogMsg("[wv2] retrying controller creation");
        g_env->CreateCoreWebView2Controller(g_panel, new CtlHandler());
      }
      return 0;
    case WM_DISPLAYCHANGE:
      PaintOverlay();
      PositionMarksWindow(true);
      return 0;
    case WM_DESTROY: LogMsg("[boot] overlay window destroyed -> quitting"); PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static LRESULT CALLBACK PanelProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_APP + 1: ApplyPanelRect(); return 0;
    
    case WM_APP + 3: {
      std::wstring* ws = reinterpret_cast<std::wstring*>(l);
      if (ws) {
        if (g_webview) {
          HRESULT hr = g_webview->PostWebMessageAsJson(ws->c_str());
          static int fails = 0;
          if (FAILED(hr) && ++fails <= 5) {
            char b[160];
            snprintf(b, sizeof(b), "[ui] * failed to push to panel hr=0x%08lX (attempt %d, not repeated after)",
                     (unsigned long)hr, fails);
            LogMsg(b);
          }
        }
        delete ws;
      }
      return 0;
    }
    
    case WM_APP + 11: {
      POINT pt = {0, 0};
      GetCursorPos(&pt);
      ReleaseCapture();
      SendMessageW(h, WM_NCLBUTTONDOWN, HTCAPTION,
                   MAKELPARAM((WORD)(pt.x & 0xFFFF), (WORD)(pt.y & 0xFFFF)));
      return 0;
    }
    case WM_TIMER:
      
      if (w == 2) ReassertTopMost();
      else { EnsureWebViewSubclass(); ProbeWebView(); }
      return 0;
    case WM_SIZE: LayoutWebView(); EnsureWebViewSubclass(); return 0;
    case WM_ERASEBKGND: return 1;                
    case WM_PAINT:
      if (g_showFallback) { PaintPanelFallback(h); return 0; }
      break;
    case WM_NCHITTEST: {
      
      POINT pt = {(int)(short)LOWORD(l), (int)(short)HIWORD(l)};
      return PanelDragZoneHit(pt) ? HTCAPTION : HTCLIENT;
    }
    
    case WM_ENTERSIZEMOVE:
      g_panelDragging = true;
      return 0;
    case WM_EXITSIZEMOVE:
      g_panelDragging = false;
      g_panelApplied = RECT{0, 0, 0, 0};    
      OnPanelDragEnd();
      return 0;
    case WM_CLOSE: DestroyWindow(h); return 0;
    case WM_DESTROY:
      
      g_panel = nullptr;
      ClosePositionWindow();        
      if (g_exiting) {
        LogMsg("[boot] panel window destroyed (intentional exit) -> quitting");
        NotifyEngineHostBye();          
        g_running = false;
        PostQuitMessage(0);
      } else {
        LogMsg("[panel] panel window destroyed unexpectedly (not an intentional exit)");
        RestartForPanelRecovery();
        if (g_exiting) { g_running = false; PostQuitMessage(0); }   
      }
      return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static void EnableDpiAwareness() {
  HMODULE u = GetModuleHandleW(L"user32.dll");
  if (u) {
    typedef BOOL (WINAPI *PFN)(void*);
    PFN f = (PFN)GetProcAddress(u, "SetProcessDpiAwarenessContext");
    if (f) { f((void*)(INT_PTR)-4); return; }     
  }
  HMODULE sh = LoadLibraryW(L"shcore.dll");
  if (sh) {
    typedef HRESULT (WINAPI *PFN2)(int);
    PFN2 g = (PFN2)GetProcAddress(sh, "SetProcessDpiAwareness");
    if (g) g(2);
  }
}

static double QueryDpi() {
  HDC dc = GetDC(nullptr);
  int dpi = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
  if (dc) ReleaseDC(nullptr, dc);
  return dpi > 0 ? dpi / 96.0 : 1.0;
}

static bool WebView2RuntimeVersion(std::wstring& out) {
  LPWSTR ver = nullptr;
  HRESULT hr = GetAvailableCoreWebView2BrowserVersionString(nullptr, &ver);
  if (SUCCEEDED(hr) && ver) {
    out.assign(ver);
    CoTaskMemFree(ver);
    return true;
  }
  return false;
}

static void LogEnvSelfCheck() {
  
  typedef struct { ULONG sz; ULONG major; ULONG minor; ULONG build; ULONG plat; WCHAR csd[128]; } Osvi;
  std::string os = "unknown";
  bool win10plus = false;
  {
    HMODULE nt = GetModuleHandleW(L"ntdll.dll");
    Osvi vi;
    ZeroMemory(&vi, sizeof(vi));
    vi.sz = sizeof(vi);
    typedef LONG(WINAPI * Fn)(Osvi*);
    Fn fn = nt ? (Fn)GetProcAddress(nt, "RtlGetVersion") : nullptr;
    if (fn && fn(&vi) == 0) {
      char b[96];
      snprintf(b, sizeof(b), "%lu.%lu build %lu", (unsigned long)vi.major,
               (unsigned long)vi.minor, (unsigned long)vi.build);
      os = b;
      
      win10plus = (vi.major > 10) || (vi.major == 10 && vi.build >= 17763);
    }
  }
  const char* arch =
#ifdef _M_X64
      "x64";
#else
      "x86";
#endif
  char b[320];
  snprintf(b, sizeof(b),
           "[env] OS %s  arch=%s  %s  (baseline: Windows 10 build 17763 / 1809)",
           os.c_str(), arch, win10plus ? "supported" : "BELOW BASELINE - some features may fail");
  LogMsg(b);
  snprintf(b, sizeof(b),
           "[env] screen %dx%d  virtual %dx%d@(%d,%d)  monitors=%d  dpi=%.3f  pageDpr=%.3f",
           (int)GetSystemMetrics(SM_CXSCREEN), (int)GetSystemMetrics(SM_CYSCREEN),
           (int)GetSystemMetrics(SM_CXVIRTUALSCREEN), (int)GetSystemMetrics(SM_CYVIRTUALSCREEN),
           (int)GetSystemMetrics(SM_XVIRTUALSCREEN), (int)GetSystemMetrics(SM_YVIRTUALSCREEN),
           (int)GetSystemMetrics(SM_CMONITORS), g_dpi, g_pageDpr);
  LogMsg(b);
  
  std::wstring rt;
  LogMsg(std::string("[env] WebView2 runtime: ") +
         (WebView2RuntimeVersion(rt) ? WideToUtf8(rt) : "NOT FOUND (panel cannot render)"));
  LogMsg("[env] services: engine :8964 " + std::string(PortAlive(8964) ? "up" : "down") +
         ", recognition :" + std::to_string(ScanPort()) + " " +
         (PortAlive(ScanPort()) ? "up" : "down"));
}

static const wchar_t* kSplashBrand = L"Meter Gomoku Assistant";

static const wchar_t* kSplashVer = L"v4.37";

static HWND g_splash = nullptr;        

static const wchar_t* SplashFontFace() {
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

static void SplashPaint(HWND h, HDC dc) {
  RECT rc;
  GetClientRect(h, &rc);
  
  const COLORREF kBorder = RGB(0xb9, 0xc6, 0xd6);          
  HBRUSH bb = CreateSolidBrush(kBorder);
  FillRect(dc, &rc, bb);
  DeleteObject(bb);
  int B = (int)llround(4 * GetDeviceCaps(dc, LOGPIXELSY) / 96.0);   
  if (B < 3) B = 3;
  RECT inner = rc;
  inner.left += B; inner.top += B; inner.right -= B; inner.bottom -= B;
  HBRUSH br = CreateSolidBrush(RGB(0x26, 0x27, 0x2a));     
  FillRect(dc, &inner, br);
  DeleteObject(br);
  
  int fontPx = (int)llround((inner.bottom - inner.top) * 0.15);
  if (fontPx < 36) fontPx = 36;
  if (fontPx > 96) fontPx = 96;
  HFONT f = CreateFontW(-fontPx, 0, 0, 0, FW_SEMIBOLD, TRUE , FALSE, FALSE,
                        ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                        CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, SplashFontFace());
  HFONT fv = CreateFontW(-fontPx * 4 / 10, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                         ANSI_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                         CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, SplashFontFace());
  SetBkMode(dc, TRANSPARENT);
  HGDIOBJ prev = SelectObject(dc, f);                    
  
  const wchar_t* kMeter = L"Meter";
  size_t mlen = wcslen(kMeter);
  bool hasMeter = (wcsncmp(kSplashBrand, kMeter, mlen) == 0 && kSplashBrand[mlen] == L' ');
  const wchar_t* rest = hasMeter ? (kSplashBrand + mlen) : kSplashBrand;  
  SIZE sm = {0, 0}, sr = {0, 0};
  GetTextExtentPoint32W(dc, kMeter, (int)mlen, &sm);
  GetTextExtentPoint32W(dc, rest, (int)wcslen(rest), &sr);
  int tx = inner.left + ((inner.right - inner.left) - (sm.cx + sr.cx)) / 2;
  
  int ty = inner.top + (int)llround((inner.bottom - inner.top) * 0.382) - sr.cy / 2;
  if (hasMeter) {
    SetTextColor(dc, RGB(0x3d, 0x9b, 0xd6));               
    TextOutW(dc, tx, ty, kMeter, (int)mlen);
  }
  SetTextColor(dc, RGB(0x8c, 0xa6, 0xc0));                 
  TextOutW(dc, tx + sm.cx, ty, rest, (int)wcslen(rest));
  SelectObject(dc, fv);                                    
  const int vlen = lstrlenW(kSplashVer);
  SIZE sv = {0, 0};
  GetTextExtentPoint32W(dc, kSplashVer, vlen, &sv);
  SetTextColor(dc, RGB(0x6f, 0x86, 0x9e));
  TextOutW(dc, inner.left + ((inner.right - inner.left) - sv.cx) / 2, ty + sr.cy + fontPx * 3 / 10,
           kSplashVer, vlen);
  SelectObject(dc, prev);                                  
  DeleteObject(f);
  DeleteObject(fv);
}

static LRESULT CALLBACK SplashProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_CREATE) {
    
    SetTimer(h, 1, 45000, nullptr);
    return 0;
  }
  if (m == WM_PAINT) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    SplashPaint(h, dc);
    EndPaint(h, &ps);
    return 0;
  }
  if (m == WM_TIMER && w == 1) {
    DestroyWindow(h);
    return 0;
  }
  if (m == WM_DESTROY) {
    if (g_splash == h) g_splash = nullptr;
    return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static void SplashShow() {
  WNDCLASSEXW sc;
  ZeroMemory(&sc, sizeof(sc));
  sc.cbSize = sizeof(sc);
  sc.lpfnWndProc = SplashProc;
  sc.hInstance = g_hInst;
  sc.hCursor = LoadCursor(nullptr, IDC_WAIT);
  sc.hbrBackground = CreateSolidBrush(RGB(0x26, 0x27, 0x2a));  
  sc.lpszClassName = L"GbSplashHost";
  RegisterClassExW(&sc);
  const double dpr = g_dpi;                              
  const double cssW = POS_W * 2.0;                       
  const double cssH = POS_H * 2.0 / 4.0;                 
  const double ratio = cssW / cssH;                      
  double physW = cssW * dpr, physH = cssH * dpr;
  const int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  if (physW > sw * 0.50) { physW = sw * 0.50; physH = physW / ratio; }
  if (physH > sh * 0.30) { physH = sh * 0.30; physW = physH * ratio; }
  int w = (int)llround(physW), h = (int)llround(physH);
  int x = (sw - w) / 2;
  int y = (sh - h) / 2;
  g_splash = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                             L"GbSplashHost", kSplashBrand, WS_POPUP,
                             x, y, w, h, nullptr, nullptr, g_hInst, nullptr);
  if (g_splash) {
    ShowWindow(g_splash, SW_SHOWNOACTIVATE);
    
    UpdateWindow(g_splash);
    LogMsg(std::string("[boot] splash shown (") + WideToUtf8(kSplashBrand) +
           ", font=" + WideToUtf8(SplashFontFace()) + ")");
  }
}

static void SplashDismiss() {
  if (!g_splash || !IsWindow(g_splash)) { g_splash = nullptr; return; }
  HWND h = g_splash;
  g_splash = nullptr;
  KillTimer(h, 1);
  DestroyWindow(h);
  LogMsg("[boot] splash dismissed");
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE, LPSTR, int) {
  SetupConsole();                     
  g_hInst = inst;
  SetUnhandledExceptionFilter(CrashFilter);
  EnableDpiAwareness();
  g_dpi = QueryDpi();

  bool safeRetry = false;
  {
    wchar_t v[16] = {0};
    safeRetry = GetEnvironmentVariableW(L"GB_SAFE_RETRY", v, 16) && v[0] && v[0] != L'0';
    wchar_t ns[16] = {0};
    if (GetEnvironmentVariableW(L"GB_NO_SAFE_RETRY", ns, 16) && ns[0] && ns[0] != L'0') {
      g_noSafeRetry = true;
      LogMsg("[boot] disabled safe-mode auto-restart (GB_NO_SAFE_RETRY=1, for automated tests)");
    }
  }
  HANDLE mtx = nullptr;
  const std::wstring instSuf = InstanceSuffix();
  {
    
    wchar_t rv[16] = {0};
    if (GetEnvironmentVariableW(L"GB_PANEL_RECOVER", rv, 16) && rv[0]) {
      try { g_panelRecoveries = std::stoi(std::wstring(rv)); } catch (...) { g_panelRecoveries = 0; }
      if (g_panelRecoveries > 0)
        LogMsg("[boot] this is a panel self-heal restart (cumulative " + std::to_string(g_panelRecoveries) + " times)");
    }
  }
  
  const std::wstring mtxName = L"Global\\GomokuOverlay_v1" + instSuf;
  if (!instSuf.empty()) {
    LogMsg("[boot] instance namespace GB_INSTANCE_ID=" + WideToUtf8(instSuf) +
           " (mutex and saved position carry this suffix; will not collide with the default instance)");
  }
  for (int attempt = 0; attempt < 48; ++attempt) {          
    mtx = CreateMutexW(nullptr, TRUE, mtxName.c_str());
    if (mtx && GetLastError() != ERROR_ALREADY_EXISTS) break;   
    if (mtx) { CloseHandle(mtx); mtx = nullptr; }
    if (!safeRetry) break;                                 
    if (attempt == 0) LogMsg("[boot] safe-mode restart: waiting for previous instance to exit...");
    Sleep(250);
  }
  g_suiteMutex = mtx;
  if (!mtx) {
    if (safeRetry) { LogMsg("[boot] timed out waiting for previous instance, exiting"); return 0; }
    LogMsg("[boot] an overlay instance is already running, exiting");
    MessageBoxW(nullptr,
      L"Gomoku Assistant (desktop overlay) is already running.\n\n"
      L"Only one desktop overlay should be open: two instances would each draw their own corner brackets and board frame,\n"
      L"and each would grab the same engine port.\n\n"
      L"Please quit the one already running.\n"
      L"(The web bookmark build of GomokuEngine.exe does not conflict with this program and may run alongside it.)",
      L"Gomoku Assistant", MB_ICONINFORMATION | MB_TOPMOST);
    return 0;
  }
  if (safeRetry) LogMsg("[boot] safe-mode restart: took over previous instance");

  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  LogMsg("[boot] mutex acquired, COM initialized");
  Gdiplus::GdiplusStartupInput gsi;
  Gdiplus::GdiplusStartup(&g_gdiToken, &gsi, nullptr);
  
  std::thread depsEarly([]() {
    EnsureEngine();
    EnsureScanServer();
    PrewarmRecognition();                       
    LogMsg("[deps] dependency services ready (early warm-up)");
  });
  depsEarly.detach();
  
  SplashShow();
  LogEnvSelfCheck();                  

  g_uiDir = UiDir();
  LogMsg("[boot] UI dir " + WideToUtf8(g_uiDir) + "  dpi=" + std::to_string(g_dpi));

  int W = GetSystemMetrics(SM_CXSCREEN);
  int H = GetSystemMetrics(SM_CYSCREEN);

  WNDCLASSEXW oc;
  ZeroMemory(&oc, sizeof(oc));
  oc.cbSize = sizeof(oc);
  oc.lpfnWndProc = OverlayProc;
  oc.hInstance = inst;
  oc.lpszClassName = L"GbOverlayLayer";
  oc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassExW(&oc);

  g_overlay = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      L"GbOverlayLayer", L"", WS_POPUP, 0, 0, W, H, nullptr, nullptr, inst, nullptr);
  if (g_overlay) {
    ShowWindow(g_overlay, SW_SHOWNOACTIVATE);
    PaintOverlay();
  }
  
  {
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x11
#endif
    if (g_overlay) {
      
      if (SelfCaptureAllowedForTest()) {
        LogMsg("[boot] (test) self-capture allowed -> overlay left capturable on purpose");
      } else if (SetWindowDisplayAffinity(g_overlay, WDA_EXCLUDEFROMCAPTURE)) {
        LogMsg("[boot] overlay excluded from screen capture (heatmap/guide no longer pollute recognition)");
      } else {
        LogMsg("[boot] note: SetWindowDisplayAffinity failed (overlay may appear in captures)");
      }
    }
  }
  LogMsg(g_overlay ? "[boot] overlay window created" : "[boot] overlay window creation failed");

  EnsureMarksWindow(inst);

  WNDCLASSEXW pc;
  ZeroMemory(&pc, sizeof(pc));
  pc.cbSize = sizeof(pc);
  pc.lpfnWndProc = PanelProc;
  pc.hInstance = inst;
  pc.lpszClassName = L"GbPanelHost";
  pc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  
  pc.hbrBackground = nullptr;
  RegisterClassExW(&pc);

  LoadPanelPos();                                  
  
  int pw = 0, ph = 0;
  GoldenPanelSize(&pw, &ph);           
  const bool fixedSize = FixedPanelSizeEnabled();
  if (!fixedSize) { pw = (int)llround(236 * g_dpi); ph = (int)llround(640 * g_dpi); }
  int px = 0, py = 0;
  PanelTopLeft(pw, ph, &px, &py);
  {
    
    int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
    char pb[256];
    snprintf(pb, sizeof(pb),
             "[panel] launch position (%d,%d) %dx%d  bottom-right offset=(%d,%d)%s  screen=%dx%d",
             px, py, pw, ph, g_panelOffX, g_panelOffY,
             (g_panelOffX < 0 || g_panelOffY < 0) ? " (default, no saved position)" : " (read from save)",
             sw, sh);
    LogMsg(pb);
  }
  
  g_panel = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP,
      L"GbPanelHost", L"Desktop Gomoku Assistant",
      WS_POPUP, px, py, pw, ph, nullptr, nullptr, inst, nullptr);
  if (g_panel) {
    ApplyPanelTransparency();
    ShowWindow(g_panel, SW_SHOWNOACTIVATE);
    
    int rad = fixedSize ? 0 : (int)llround((PANEL_RADIUS_CSS + 1) * g_dpi);
    HRGN rgn = MakePanelRegion(pw, ph, rad);
    if (rgn) SetWindowRgn(g_panel, rgn, TRUE);

    LogMsg("[panel] pure transparency: no acrylic, no DWM blur-behind (content behind panel stays sharp)");
  }
  LogMsg(g_panel ? "[boot] panel window created" : "[boot] panel window creation failed");
  if (g_panel) {
    
    SetTimer(g_panel, 2, 4000, nullptr);
  }

  if (g_panel) {
    wchar_t mv[64] = {0};
    if (GetEnvironmentVariableW(L"GB_TEST_DRAG_TO", mv, 64) && mv[0]) {
      int tx = 0, ty = 0;
      if (swscanf(mv, L"%d,%d", &tx, &ty) == 2) {
        SetWindowPos(g_panel, HWND_TOPMOST, tx, ty, pw, ph, SWP_NOACTIVATE);
        OnPanelDragEnd();                    
        LogMsg("[panel] (test) simulated drag to target position and triggered save");
      }
    }
  }

  if (g_panel) {
    wchar_t nv[8] = {0};
    bool suppress = (GetEnvironmentVariableW(L"GB_NO_POS_WINDOW", nv, 8) && nv[0] == L'1');
    if (!suppress && !UnderTestEnv() && !g_posWnd) {
      OpenPositionWindow();
      LogMsg("[pos] position window opened by default at startup (GB_NO_POS_WINDOW=1 to disable)");
    }
  }

  if (g_panel) {
    wchar_t ov[32] = {0};
    if (GetEnvironmentVariableW(L"GB_TEST_OPEN_POS", ov, 32) && ov[0]) {
      if (_wcsicmp(ov, L"demo") == 0) {
        
        const int demo[5][3] = {{7, 7, 1}, {7, 5, 1}, {6, 6, 1}, {8, 8, 2}, {6, 8, 2}};
        for (int i = 0; i < 5; ++i) g_posBoard[demo[i][1]][demo[i][0]] = demo[i][2];
        g_posHasBoard = true;
        LogMsg("[pos] (test) demo position injected (5 stones)");
      }
      OpenPositionWindow();
      LogMsg("[pos] (test) position window auto-opened by GB_TEST_OPEN_POS");
      
      {
        char sv[MAX_PATH * 2] = {0};
        DWORD sn = GetEnvironmentVariableA("GB_TEST_SAVE_POS_PNG", sv, sizeof(sv));
        if (sn > 0 && sn < sizeof(sv) && g_posHasBoard) {
          LogMsg("[pos] (test) auto-saving board png (GB_TEST_SAVE_POS_PNG)");
          PosSavePng();
        }
      }
    }
  }

  {
    wchar_t local[MAX_PATH] = {0};
    std::wstring userData = Join(ExeDir(), L"WebView2Data");
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) {
      std::wstring dir = Join(local, L"GomokuOverlay");
      CreateDirectoryW(dir.c_str(), nullptr);
      std::wstring wv = Join(dir, L"WebView2");
      
      wchar_t iid[64] = {0};
      if (GetEnvironmentVariableW(L"GB_INSTANCE_ID", iid, 64) && iid[0]) {
        wv = Join(dir, std::wstring(L"WebView2_") + iid);
      }
      CreateDirectoryW(wv.c_str(), nullptr);
      userData = wv;
    }
    std::wstring rt;
    LogMsg(std::string("[boot] WebView2 Runtime ") + (WebView2RuntimeVersion(rt) ? WideToUtf8(rt) : "NOT FOUND") +
           "  userData=" + WideToUtf8(userData));
    std::wstring args = WebView2Args();
    LogMsg("[boot] WebView2 args " + WideToUtf8(args));
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, userData.c_str(), new EnvOptions(args),
                                                          new EnvHandler());
    wchar_t hx[32];
    swprintf(hx, 32, L"0x%08lX", (unsigned long)hr);
    LogMsg(std::string("[boot] CreateCoreWebView2EnvironmentWithOptions ") + WideToUtf8(hx));
    if (FAILED(hr)) {
      LogMsg("[boot] WebView2 environment creation failed");
      
      int r = MessageBoxW(nullptr,
        L"\u672a\u68c0\u6d4b\u5230 WebView2 \u8fd0\u884c\u65f6\uff08\u9762\u677f\u65e0\u6cd5\u663e\u793a\uff09\u3002\n\n"
        L"\u672c\u7a0b\u5e8f\u5176\u4f59\u529f\u80fd\u4e0d\u53d7\u5f71\u54cd\uff1a\u56db\u89d2\u5b9a\u4f4d\u6846\u3001\u68cb\u76d8\u8bc6\u522b\u4e0e\u5f15\u64ce\u7167\u5e38\u5de5\u4f5c\u3002\n\n"
        L"WebView2 \u8fd0\u884c\u65f6\u662f\u5fae\u8f6f\u514d\u8d39\u7ec4\u4ef6\uff1aWin11 \u4e0e\u7edd\u5927\u591a\u6570 Win10 \u968f Edge \u81ea\u5e26\u3002\n"
        L"\u70b9\u300c\u662f\u300d\u6253\u5f00\u5b98\u65b9\u4e0b\u8f7d\u9875\uff0c\u88c5\u597d\u540e\u91cd\u65b0\u6253\u5f00\u672c\u7a0b\u5e8f\u5373\u53ef\u3002",
        L"Gomoku Assistant / \u4e94\u5b50\u68cb\u52a9\u624b", MB_ICONWARNING | MB_TOPMOST | MB_YESNO);
      if (r == IDYES) {
        
        HINSTANCE sh = ShellExecuteW(nullptr, L"open",
                                     L"https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                                     nullptr, nullptr, SW_SHOWNORMAL);
        LogMsg(std::string("[boot] opened the WebView2 runtime download page (ShellExecute=") +
               std::to_string((INT_PTR)sh) + ")");
      }
    }
  }

  LogMsg("[boot] entering message loop");
  g_frameWatchEvt = CreateEventW(nullptr, FALSE, FALSE, nullptr);   
  std::thread frameWatch(FrameWatchProc, nullptr);  
  std::thread scanner(ScanLoop);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  g_running = false;
  
  if (g_relaunching.load()) {
    LogMsg("[boot] relaunching (self-heal/safe mode) -> keeping our dependency processes for the next instance");
  } else {
    KillOwnedDeps();
  }
  LogMsg("[boot] message loop ended, program exiting");
  if (scanner.joinable()) scanner.join();
  if (frameWatch.joinable()) frameWatch.join();
  if (g_frameWatchEvt) { CloseHandle(g_frameWatchEvt); g_frameWatchEvt = nullptr; }
  if (g_webview) g_webview->Release();
  if (g_controller) g_controller->Release();
  Gdiplus::GdiplusShutdown(g_gdiToken);
  CoUninitialize();
  if (mtx) CloseHandle(mtx);
  return 0;
}
