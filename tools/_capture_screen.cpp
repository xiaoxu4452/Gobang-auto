// 临时诊断工具：把当前屏幕抓成 PNG（用于确认识别端实际看到的内容）。
// 用法：_capture_screen.exe <out.png>
#include <windows.h>
#include <gdiplus.h>
#include <stdio.h>
#include <vector>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) { wprintf(L"usage: _capture_screen.exe <out.png>\n"); return 1; }
  const int sx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int sy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  wprintf(L"[cap] virtual screen %dx%d @(%d,%d)\n", sw, sh, sx, sy);
  if (sw <= 0 || sh <= 0) return 3;

  HDC sdc = GetDC(nullptr);
  if (!sdc) { wprintf(L"[cap] GetDC failed\n"); return 4; }
  HDC mem = CreateCompatibleDC(sdc);
  HBITMAP bmp = CreateCompatibleBitmap(sdc, sw, sh);
  if (!mem || !bmp) { wprintf(L"[cap] CreateCompatible* failed\n"); return 5; }
  HGDIOBJ old = SelectObject(mem, bmp);
  BOOL bok = BitBlt(mem, 0, 0, sw, sh, sdc, sx, sy, SRCCOPY | CAPTUREBLT);
  SelectObject(mem, old);
  wprintf(L"[cap] BitBlt=%d err=%lu\n", (int)bok, GetLastError());

  Gdiplus::GdiplusStartupInput si;
  ULONG_PTR tok = 0;
  if (Gdiplus::GdiplusStartup(&tok, &si, nullptr) != Gdiplus::Ok) {
    wprintf(L"[cap] gdiplus startup failed\n"); return 6;
  }
  {
    Gdiplus::Bitmap gb(bmp, nullptr);
    if (gb.GetLastStatus() != Gdiplus::Ok) { wprintf(L"[cap] Bitmap(HBITMAP) failed\n"); }
    UINT n = 0, sz = 0;
    Gdiplus::GetImageEncodersSize(&n, &sz);
    std::vector<BYTE> buf(sz ? sz : 1);
    Gdiplus::ImageCodecInfo* info = (Gdiplus::ImageCodecInfo*)buf.data();
    CLSID clsid;
    bool haveClsid = false;
    if (Gdiplus::GetImageEncoders(n, sz, info) == Gdiplus::Ok) {
      for (UINT i = 0; i < n; ++i) {
        if (info[i].MimeType && wcscmp(info[i].MimeType, L"image/png") == 0) {
          clsid = info[i].Clsid; haveClsid = true; break;
        }
      }
    }
    if (!haveClsid) { wprintf(L"[cap] no png encoder\n"); }
    else {
      Gdiplus::Status st = gb.Save(argv[1], &clsid, nullptr);
      wprintf(L"[cap] save status=%d -> %ls\n", (int)st, argv[1]);
    }
  }
  Gdiplus::GdiplusShutdown(tok);
  DeleteObject(bmp); DeleteDC(mem); ReleaseDC(nullptr, sdc);
  return 0;
}
