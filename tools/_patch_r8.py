# -*- coding: utf-8 -*-
# Patch round 8:
# - Main board balance mark: hollow UPPER half carries the sequence number,
#   translucent filled LOWER half carries the eval score (was inverted)
# - Empty-board scoring never uses the non-existent 'fwd' lane; if the engine
#   scoring yields nothing, the official balanced opening is still shown so
#   marks always appear
# - Link overlay balance marks: same hollow-upper/filled-lower half-circle
#   style as the main board (yesterday's logic, inner arc removed)
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

jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

# 1) balance mark orientation: hollow upper arc (sequence) + filled lower half (eval)
jed.append((("""      if (mk.inline && mk.label) {
        // Balance mark: hollow upper half (sequence) + filled lower half (eval)
        ctx.arc(px, py, mr, Math.PI, Math.PI * 2);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.4, gap * 0.06);
        ctx.strokeStyle = pal.ring;
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI * 2); ctx.stroke();
      } else if (multi) {"""),
("""      if (mk.inline && mk.label) {
        // Balance mark: hollow UPPER half carries the sequence number,
        // translucent filled LOWER half carries the eval score
        ctx.beginPath(); ctx.arc(px, py, mr, Math.PI, Math.PI * 2);   // upper arc
        ctx.strokeStyle = pal.badge;
        ctx.lineWidth = Math.max(2.2, gap * 0.09);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI);             // lower half
        ctx.closePath();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = pal.badge;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI * 2);         // white rim
        ctx.strokeStyle = 'rgba(255,255,255,.92)';
        ctx.lineWidth = Math.max(1.2, gap * 0.05);
        ctx.stroke();
      } else if (multi) {"""), False))

# 2) empty-board scoring: never use the 'fwd' lane
jed.append((("""      var lanesE = ['main', 'sub', 'fwd'];"""),
("""      var lanesE = ['main', 'sub', 'sub'];"""), False))

# 3) local multi-point fallback lanes: same fix
jed.append((("""      var lanesB = ['main', 'sub', 'fwd'];"""),
("""      var lanesB = ['main', 'sub', 'sub'];"""), False))

# 4) empty-board: if engine scoring yields nothing, still show the official
#    balanced opening so the marks always appear
jed.append((("""      await Promise.all(tasksE);
      if (gen !== G.ana.gen) return;
      if (!rsE.length) { renderAna(T('anEmpty')); return; }
      rsE.sort(function (a, b) { return Math.abs(a.ev) - Math.abs(b.ev); });"""),
("""      await Promise.all(tasksE);
      if (gen !== G.ana.gen) return;
      if (!rsE.length) {
        // Engine scoring unavailable: still show the official balanced opening
        var fb = BOOKS[0];
        var fbMarks = fb.map(function (pt, fi) {
          return { x: pt[0], y: pt[1], color: fi === 1 ? 'w' : 'b', ev: '', seq: String(fi + 1) };
        });
        renderBalMarks(fbMarks, T('anBalDone').replace('{n}', '3').replace('{list}', fbMarks.map(function (m) { return coordName(m.x, m.y); }).join(', ')));
        return;
      }
      rsE.sort(function (a, b) { return Math.abs(a.ev) - Math.abs(b.ev); });"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

# ---------------- host.cpp ----------------
hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
hs = load(hp)
old_mk = """              // classic circle marker (Link look): filled disc with a white
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
new_mk = """              // balance mark (same as the main board): hollow UPPER half carries
              // the sequence number, translucent filled LOWER half carries the
              // eval score; white rim, no inner arc
              Gdiplus::GraphicsPath path;
              path.AddPie(x - br, y - br, br * 2, br * 2, 0.0f, 180.0f);
              Gdiplus::SolidBrush body(Gdiplus::Color(150, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB));
              g.FillPath(&body, &path);
              Gdiplus::Pen band(Gdiplus::Color(235, (BYTE)ringR, (BYTE)ringG, (BYTE)ringB), 3.2f);
              g.DrawArc(&band, x - br, y - br, br * 2, br * 2, 180.0f, 180.0f);
              Gdiplus::Pen rim(Gdiplus::Color(255, 255, 255, 255), 1.4f);
              g.DrawEllipse(&rim, x - br, y - br, br * 2, br * 2);
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
                  Gdiplus::RectF rcU(x - br, y - br * 0.55f, br * 2, br * 1.0f);
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
hs, ok3 = apply(hs, ed2, "HOST")
if ok3:
    save(hp, hs); print("host.cpp patched OK")

sys.exit(0 if (ok2 and ok3) else 1)
