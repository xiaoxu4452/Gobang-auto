# -*- coding: utf-8 -*-
# Precise host.cpp patch for v4.39: small-box auto-expand on Vision select shot,
# persisted auto-snap toggle. Run once on pristine host.cpp.
import io, sys

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    src = f.read()

ok = True
def must(sub, tag):
    global ok
    if sub not in src:
        print('MISSING:', tag); ok = False; return False
    return True

# 1) persist helpers before g_vselAuto + init change
anchor1 = "static bool g_vselAuto = true;"
helpers = """static bool VselLoadAuto() {
  wchar_t path[MAX_PATH] = { 0 };
  if (!GetEnvironmentVariableW(L"APPDATA", path, MAX_PATH)) return true;
  std::wstring p = std::wstring(path) + L"\\Meter Gomoku";
  CreateDirectoryW(p.c_str(), nullptr);
  std::wstring f = p + L"\\vsel-auto.cfg";
  FILE* fp = _wfopen(f.c_str(), L"r");
  if (!fp) return true;
  int v = 1;
  if (fscanf(fp, "%d", &v) == 1) { fclose(fp); return v != 0; }
  fclose(fp);
  return true;
}
static void VselSaveAuto(bool on) {
  wchar_t path[MAX_PATH] = { 0 };
  if (!GetEnvironmentVariableW(L"APPDATA", path, MAX_PATH)) return;
  std::wstring p = std::wstring(path) + L"\\Meter Gomoku";
  CreateDirectoryW(p.c_str(), nullptr);
  std::wstring f = p + L"\\vsel-auto.cfg";
  FILE* fp = _wfopen(f.c_str(), L"w");
  if (!fp) return;
  fprintf(fp, "%d", on ? 1 : 0);
  fclose(fp);
}
"""
if must(anchor1, 'anchor1'):
    src = src.replace(anchor1, helpers + "static bool g_vselAuto = VselLoadAuto();", 1)

# 2) VSEL_MIN_BOARD macro after VSEL_BTN_GAP
anchor2 = "#define VSEL_BTN_GAP (VsS(10))          "
if must(anchor2, 'anchor2'):
    src = src.replace(anchor2, anchor2 + "\n#define VSEL_MIN_BOARD (VsS(300))          ", 1)

# 3) forward decl + VselShot body replace
anchor3 = "static void VselShot(HWND h) {"
shot_new = """static bool VselAutoFindRect(RECT& br, double& step);
static void VselShot(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + VSEL_TITLE_H;
  RECT rc = { wr.left, top, wr.right, wr.bottom };
  if (rc.right - rc.left < 24 || rc.bottom - rc.top < 24) return;
  // Manual box too small to hold a board: run one automatic full-screen board
  // search and use its (larger, 0.6-cell padded) rect instead.
  if (rc.right - rc.left < VSEL_MIN_BOARD || rc.bottom - rc.top < VSEL_MIN_BOARD) {
    RECT br;
    double step = 0;
    if (VselAutoFindRect(br, step)) {
      double sp = step > 0 ? step : (double)(br.right - br.left) / 14.0;
      int pad = (int)(sp * 0.6 + 0.5);
      if (pad < 6) pad = 6;
      int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
      int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
      RECT ex = { br.left - pad, br.top - pad, br.right + pad, br.bottom + pad };
      if (ex.left < vx) ex.left = vx;
      if (ex.top < vy) ex.top = vy;
      if (ex.right > vx + vw) ex.right = vx + vw;
      if (ex.bottom > vy + vh) ex.bottom = vy + vh;
      LogMsg("[vis] small manual box -> auto board rect used");
      VisShotDeliver(ex);
      return;
    }
  }
  VisShotDeliver(rc);
}
"""
if must(anchor3, 'anchor3'):
    i = src.index(anchor3)
    j = src.index("static std::wstring FindVisionExe();", i)
    src = src[:i] + shot_new + "\n" + src[j:]

# 4) VselAutoScan -> finder + slim scan
anchor4 = "static void VselAutoScan(HWND h) {"
auto_new = """static bool VselAutoFindRect(RECT& br, double& step) {
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  RECT rc = { vx, vy, vx + vw, vy + vh };
  std::vector<unsigned char> png = CaptureRectPng(rc);
  if (png.empty()) return false;
  std::string out;
  if (!VisionScanImage(png.data(), (int)png.size(), out)) {
    std::wstring exe = FindVisionExe();
    if (exe.empty()) return false;
    wchar_t tmp[MAX_PATH] = { 0 };
    GetTempPathW(MAX_PATH, tmp);
    std::wstring imgPath = Join(std::wstring(tmp),
                                L"gbvis-snap-" + std::to_wstring(GetCurrentProcessId()) + L".png");
    {
      FILE* f = _wfopen(imgPath.c_str(), L"wb");
      if (!f) return false;
      fwrite(png.data(), 1, png.size(), f);
      fclose(f);
    }
    std::wstring cmd = L"\\"" + exe + L"\\" --scan-image \\"" + imgPath + L"\\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end()); cmdBuf.push_back(0);
    SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) { DeleteFileW(imgPath.c_str()); return false; }
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = wr; si.hStdError = wr;
    PROCESS_INFORMATION pi = {};
    std::wstring cwd = exe.substr(0, exe.find_last_of(L"\\\\/"));
    BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                             CREATE_NO_WINDOW, nullptr, cwd.c_str(), &si, &pi);
    CloseHandle(wr);
    if (!ok) { CloseHandle(rd); DeleteFileW(imgPath.c_str()); return false; }
    CloseHandle(pi.hThread);
    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
    ApplyVisionAffinity(pi.hProcess);
    ChildTrack(pi.hProcess);
    char buf[4096];
    DWORD n = 0;
    while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
    CloseHandle(rd);
    if (WaitForSingleObject(pi.hProcess, 15000) != WAIT_OBJECT_0)
      TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hProcess);
    DeleteFileW(imgPath.c_str());
  }
  if (!VselScanRect(out, br, step)) return false;
  br.left += vx; br.right += vx; br.top += vy; br.bottom += vy;
  return true;
}

static void VselAutoScan(HWND h) {
  if (g_vselAutoBusy.exchange(true)) return;
  std::thread([h] {
    RECT br;
    double step = 0;
    if (VselAutoFindRect(br, step)) {
      g_vselStep = step;
      RECT* rp = new RECT(br);
      if (!PostMessageW(h, VSEL_WM_SNAP, 0, (LPARAM)rp)) delete rp;
    }
    g_vselAutoBusy = false;
  }).detach();
}
"""
if must(anchor4, 'anchor4'):
    i = src.index(anchor4)
    j = src.index("static LRESULT CALLBACK VselProc(HWND h", i)
    src = src[:i] + auto_new + "\n" + src[j:]

# 5) persist on toggle
anchor5 = "            g_vselAuto = !g_vselAuto;"
if must(anchor5, 'anchor5'):
    src = src.replace(anchor5, anchor5 + "\n            VselSaveAuto(g_vselAuto);", 1)

with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print('patch done, ok =', ok)
