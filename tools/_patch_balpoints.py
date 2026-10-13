# -*- coding: utf-8 -*-
# Patch bridge.js: balance-point rework (any stone count, 1..6 point count,
# alternate colors, per-point eval, immune-layer cells with eval field).
import io, sys, os

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, "r", encoding="utf-8-sig") as f:
    s = f.read()

edits = []

# R1: zh strings
edits.append((
"""    adBtn: '\u81ea\u52a8\u843d\u5b50', swBalBtn: '\u4ea4\u6362\u5e73\u8861\u70b9', swEvalBtn: '\u4ea4\u6362\u8bc4\u4f30',""",
"""    adBtn: '\u81ea\u52a8\u843d\u5b50', swBalBtn: '\u4ea4\u6362\u5e73\u8861\u70b9', swEvalBtn: '\u4ea4\u6362\u8bc4\u4f30',
    balPointBtn: '\u70b9\u6570', balPointSet: '\u5e73\u8861\u70b9\u6570\u5df2\u8bbe\u4e3a %1\uff08\u7a7a\u76d8\u56fa\u5b9a 3\uff09',"""))

# R2: en strings
edits.append((
"""    adBtn: 'Auto drop', swBalBtn: 'Swap balance point', swEvalBtn: 'Swap eval',""",
"""    adBtn: 'Auto drop', swBalBtn: 'Swap balance point', swEvalBtn: 'Swap eval',
    balPointBtn: 'Points', balPointSet: 'Balance point count set to %1 (3 fixed on empty board)',"""))

# R3: state
edits.append((
"""  var swBusy = false, swEvalBusy = false;""",
"""  var balPointN = 2;
  try { var _bpn = parseInt(localStorage.getItem('gb_bal_point_n') || '2', 10); if (_bpn >= 1 && _bpn <= 6) balPointN = _bpn; } catch (e) {}
  var swBusy = false, swEvalBusy = false;"""))

# R4: drop the 0/3-ply restriction
edits.append((
"""    var swPly = lastBl.length + lastWh.length;
    if (swPly !== 0 && swPly !== 3) {
      ui('setStatus', swTipCol(LT('swBalStage'), '#e67e22'));
      return;
    }
    swBusy = true;""",
"""    swBusy = true;"""))

# R5: non-empty branch -> iterate N balanced points, alternate colors
edits.append((
"""        var pairMs = Math.max(400, Math.min(turnMs, leftMs() - 300));
        var pairBody = {
          board: boardMatrix(lastBl, lastWh), moveList: [], n: 1, mode: 'two', bias: 0,
          rule: rule, turnMs: pairMs, lane: 'main',
          cid: 'desktop-swbal2-' + (lastBl.length + lastWh.length),
          side: toBlack ? 1 : 2,
        };
        var j1 = null;
        try {
          
          j1 = await onMainLane(function () {
            return wsCall('balance', pairBody, pairMs + 6000);
          });
        } catch (ePair) { j1 = null; }
        if (!j1 || j1.error) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + ((j1 && j1.error) || 'no response') + '</span>');
          return;
        }
        if (j1.swap) { ui('setStatus', '<b style="color:#7c3aed">' + LT('swSwapNow') + '</b>'); return; }
        var pts1 = (j1.moves || []).slice(0, 2);
        if (pts1.length < 2) { ui('setStatus', '<span style="color:#c0392b">' + LT('balNone') + '</span>'); return; }
        marks.push({ p: pts1[0], color: toBlack ? 'b' : 'w' });
        marks.push({ p: pts1[1], color: toBlack ? 'w' : 'b' });
        balFromEngine = 2;
      }""",
"""        // Any stone count: evaluate the user-selected number of balanced
        // candidate points (1..6, default 2). Each round asks the engine's
        // official balance search (YXBALANCEONE) for one point that gives
        // neither side a visible advantage, then really places it, so the
        // next round searches the updated position and point colors
        // alternate exactly like real moves.
        var need = balPointN; if (need < 1 || need > 6) need = 2;
        var bmN = boardMatrix(lastBl, lastWh);
        var plyBase = lastBl.length + lastWh.length;
        for (var qi = 0; qi < need && leftMs() > 500; qi++) {
          var curB = ((plyBase + qi) % 2 === 0);
          var colQ = curB ? 'b' : 'w';
          var qMs = Math.max(300, Math.min(1500, leftMs() * 0.5));
          var qBody = {
            board: bmN, moveList: [], n: 1, mode: 'one', bias: 0,
            rule: rule, turnMs: qMs, lane: 'main',
            cid: 'desktop-swbal-n-' + plyBase + '-' + qi,
            side: curB ? 1 : 2,
          };
          var jq = null;
          try {
            jq = await onMainLane(function () { return wsCall('balance', qBody, qMs + 6000); });
          } catch (eQ) { jq = null; }
          if (!jq || jq.error || jq.swap || !jq.moves || !jq.moves.length) break;
          var ptn = jq.moves[0];
          marks.push({ p: ptn, color: colQ });
          bmN[ptn[1]][ptn[0]] = colQ === 'b' ? 1 : 2;
          balFromEngine++;
        }
        if (!marks.length) { ui('setStatus', '<span style="color:#c0392b">' + LT('balNone') + '</span>'); return; }
      }"""))

