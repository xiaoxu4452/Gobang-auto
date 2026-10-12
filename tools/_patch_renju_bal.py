# -*- coding: utf-8 -*-
"""Renju-dedicated empty-board balance in runSwapBal: three engine
BALANCE_TWO rounds (black1, white2, black3) evaluated by the renju model
with forbidden-move awareness; falls back to SWAP2BOARD / local book."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

old = """      if (empty) {
        // Path A: engine rule-aware opening (SWAP2BOARD picks per rule; renju
        // mode weights the forbidden-side balance). Instant reply, no long eval.
        try {
          var s2 = await onMainLane(function () {
            return wsCall('swap2board', { rule: rule }, 8000);
          });
          if (s2 && s2.pts && s2.pts.length === 3) {
            // Skip the degenerate book entry that would overflow the edge.
            var deg = s2.pts[0][0] === 0 && s2.pts[0][1] === 0 &&
                      s2.pts[1][0] === 2 && s2.pts[1][1] === 1 &&
                      s2.pts[2][0] === 2 && s2.pts[2][1] === 4;
            if (!deg) {
              for (var i2 = 0; i2 < 3; i2++) marks.push({ p: s2.pts[i2], color: i2 === 1 ? 'w' : 'b' });
              balFromEngine = 3;
            }
          }
        } catch (eS2) {}
        if (marks.length < 3) {
          // Path B: local 9-opening book (random pick) — stable, never fails.
          var pick = SW2_EXPANDED[Math.floor(Math.random() * SW2_EXPANDED.length)];
          if (pick) {
            for (var i3 = 0; i3 < 3; i3++) marks.push({ p: pick[i3], color: i3 === 1 ? 'w' : 'b' });
            balFromEngine = 3;
          }
        }"""

new = """      if (empty) {
        // Path A0: renju dedicated balanced opening — three engine BALANCE_TWO
        // rounds (black1, white2, black3), each evaluated by the renju model
        // with forbidden-move awareness. Falls back to the shared book below.
        if (rule === 2) {
          try {
            var renBd = boardMatrix(lastBl, lastWh);
            var renPts = [];
            for (var rnd = 0; rnd < 3 && renBd; rnd++) {
              var rSide = (rnd % 2 === 0) ? 1 : 2;
              var renBody = {
                board: renBd, moveList: [], n: 1, mode: 'two', bias: 0,
                rule: 2, turnMs: 400, lane: 'main', side: rSide,
                cid: 'desktop-swbal-r' + rnd,
              };
              var jr = await onMainLane(function () {
                return wsCall('balance', renBody, 7000);
              });
              var rMvs = (jr && !jr.error && jr.moves) ? jr.moves : [];
              if (!rMvs.length) { renPts = []; break; }
              renPts.push(rMvs[0]);
              var placed = false;
              for (var ry = 0; ry < N && !placed; ry++)
                for (var rx = 0; rx < N; rx++)
                  if (renBd[ry][rx] === 0 && rMvs[0][0] === rx && rMvs[0][1] === ry) {
                    renBd[ry][rx] = rSide; placed = true; break;
                  }
            }
            if (renPts.length === 3) {
              for (var ri = 0; ri < 3; ri++)
                marks.push({ p: renPts[ri], color: ri % 2 === 0 ? 'b' : 'w' });
              balFromEngine = 3;
            }
          } catch (eRen) {}
        }
        if (marks.length < 3) {
          // Path A: engine rule-aware opening (SWAP2BOARD shared 9-book,
          // instant reply, no long eval).
          try {
            var s2 = await onMainLane(function () {
              return wsCall('swap2board', { rule: rule }, 8000);
            });
            if (s2 && s2.pts && s2.pts.length === 3) {
              // Skip the degenerate book entry that would overflow the edge.
              var deg = s2.pts[0][0] === 0 && s2.pts[0][1] === 0 &&
                        s2.pts[1][0] === 2 && s2.pts[1][1] === 1 &&
                        s2.pts[2][0] === 2 && s2.pts[2][1] === 4;
              if (!deg) {
                for (var i2 = 0; i2 < 3; i2++) marks.push({ p: s2.pts[i2], color: i2 === 1 ? 'w' : 'b' });
                balFromEngine = 3;
              }
            }
          } catch (eS2) {}
        }
        if (marks.length < 3) {
          // Path B: local 9-opening book (random pick) — stable, never fails.
          var pick = SW2_EXPANDED[Math.floor(Math.random() * SW2_EXPANDED.length)];
          if (pick) {
            for (var i3 = 0; i3 < 3; i3++) marks.push({ p: pick[i3], color: i3 === 1 ? 'w' : 'b' });
            balFromEngine = 3;
          }
        }"""

assert s.count(old) == 1, "runSwapBal empty branch"
s = s.replace(old, new)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK renju dedicated empty balance")
