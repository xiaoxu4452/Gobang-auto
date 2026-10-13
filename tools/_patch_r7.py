# -*- coding: utf-8 -*-
# Patch round 7:
# - Main-panel balance picks follow the official rapfi logic like gomocalc:
#   empty board -> evaluate the OFFICIAL balanced opening set only (renju
#   6 / freestyle 9, winning openings excluded), engine-scored, keep the two
#   most balanced black-3 plus their shared white-2
# - Non-empty -> official balance search channel (GB_BAL_POINTS), already in
# - Link window keeps its own opening-book + balance path (two lines, split)
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

# 1) official balanced opening constants (rule-aware, winning openings excluded)
jed.append((("""async function anaBalPoints() {"""),
("""// Official balanced openings only (no winning lines): renju (forbidden
// moves) 6 sets, freestyle / long-no-win 9 sets. Mirrors the rapfi official
// logic used by gomocalc and the Link window's opening book.
var BAL_RJ = [
  [[7, 7], [8, 8], [9, 9]],   // Chosei  long star
  [[7, 7], [8, 8], [9, 5]],   // Ryusei  meteor
  [[7, 7], [8, 8], [8, 7]],   // Ungetsu  cloud moon
  [[7, 7], [7, 8], [7, 9]],   // Kansai  cold star
  [[7, 7], [7, 8], [9, 9]],   // Sosei  sparse star
  [[7, 7], [7, 8], [7, 5]],   // Zuisei  lucky star
];
var BAL_FR = [
  [[6, 7], [6, 4], [4, 2]],
  [[3, 3], [5, 5], [6, 6]],
  [[3, 2], [5, 4], [4, 5]],
  [[5, 2], [1, 5], [1, 6]],
  [[8, 5], [5, 8], [6, 7]],
  [[5, 5], [8, 8], [7, 7]],
  [[13, 12], [13, 9], [10, 12]],
  [[11, 7], [10, 6], [13, 5]],
  [[3, 7], [1, 8], [0, 4]],
];
async function anaBalPoints() {"""), False))

# 2) empty-board branch: score the official balanced openings with the engine
jed.append((("""    if (empty) {
      // Official balanced opening set: fixed 3 points (2 black + 1 white).
      // Evaluate every RIF balanced opening with the engine and keep the two
      // most balanced black-3 points plus their shared white-2.
      var probeE2 = Math.max(200, Math.min(400, Math.round(turnMs * 0.2)));
      var lanesE = ['main', 'sub', 'fwd'];
      var rsE = [];
      var tasksE = RIF_OPENINGS.map(function (op, i) {
        var bdE = newBoard();
        bdE[7][7] = 1; bdE[op.w[1]][op.w[0]] = 2; bdE[op.b[1]][op.b[0]] = 1;
        return analyze(probeE2, 1, lanesE[i % 3], 2, T('tagBal1'), { board: bdE }).then(function (rE) {
          var csE = (rE && rE.candidates) || [];
          if (csE.length) {
            var evE = evalNum(csE[0].eval);
            if (!isNaN(evE)) rsE.push({ x: op.b[0], y: op.b[1], w: op.w, ev: evE });
          }
        }).catch(function () {});
      });
      await Promise.all(tasksE);
      if (gen !== G.ana.gen) return;
      if (!rsE.length) { renderAna(T('anEmpty')); return; }
      rsE.sort(function (a, b) { return Math.abs(a.ev) - Math.abs(b.ev); });
      var topE = rsE.slice(0, 2);
      var marksE = [], namesE = [];
      topE.forEach(function (tE) {
        marksE.push({ x: tE.x, y: tE.y, color: 'b', ev: fmtEval(tE.ev), seq: '3' });
        namesE.push(coordName(tE.x, tE.y));
      });
      var w2 = topE[0].w || [8, 8];
      marksE.push({ x: w2[0], y: w2[1], color: 'w', ev: '', seq: '2' });
      namesE.push(coordName(w2[0], w2[1]));
      renderBalMarks(marksE, T('anBalDone').replace('{n}', '3').replace('{list}', namesE.join(', ')));
      return;
    }"""),
("""    if (empty) {
      // Empty board: fixed 3 points (2 black + 1 white). The engine scores
      // every OFFICIAL balanced opening (rule-aware books, no winning lines)
      // and we keep the two most balanced black-3 points plus their shared
      // white-2 - exactly the "nearest to 0 score" balance-point logic.
      var probeE2 = Math.max(400, Math.min(800, Math.round(turnMs * 0.4)));
      var lanesE = ['main', 'sub', 'fwd'];
      var rsE = [];
      var BOOKS = (engineRule() === 2) ? BAL_RJ : BAL_FR;
      var tasksE = BOOKS.map(function (op, i) {
        var bdE = newBoard();
        bdE[op[0][1]][op[0][0]] = 1; bdE[op[1][1]][op[1][0]] = 2; bdE[op[2][1]][op[2][0]] = 1;
        return analyze(probeE2, 1, lanesE[i % 3], 2, T('tagBal1'), { board: bdE }).then(function (rE) {
          var csE = (rE && rE.candidates) || [];
          if (csE.length) {
            var evE = evalNum(csE[0].eval);
            if (!isNaN(evE)) rsE.push({ x: op[2][0], y: op[2][1], w: op[1], ev: evE });
          }
        }).catch(function () {});
      });
      await Promise.all(tasksE);
      if (gen !== G.ana.gen) return;
      if (!rsE.length) { renderAna(T('anEmpty')); return; }
      rsE.sort(function (a, b) { return Math.abs(a.ev) - Math.abs(b.ev); });
      var topE = rsE.slice(0, 2);
      var marksE = [], namesE = [];
      topE.forEach(function (tE) {
        marksE.push({ x: tE.x, y: tE.y, color: 'b', ev: fmtEval(tE.ev), seq: '3' });
        namesE.push(coordName(tE.x, tE.y));
      });
      var w2 = topE[0].w || [8, 8];
      marksE.push({ x: w2[0], y: w2[1], color: 'w', ev: '', seq: '2' });
      namesE.push(coordName(w2[0], w2[1]));
      renderBalMarks(marksE, T('anBalDone').replace('{n}', '3').replace('{list}', namesE.join(', ')));
      return;
    }"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

sys.exit(0 if ok2 else 1)
