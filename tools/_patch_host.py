# -*- coding: utf-8 -*-
# Patch host.cpp: balance marks carry eval text; drawBalMk -> new shape
# (upper half hollow with sequence, lower half translucent filled with eval).
import io, sys

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
with io.open(p, "r", encoding="utf-8-sig") as f:
    s = f.read()

edits = []

# H1: globals
edits.append((
"static std::vector<std::pair<int,int>> g_lkBalB, g_lkBalW;",
"static std::vector<std::pair<int,int>> g_lkBalB, g_lkBalW;\nstatic std::vector<std::string> g_lkBalBEv, g_lkBalWEv;", False))

# H2: locals
edits.append((
"""            std::vector<std::pair<int,int>> nb, nw;
            std::vector<int> nsb, nsw;""",
"""            std::vector<std::pair<int,int>> nb, nw;
            std::vector<int> nsb, nsw;
            std::vector<std::string> nbev, nwev;""", False))

# H3: parse cell with eval
edits.append((
"""                  char color = 0;
                  while (i < t.size() && t[i] != ';' && t[i] != '"') {
                    if (t[i] == 'b' || t[i] == 'w') color = t[i];
                    ++i;
                  }
                  if (got == 3 && v[2] >= 0 && color) {
                    int gx = -1, gy = -1;
                    if (LinkScreenToGrid(v[0], v[1], gx, gy)) {
                      if (color == 'b') { nb.push_back({ gx, gy }); nsb.push_back(v[2]); }
                      else              { nw.push_back({ gx, gy }); nsw.push_back(v[2]); }
                    }
                  }""",
"""                  char color = 0; std::string evTxt;
                  while (i < t.size() && t[i] != ';' && t[i] != '"') {
                    if (t[i] == 'b' || t[i] == 'w') color = t[i];
                    else if (color) evTxt.push_back(t[i]);
                    ++i;
                  }
                  if (got == 3 && v[2] >= 0 && color) {
                    int gx = -1, gy = -1;
                    if (LinkScreenToGrid(v[0], v[1], gx, gy)) {
                      if (color == 'b') { nb.push_back({ gx, gy }); nsb.push_back(v[2]); nbev.push_back(evTxt); }
                      else              { nw.push_back({ gx, gy }); nsw.push_back(v[2]); nwev.push_back(evTxt); }
                    }
                  }""", False))

# H4: assign ev globals
edits.append((
"""            g_lkBalB = nb; g_lkBalW = nw;
            g_lkBalBSeq = nsb; g_lkBalWSeq = nsw;""",
"""            g_lkBalB = nb; g_lkBalW = nw;
            g_lkBalBSeq = nsb; g_lkBalWSeq = nsw;
            g_lkBalBEv = nbev; g_lkBalWEv = nwev;""", False))

# H5: linkBalanceDone path -> empty ev
edits.append((
"""      g_lkBalWSeq.assign(g_lkBalW.size(), 0);""",
"""      g_lkBalWSeq.assign(g_lkBalW.size(), 0);
      g_lkBalBEv.assign(g_lkBalB.size(), "");
      g_lkBalWEv.assign(g_lkBalW.size(), "");""", False))

# H6+H7: drawBalMk new shape + calls
old_draw = (
"""          auto drawBalMk = [&](const std::vector<std::pair<int,int>>& v,
                               const std::vector<int>& seqv,
                               int ringR, int ringG, int ringB, int dotR, int dotG, int dotB) {
            for (size_t mi = 0; mi < v.size(); ++mi) {
              const auto& mk = v[mi];
              if (mk.first < 0 || mk.first > 14 || mk.second < 0 || mk.second > 14) continue;
              float x = (float)(lx2[mk.first] - wr2.left), y = (float)(ly2[mk.second] - wr2.top);
              if (!inFrame(x, y)) continue;
              float br = (float)(sp2 * 0.4);
              Gdiplus::Pen bp(Gdiplus::Color(235, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB), 3.0f);
              g.DrawEllipse(&bp, x - br, y - br, br * 2, br * 2);
              int seq = (mi < seqv.size()) ? seqv[mi] : 0;
              if (seq > 0 && br >= 9.0f) {
                float fsz = sp2 * 0.42f; if (fsz < 10.0f) fsz = 10.0f; if (fsz > 20.0f) fsz = 20.0f;
                Gdiplus::FontFamily ff3(L"Segoe UI");
                Gdiplus::Font f3(&ff3, fsz, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
                if (f3.GetLastStatus() == Gdiplus::Ok) {
                  wchar_t num[8]; swprintf(num, 8, L"%d", seq);
                  Gdiplus::StringFormat sf3(Gdiplus::StringFormatFlagsNoWrap);
                  sf3.SetAlignment(Gdiplus::StringAlignmentCenter);
                  sf3.SetLineAlignment(Gdiplus::StringAlignmentCenter);
                  Gdiplus::SolidBrush halo3(Gdiplus::Color(215, 0, 0, 0));
                  Gdiplus::SolidBrush fg3(Gdiplus::Color(255, 255, 255, 255));
                  Gdiplus::RectF rc3(x - br, y - br, br * 2, br * 2);
                  g.DrawString(num, -1, &f3, Gdiplus::RectF(rc3.X - 1, rc3.Y, rc3.Width, rc3.Height), &sf3, &halo3);
                  g.DrawString(num, -1, &f3, rc3, &sf3, &fg3);
                }
              }
            }
          };
          drawBalMk(g_lkBalB, g_lkBalBSeq, 148, 108, 238, 70, 30, 90);   
          drawBalMk(g_lkBalW, g_lkBalWSeq, 70, 190, 175, 20, 60, 130);   """)