# R6: score each point (parallel lanes) before building cells
edits.append((
"""      var parts = [], names = [];""",
"""      // Score every balanced point with a short parallel analysis across
      // main/sub/fwd lanes; the eval appears in the lower half of each mark.
      var evs = [];
      if (marks.length) {
        var lanes3 = ['main', 'sub', 'fwd'];
        var evMs = Math.max(250, Math.min(400, Math.floor(leftMs() / Math.max(1, marks.length))));
        var evTasks = marks.map(function (m, mi) {
          var scB = boardMatrix(lastBl, lastWh);
          for (var si = 0; si <= mi; si++) scB[marks[si].p[1]][marks[si].p[0]] = marks[si].color === 'b' ? 1 : 2;
          var ln = lanes3[mi % 3];
          return wsCall('analyze', {
            board: scB, moveList: [], matchMs: 600000, turnMs: evMs,
            timeUsedMs: 0, topN: 1, rule: rule, lane: ln,
            cid: 'desktop-swbal-ev-' + (lastBl.length + lastWh.length) + '-' + mi,
          }, evMs + 6000).then(function (jv) {
            if (jv && !jv.error && jv.candidates && jv.candidates.length) return jv.candidates[0].eval || '';
            return '';
          }).catch(function () { return ''; });
        });
        evs = await Promise.all(evTasks);
      }
      
      var parts = [], names = [];"""))

# R7: cells carry eval
edits.append((
"""        if (p) parts.push(p.x + ',' + p.y + ',' + (i + 1) + ',' + marks[i].color);""",
"""        if (p) parts.push(p.x + ',' + p.y + ',' + (i + 1) + ',' + marks[i].color + ',' + (evs[i] || ''));"""))

# R8: point-count button (hidden __gb_balpoint, 1..6 cycle)
edits.append((
"""    ui('setStatus', LT('adCount') + '\u00d7' + adCount);
  });""",
"""    ui('setStatus', LT('adCount') + '\u00d7' + adCount);
  });

  function balPointSync() {
    var bp = document.getElementById('__gb_balpoint');
    if (bp) bp.textContent = '\u00d7' + balPointN;
    var lb = document.getElementById('lk_baln');
    if (lb) lb.textContent = '\u00d7' + balPointN;
    var mb = document.getElementById('btn_an_baln');
    if (mb) mb.textContent = '\u00d7' + balPointN;
  }
  on('__gb_balpoint', 'click', function () {
    balPointN = (balPointN % 6) + 1;
    try { localStorage.setItem('gb_bal_point_n', String(balPointN)); } catch (e) {}
    balPointSync();
    ui('setStatus', '<b style="color:#0e7490">' + LT('balPointSet').replace('%1', balPointN) + '</b>');
  });
  balPointSync();"""))

ok = True
for i, (old, new) in enumerate(edits):
    if old not in s:
        print("MISS #%d" % (i + 1))
        ok = False
        continue
    if s.count(old) != 1:
        print("AMB #%d count=%d" % (i + 1, s.count(old)))
        ok = False
        continue
    s = s.replace(old, new, 1)

if not ok:
    sys.exit(1)

with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    f.write(s)
print("bridge.js patched OK")
