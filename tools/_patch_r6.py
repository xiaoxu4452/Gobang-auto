# -*- coding: utf-8 -*-
# Patch round 6:
# - Prev/Next use tailed arrows (left/right arrows)
# - Balance marks persist on the main board exactly like the Link overlay:
#   afterMove() only counts off stones; marks clear when the chosen number
#   has been played, not after the first stone
# - Link overlay balance marks revert to the classic circle style
import io, sys

def load(p):
    return io.open(p, "r", encoding="utf-8-sig").read()

def save(p, s):
    io.open(p, "w", encoding="utf-8-sig", newline="").write(s)

def apply(s, edits, tag):
    ok = True
    for i, e in enumerate(edits):
        old, new, repl_all = e
        if old not in s:
            print("MISS %s#%d" % (tag, i + 1)); ok = False; continue
        c = s.count(old)
        if c != 1 and not repl_all:
            print("AMB %s#%d count=%d" % (tag, i + 1, c)); ok = False; continue
        s = s.replace(old, new) if repl_all else s.replace(old, new, 1)
    return s, ok

# ---------------- calc.html ----------------
hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.html"
hs = load(hp)
hed = [
    (('          <button id="btn_prev" class="btn ico" title="\u4e0a\u4e00\u6b65">\u25c0</button>\n'
      '          <button id="btn_next" class="btn ico" title="\u4e0b\u4e00\u6b65">\u25b6</button>'),
     ('          <button id="btn_prev" class="btn ico" title="\u4e0a\u4e00\u6b65">\u2190</button>\n'
      '          <button id="btn_next" class="btn ico" title="\u4e0b\u4e00\u6b65">\u2192</button>'), False),
]
hs, ok1 = apply(hs, hed, "HTML")
if ok1:
    save(hp, hs); print("calc.html patched OK")

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

# 1) place(): never clear balance marks; afterMove() owns the counting
jed.append((("""  if (G.ana.kind === 'bal' && G.ana.marks.length) {
    // Balance picks: keep the marks until the user has played the required
    // number of stones (any cells), then clear them automatically.
    G.ana.balLeft = (G.ana.balLeft || G.ana.marks.length) - 1;
    if (G.ana.balLeft <= 0) { anaReset(); }
    else { G.ana.busy = false; G.ana.kind = 'bal'; anaMark(null); }
  } else {
    G.ana.busy = false; G.ana.kind = '';
    anaReset();
  }"""),
("""  if (G.ana.kind !== 'bal') {
    G.ana.busy = false; G.ana.kind = '';
    anaReset();
  }"""), False))

# 2) afterMove(): balance marks persist like the Link overlay
jed.append((("""  if (boardDecided() && (G.ana.marks.length || G.ana.defCells)) {
    G.ana.gen++; G.ana.busy = false;
    if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
    G.ana.autoDefend = false;
    G.ana.marks = []; G.ana.rows = []; G.ana.defCells = null;
    anaMark(null); renderAna(T('anIdle'));
  }"""),
("""  if (boardDecided() && (G.ana.marks.length || G.ana.defCells)) {
    if (G.ana.kind === 'bal' && G.ana.marks.length) {
      // Balance picks persist like the Link overlay: keep the marks until
      // the required number of stones has been played (any cells), then
      // release the balance engine and hand control to the main analysis.
      G.ana.balLeft = (G.ana.balLeft || G.ana.marks.length) - 1;
      G.ana.busy = false;
      if (G.ana.balLeft <= 0) {
        G.ana.gen++;
        G.ana.marks = []; G.ana.rows = []; G.ana.defCells = null;
        G.ana.kind = '';
        anaMark(null); renderAna(T('anIdle'));
      } else {
        anaMark(null);
      }
    } else {
      G.ana.gen++; G.ana.busy = false;
      if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
      G.ana.autoDefend = false;
      G.ana.marks = []; G.ana.rows = []; G.ana.defCells = null;
      anaMark(null); renderAna(T('anIdle'));
    }
  }"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

# ---------------- host.cpp ----------------
hp2 = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
hs2 = load(hp2)
old_mk = """              // lower half: translucent filled pie (the eval area)
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
                float fszE = sp2 * 0.3f; if (fszE < 8.0f) fszE = 8.0f; if (fszE > 14.0f) fszE = 14.0f;"""
new_mk = """              // classic circle marker (Link look): filled disc with a white
              // rim, sequence number centred, small eval text in the lower half
              Gdiplus::SolidBrush body(Gdiplus::Color(215, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB));
              g.FillEllipse(&body, x - br, y - br, br * 2, br * 2);
              Gdiplus::Pen rim(Gdiplus::Color(255, 255, 255, 255), 1.6f);
              g.DrawEllipse(&rim, x - br, y - br, br * 2, br * 2);
              int seq = (mi < seqv.size()) ? seqv[mi] : 0;
              if (seq > 0 && br >= 8.0f) {
                float fsz = sp2 * 0.42f; if (fsz < 10.0f) fsz = 10.0f; if (fsz > 20.0f) fsz = 20.0f;
                Gdiplus::FontFamily ff3(L"Segoe UI");
                Gdiplus::Font f3(&ff3, fsz, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
                if (f3.GetLastStatus() == Gdiplus::Ok) {
                  wchar_t num[8]; swprintf(num, 8, L"%d", seq);
                  Gdiplus::StringFormat sf3(Gdiplus::StringFormatFlagsNoWrap);
                  sf3.SetAlignment(Gdiplus::StringAlignmentCenter);
                  sf3.SetLineAlignment(Gdiplus::StringAlignmentCenter);
                  Gdiplus::SolidBrush fg3(Gdiplus::Color(255, 255, 255, 255));
                  Gdiplus::RectF rcU(x - br, y - br * 0.6f, br * 2, br * 1.0f);
                  g.DrawString(num, -1, &f3, rcU, &sf3, &fg3);
                }
              }
              // eval text in the lower half (ASCII-only eval strings)
              std::string evUse = (mi < evv.size()) ? evv[mi] : std::string();
              if (!evUse.empty() && br >= 8.0f) {
                wchar_t evW[24]; int ewl = 0;
                for (; ewl < 22 && ewl < (int)evUse.size(); ++ewl) evW[ewl] = (wchar_t)(unsigned char)evUse[ewl];
                evW[ewl] = 0;
                float fszE = sp2 * 0.28f; if (fszE < 8.0f) fszE = 8.0f; if (fszE > 13.0f) fszE = 13.0f;"""
ed2 = [(old_mk, new_mk, False)]
hs2, ok3 = apply(hs2, ed2, "HOST")
if ok3:
    save(hp2, hs2); print("host.cpp patched OK")

sys.exit(0 if (ok1 and ok2 and ok3) else 1)