new_draw = (
"""          auto drawBalMk = [&](const std::vector<std::pair<int,int>>& v,
                               const std::vector<int>& seqv,
                               const std::vector<std::string>& evv,
                               int ringR, int ringG, int ringB) {
            for (size_t mi = 0; mi < v.size(); ++mi) {
              const auto& mk = v[mi];
              if (mk.first < 0 || mk.first > 14 || mk.second < 0 || mk.second > 14) continue;
              float x = (float)(lx2[mk.first] - wr2.left), y = (float)(ly2[mk.second] - wr2.top);
              if (!inFrame(x, y)) continue;
              float br = (float)(sp2 * 0.42);
              if (br < 4.0f) br = 4.0f;
              // lower half: translucent filled pie (the eval area)
              Gdiplus::SolidBrush body(Gdiplus::Color(150, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB));
              Gdiplus::GraphicsPath path;
              path.AddPie(x - br, y - br, br * 2, br * 2, 180.0f, 180.0f);
              g.FillPath(&body, &path);
              // upper half: hollow band (outer arc + inner arc) with the sequence number
              float rr2 = br * 0.62f;
              Gdiplus::Pen band(Gdiplus::Color(235, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB), 3.2f);
              g.DrawArc(&band, x - br, y - br, br * 2, br * 2, 0.0f, 180.0f);
              Gdiplus::Pen band2(Gdiplus::Color(235, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB), 1.4f);
              g.DrawArc(&band2, x - rr2, y - rr2, rr2 * 2, rr2 * 2, 0.0f, 180.0f);
              int seq = (mi < seqv.size()) ? seqv[mi] : 0;
              if (seq > 0 && br >= 8.0f) {
                float fsz = sp2 * 0.38f; if (fsz < 9.0f) fsz = 9.0f; if (fsz > 18.0f) fsz = 18.0f;
                Gdiplus::FontFamily ff3(L"Segoe UI");
                Gdiplus::Font f3(&ff3, fsz, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
                if (f3.GetLastStatus() == Gdiplus::Ok) {
                  wchar_t num[8]; swprintf(num, 8, L"%d", seq);
                  Gdiplus::StringFormat sf3(Gdiplus::StringFormatFlagsNoWrap);
                  sf3.SetAlignment(Gdiplus::StringAlignmentCenter);
                  sf3.SetLineAlignment(Gdiplus::StringAlignmentCenter);
                  Gdiplus::SolidBrush fg3(Gdiplus::Color(255, 255, 255, 255));
                  Gdiplus::RectF rcU(x - br, y - br * 1.05f, br * 2, br * 1.1f);
                  g.DrawString(num, -1, &f3, rcU, &sf3, &fg3);
                }
              }
              // eval text in the lower half (ASCII-only eval strings)
              std::string evUse = (mi < evv.size()) ? evv[mi] : std::string();
              if (!evUse.empty() && br >= 8.0f) {
                wchar_t evW[24]; int ewl = 0;
                for (; ewl < 22 && ewl < (int)evUse.size(); ++ewl) evW[ewl] = (wchar_t)(unsigned char)evUse[ewl];
                evW[ewl] = 0;
                float fszE = sp2 * 0.3f; if (fszE < 8.0f) fszE = 8.0f; if (fszE > 14.0f) fszE = 14.0f;
                Gdiplus::FontFamily ffE(L"Segoe UI");
                Gdiplus::Font fE(&ffE, fszE, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
                if (fE.GetLastStatus() == Gdiplus::Ok) {
                  Gdiplus::StringFormat sfE(Gdiplus::StringFormatFlagsNoWrap);
                  sfE.SetAlignment(Gdiplus::StringAlignmentCenter);
                  sfE.SetLineAlignment(Gdiplus::StringAlignmentCenter);
                  Gdiplus::SolidBrush fgE(Gdiplus::Color(255, 255, 255, 255));
                  Gdiplus::RectF rcL(x - br, y + br * 0.1f, br * 2, br * 0.9f);
                  g.DrawString(evW, -1, &fE, rcL, &sfE, &fgE);
                }
              }
            }
          };
          drawBalMk(g_lkBalB, g_lkBalBSeq, g_lkBalBEv, 148, 108, 238);   
          drawBalMk(g_lkBalW, g_lkBalWSeq, g_lkBalWEv, 70, 180, 235);   """)

ok = True
for i, (old, new, repl_all) in enumerate(edits):
    if old not in s:
        print("MISS #%d" % (i + 1)); ok = False; continue
    c = s.count(old)
    if c != 1 and not repl_all:
        print("AMB #%d count=%d" % (i + 1, c)); ok = False; continue
    s = s.replace(old, new) if repl_all else s.replace(old, new, 1)

if old_draw not in s:
    print("MISS DRAW (count=%d)" % s.count(old_draw)); ok = False
else:
    s = s.replace(old_draw, new_draw, 1)

if not ok:
    sys.exit(1)

with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    f.write(s)
print("host.cpp patched OK")
