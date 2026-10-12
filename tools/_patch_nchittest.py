# -*- coding: utf-8 -*-
import io, sys

path = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
raw = open(path, "rb").read()
bom = b""
if raw.startswith(b"\xef\xbb\xbf"):
    bom = b"\xef\xbb\xbf"; raw = raw[3:]
text = raw.decode("utf-8")

anchor = (
"static LRESULT CALLBACK LselProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {\n"
"  switch (msg) {\n"
"    case WM_SETCURSOR:\n"
)
inject = (
"static LRESULT CALLBACK LselProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {\n"
"  switch (msg) {\n"
"    case WM_NCHITTEST: {\n"
"      // 2026-10-07: hollow frame must be physically click-through. Per-pixel alpha=0 already\n"
"      // passes clicks; this is an explicit hit-test safety: LselHit==LSEL_NONE (the hollow\n"
"      // interior, and the whole window in mark-only mode) -> HTTRANSPARENT so clicks reach the\n"
"      // board beneath; title bar / buttons / edge grips -> HTCLIENT for this window to handle.\n"
"      POINT pt; pt.x = GET_X_LPARAM(lp); pt.y = GET_Y_LPARAM(lp);\n"
"      POINT cl = pt; ScreenToClient(h, &cl);\n"
"      if (LselHit(h, cl.x, cl.y) == LSEL_NONE) return HTTRANSPARENT;\n"
"      return HTCLIENT;\n"
"    }\n"
"    case WM_SETCURSOR:\n"
)

n = text.count(anchor)
print("anchor count:", n)
assert n == 1, "anchor not unique/found"
text = text.replace(anchor, inject)

open(path, "wb").write(bom + text.encode("utf-8"))
print("patched OK")
