# -*- coding: utf-8 -*-
# Patch round 4:
# - Main-panel non-empty balance: multi-point via local engine (alternate
#   sides, real placement, near-zero-advantage candidate per step)
# - paint(): render balance marks even when RV_MODE / review is active
# - Layout: dashed group takes a full row (main panel + link window),
#   Swap Balance button widens to share the row with the Points dropdown
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

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

# 1) paint(): allow balance marks regardless of RV_MODE / review
jed.append((("""  if (G.ana.marks.length && aiDecorOn() && !balHide) {"""),
("""  if (G.ana.marks.length && (aiDecorOn() || G.ana.kind === 'bal' || G.ana.kind === 'bal1') && !balHide) {"""), False))

# 2) non-empty balance: local-engine multi-point iteration
jed.append((("""      renderBalMarks(marksArr, T('anBalDone').replace('{n}', String(marksArr.length)).replace('{list}', namesB.join(', ')));
      return;
    }
    if (empty) {"""),
("""      renderBalMarks(marksArr, T('anBalDone').replace('{n}', String(marksArr.length)).replace('{list}', namesB.join(', ')));
      return;
    }
    if (!empty) {
      // Local engine (hard bridge): one balanced pick per side, alternating
      // colours; each point is really placed on a working copy so the search
      // sees a genuine position. The engine returns the near-zero-advantage
      // candidate for the side to move, which is exactly a balance point.
      var bmB = G.board.map(function (r) { return r.slice(); });
      var plyB = G.moves.length;
      var marksArr = [], namesB = [];
      var qMs = Math.max(600, Math.min(1200, turnMs));
      var lanesB = ['main', 'sub', 'fwd'];
      for (var qi = 0; qi < need; qi++) {
        var curB = ((plyB + qi) % 2 === 0);
        var rQ = null;
        try {
          rQ = await analyze(qMs, 8, lanesB[qi % 3], curB ? 1 : 2, T('tagBal1'), { board: bmB });
        } catch (eQ) { rQ = null; }
        if (gen !== G.ana.gen) return;
        var csQ = (rQ && rQ.candidates) || [];
        if (!csQ.length) break;
        var biQ = 0, bvQ = Infinity;
        csQ.forEach(function (c, i) {
          var v = evalNum(c.eval);
          if (!isNaN(v) && Math.abs(v) < bvQ) { bvQ = Math.abs(v); biQ = i; }
        });
        var pQ = csQ[biQ];
        bmB[pQ.y][pQ.x] = curB ? 1 : 2;
        marksArr.push({ x: pQ.x, y: pQ.y, color: curB ? 'b' : 'w', ev: (pQ.eval != null ? pQ.eval : ''), seq: String(qi + 1) });
        namesB.push(coordName(pQ.x, pQ.y));
      }
      if (!marksArr.length) { renderAna(T('anEmpty')); return; }
      renderBalMarks(marksArr, T('anBalDone').replace('{n}', String(marksArr.length)).replace('{list}', namesB.join(', ')));
      return;
    }
    if (empty) {"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

# ---------------- calc.css ----------------
cp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.css"
cs = load(cp)
cs += (".anbtns .dashed-group{grid-column:1 / -1; display:flex; align-items:center; justify-content:center;"
       "gap:.25rem; width:100%; border:1px dashed var(--accent); border-radius:.4rem;"
       "padding:.12rem .2rem; box-sizing:border-box; min-width:0; max-width:100%}\n"
       ".anbtns .dashed-group .btn{flex:1; min-width:0;}\n"
       ".anbtns .dashed-group select{flex:0 0 2.9rem; min-width:0; padding:.22rem .15rem;"
       "font-size:.82rem; border:1px solid var(--line, #cfd8e3); border-radius:.3rem; background:transparent; color:inherit}\n"
       ".lk-btns .dashed-group{display:flex; align-items:center; gap:.3rem; width:100%;"
       "border:1px dashed var(--accent); border-radius:.4rem; padding:.12rem .2rem; box-sizing:border-box; min-width:0}\n"
       ".lk-btns .dashed-group #lk_bal{flex:1; min-width:0;}\n"
       ".lk-btns .dashed-group select{flex:0 0 2.9rem; min-width:0; padding:.22rem .15rem;"
       "font-size:.82rem; border:1px solid var(--line, #cfd8e3); border-radius:.3rem; background:transparent; color:inherit}\n")
save(cp, cs); print("calc.css patched OK")

sys.exit(0 if ok2 else 1)
