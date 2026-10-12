# -*- coding: utf-8 -*-
# Patch host.cpp frame-selection logic:
#  1) Clicking Scan on a small frame (<1/3 screen) now switches to auto
#     board-search so the region grows onto the whole board (+/-0.6 cell).
#  2) Re-opening the frame with Auto on restarts fullscreen board-search.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
src = io.open(p, encoding='utf-8').read()

# --- Patch 1: LselApplyRegion small-frame -> auto board-search ---
old1 = """static void LselApplyRegion(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + LSEL_TITLE_H;
  if (wr.right - wr.left < 120 || wr.bottom - top < 120) return;
  g_scanRegion.left = wr.left + 2; g_scanRegion.top = top + 2;"""
new1 = """static void LselApplyRegion(HWND h) {
  RECT wr;
  GetWindowRect(h, &wr);
  int top = wr.top + LSEL_TITLE_H;
  if (wr.right - wr.left < 120 || wr.bottom - top < 120) return;
  // A frame smaller than ~1/3 of the screen almost certainly missed the whole
  // board: switch to auto board-search so the region grows onto the full grid
  // and auto-tightens to +/-0.6 cell (Auto stays on for later re-opens).
  {
    int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
    if ((wr.right - wr.left) < sw / 3 || (wr.bottom - top) < sh / 3) {
      g_lselAuto = true;
      LselSetAutoScanRegion();
      StartLinkScanLoop();
      PostToLinkPageSoon("{\\"type\\":\\"linkState\\",\\"frame\\":\\"pending\\"}");
      LogMsg("[link] small frame -> auto board-search (grow to full board)");
      LselPaint(h);
      return;
    }
  }
  g_scanRegion.left = wr.left + 2; g_scanRegion.top = top + 2;"""
assert old1 in src, "PATCH1 ANCHOR NOT FOUND"
src = src.replace(old1, new1)

# --- Patch 2: StartLinkFrame re-open with Auto on -> fullscreen search ---
old2 = """  LselOpenAt(x, y, w, h);
  LogMsg("[link] StartLinkFrame done");"""
new2 = """  LselOpenAt(x, y, w, h);
  if (g_lselAuto) {
    // Re-opening with Auto on: run fullscreen board-search so the frame
    // auto-tightens onto the board instead of scanning a stale region.
    LselSetAutoScanRegion();
    StartLinkScanLoop();
    LogMsg("[link] frame reopened with auto on -> fullscreen board-search");
  }
  LogMsg("[link] StartLinkFrame done");"""
assert old2 in src, "PATCH2 ANCHOR NOT FOUND"
src = src.replace(old2, new2)

io.open(p, 'w', encoding='utf-8', newline='').write(src)
print("HOST PATCHES OK")
