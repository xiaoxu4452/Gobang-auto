# -*- coding: utf-8 -*-
# Patch round 11:
# - Empty board on the main panel uses the SAME official balance search as
#   gomocalc: three sequential YXBALANCEONE queries (black, white, black),
#   each really placed, so the three points are the ones closest to 0 for
#   both sides - never a forced-win opening. Rule-bound (renju/freestyle).
# - Balance marks are counted down ONLY by the user's own stones: place()
#   gains a byAI flag and aiMove passes true, so an AI auto-move right after
#   the user's move no longer clears the marks after one stone.
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

# 1) place(): byAI flag; balance marks count down only on the user's own moves
jed.append((("""function place(x, y, fromRedo) {"""),
("""function place(x, y, fromRedo, byAI) {"""), False))
jed.append((("""  if (G.ana.kind !== 'bal') {
    G.ana.busy = false; G.ana.kind = '';
    anaReset();
  }"""),
("""  if (G.ana.kind === 'bal' && G.ana.marks.length) {
    if (!byAI) {
      G.ana.balLeft = (G.ana.balLeft || G.ana.marks.length) - 1;
      if (G.ana.balLeft <= 0) {
        G.ana.gen++; G.ana.busy = false;
        G.ana.marks = []; G.ana.rows = []; G.ana.defCells = null;
        G.ana.kind = '';
        anaMark(null); renderAna(T('anIdle'));
      }
    }
    G.ana.busy = false;
  } else {
    G.ana.busy = false; G.ana.kind = '';
    anaReset();
  }"""), False))

# 2) aiMove(): pass byAI=true so auto-moves never consume balance counts
jed.append((("""    G.redo = [];                            
    place(best[0], best[1]);"""),
("""    G.redo = [];                            
    place(best[0], best[1], false, true);"""), False))

# 3) afterMove(): balance branch no longer counts down (place() owns it)
jed.append((("""    if (G.ana.kind === 'bal' && G.ana.marks.length) {
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
    } else {"""),
("""    if (G.ana.kind === 'bal' && G.ana.marks.length) {
      // Balance picks persist like the Link overlay. Only the user's own
      // stones count them down (place() with byAI=false); AI auto-moves
      // never clear the marks.
      G.ana.busy = false;
      anaMark(null);
    } else {"""), False))

# 4) empty board: official balance search first (gomocalc algorithm), the
#    local opening-set scoring stays only as a fallback
jed.append((("""    if (empty) {
      // Empty board: fixed 3 points (2 black + 1 white). The engine scores
      // every OFFICIAL balanced opening (rule-aware books, no winning lines)
      // and we keep the two most balanced black-3 points plus their shared
      // white-2 - exactly the "nearest to 0 score" balance-point logic.
      var probeE2 = Math.max(400, Math.min(800, Math.round(turnMs * 0.4)));"""),
("""    if (empty) {
      // Empty board: the SAME official balance search as gomocalc - three
      // sequential YXBALANCEONE queries (black, white, black), each point
      // really placed, so the returned points are the ones closest to 0
      // advantage for both sides (never a forced-win opening). Rule-bound.
      if (typeof window.GB_BAL_POINTS === 'function') {
        var marksE0 = [], namesE0 = [];
        try {
          await window.GB_BAL_POINTS({
            board: G.board, moves: 0, need: 3, rule: engineRule(),
            turnMs: Math.max(2000, S.turnMs || 2000),
            onMarks: function (ms) { marksE0 = ms || []; },
          });
        } catch (eE0) { marksE0 = []; }
        if (gen !== G.ana.gen) return;
        if (marksE0 && marksE0.length) {
          marksE0.forEach(function (m) { namesE0.push(coordName(m.x, m.y)); });
          renderBalMarks(marksE0, T('anBalDone').replace('{n}', String(marksE0.length)).replace('{list}', namesE0.join(', ')));
          return;
        }
      }
      // Fallback (engine unavailable): fixed 3 points from the OFFICIAL
      // balanced openings scored by the engine, winning lines excluded.
      var probeE2 = Math.max(400, Math.min(800, Math.round(turnMs * 0.4)));"""), False))

js, ok = apply(js, jed, "JS")
if ok:
    save(jp, js); print("calc.js patched OK")
sys.exit(0 if ok else 1)
