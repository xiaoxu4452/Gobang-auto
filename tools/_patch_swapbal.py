# -*- coding: utf-8 -*-
"""Rewrite runSwapBal with legacy rule-aware balance (SWAP2BOARD + local book
fallback + engine balance fallback) so it can never fail with 'no response'."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

start_marker = "  async function runSwapBal() {"
end_marker = "  function swTip(h) {"

i0 = s.find(start_marker)
i1 = s.find(end_marker)
assert i0 >= 0 and i1 > i0, (i0, i1)

old_func = s[i0:i1]

new_func = """  // Rule-aware balance (legacy method): engine SWAP2BOARD opening under the
  // active rule -> local 9-opening book fallback -> engine BALANCE fallback.
  // Never surfaces "no response": every engine failure drops to the local book.
  var SW2_OPENINGS = [
    [[6,7],[6,4],[4,2]], [[3,3],[5,5],[6,6]], [[3,2],[5,4],[4,5]],
    [[5,2],[1,5],[1,6]], [[8,5],[5,8],[6,7]], [[5,5],[8,8],[7,7]],
    [[13,12],[13,9],[10,12]], [[11,7],[10,6],[13,5]], [[3,7],[1,8],[0,4]]
  ];
  var SW2_EXPANDED = (function () {
    var g = [
      function (e, t) { return [e, t]; }, function (e, t) { return [t, e]; },
      function (e, t) { return [N - 1 - e, t]; }, function (e, t) { return [e, N - 1 - t]; },
      function (e, t) { return [N - 1 - e, N - 1 - t]; }, function (e, t) { return [N - 1 - t, e]; },
      function (e, t) { return [t, N - 1 - e]; }, function (e, t) { return [N - 1 - t, N - 1 - e]; }
    ];
    var out = [], seen = {};
    for (var n = 0; n < SW2_OPENINGS.length; n++)
      for (var r = 0; r < g.length; r++) {
        var tri = [], key = [], ok = true;
        for (var u = 0; u < 3; u++) {
          var sp = g[r](SW2_OPENINGS[n][u][0], SW2_OPENINGS[n][u][1]);
          if (sp[0] < 0 || sp[0] >= N || sp[1] < 0 || sp[1] >= N) { ok = false; break; }
          tri.push([sp[0], sp[1]]); key.push(sp[0] + ',' + sp[1]);
        }
        if (!ok) continue;
        var k = key.slice().sort().join('|');
        if (seen[k]) continue;
        seen[k] = 1; out.push(tri);
      }
    return out;
  })();
  function localPairFallback(bl, wh, toBlack) {
    // Stable fallback for the second exchange: one stone per colour near the
    // existing stones, always valid, mirrors the engine's one-white one-black.
    var occ = {};
    var add = function (lst) { for (var i = 0; i < lst.length; i++) occ[lst[i][0] + ',' + lst[i][1]] = 1; };
    add(bl); add(wh);
    var near = function (color) {
      var refs = (color === 1 ? bl : wh);
      if (!refs.length) refs = (color === 1 ? wh : bl);
      var best = null, bestD = 1e9;
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        if (occ[x + ',' + y]) continue;
        var d = 1e9;
        for (var i = 0; i < refs.length; i++) {
          var dx = refs[i][0] - x, dy = refs[i][1] - y;
          d = Math.min(d, dx * dx + dy * dy);
        }
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
      if (best) occ[best[0] + ',' + best[1]] = 1;
      return best;
    };
    var first = near(toBlack ? 1 : 2);
    var second = near(toBlack ? 2 : 1);
    return [first, second];
  }
  async function runSwapBal() {
    if (swBusy || balBusy) return;
    
    if (!boardGeo) { ui('setStatus', '<span style="color:#e67e22;">' + T('no_board') + '</span>'); return; }
    
    var swPly = lastBl.length + lastWh.length;
    if (swPly !== 0 && swPly !== 3) {
      ui('setStatus', swTipCol(LT('swBalStage'), '#e67e22'));
      return;
    }
    swBusy = true;
    
    swQuietSide = true;
    if (S.side !== -1) setSide(-1);
    balOff();
    var empty = (lastBl.length + lastWh.length === 0);
    var toBlack = lastBl.length <= lastWh.length;
    
    var budget = Math.max(1500, Math.min(SWBAL_BUDGET_MS, Math.round((S.turnMs || 5000) * 1.5)));
    
    var turnMs = Math.max(2000, Math.min(S.turnMs || 5000, 4500));
    var rule = lkRule();
    
    var t0 = Date.now();
    var leftMs = function () { return budget - (Date.now() - t0); };
    try {
      ui('setStatus', '<span style="color:#0e7490">' + LT(empty ? 'swBalEmpty' : 'swBalPair') + '</span>');
      var marks = [];
      var balFromEngine = 0;
      if (empty) {
        // Path A: engine rule-aware opening (SWAP2BOARD picks per rule; renju
        // mode weights the forbidden-side balance). Instant reply, no long eval.
        try {
          var s2 = await onMainLane(function () {
            return wsCall('swap2board', {}, 8000);
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
        }
        if (marks.length < 3) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + 'local book empty</span>');
          balOff();
          return;
        }
      } else {
        // Second exchange (3 stones): rule-aware engine BALANCE_TWO; any
        // failure drops to a local one-black-one-white pair — never "no response".
        var j1 = null;
        try {
          var pairMs = Math.max(400, Math.min(turnMs, leftMs() - 300));
          var pairBody = {
            board: boardMatrix(lastBl, lastWh), moveList: [], n: 1, mode: 'two', bias: 0,
            rule: rule, turnMs: pairMs, lane: 'main',
            cid: 'desktop-swbal2-' + (lastBl.length + lastWh.length),
            side: toBlack ? 1 : 2,
          };
          j1 = await onMainLane(function () {
            return wsCall('balance', pairBody, pairMs + 6000);
          });
        } catch (ePair) { j1 = null; }
        var pts1 = (j1 && !j1.error && j1.moves) ? j1.moves.slice(0, 2) : [];
        if (pts1.length < 2) {
          pts1 = localPairFallback(lastBl, lastWh, toBlack);
        }
        if (!pts1[0] || !pts1[1]) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + 'no free cell</span>');
          return;
        }
        marks.push({ p: pts1[0], color: toBlack ? 'b' : 'w' });
        marks.push({ p: pts1[1], color: toBlack ? 'w' : 'b' });
        balFromEngine = 2;
      }
      
      var parts = [], names = [];
      for (var i = 0; i < marks.length; i++) {
        var p = boardToScreen(marks[i].p[0], marks[i].p[1]);
        if (p) parts.push(p.x + ',' + p.y + ',' + (i + 1) + ',' + marks[i].color);
        names.push(coordOf(marks[i].p[0], marks[i].p[1]));
      }
      
      if (parts.length !== marks.length) {
        ui('setStatus', '<span style="color:#c0392b">' + T('no_board') + '</span>');
        balOff();
        return;
      }
      if (parts.length && HOST) {
        tellHost({ type: 'balance', on: true, gap: Math.round(boardGap()), cells: parts.join(';') });
      }
      
      balSet(marks.map(function (m) { return [m.p[0], m.p[1]]; }), true,
             'swap' + (empty ? '-empty' : '-pair'),
             marks.map(function (m) { return m.color; }));
      
      var filledN = marks.length - balFromEngine;
      ui('setStatus', '<b style="color:#0e7490">' + LT('swBalDone') + names.join('  ') + '</b>' +
        (filledN > 0 ? '<span style="color:#e67e22">' + LT('swBalFilled').replace('%1', filledN) + '</span>' : ''));
      
      var balPts = marks.map(function (m) { return [m.p[0], m.p[1]]; });
      if (adOn && parts.length === marks.length) {
        swQueue = balPts; swIdx = 0;
        swBtnState();
        setTimeout(swAdvance, 200);
      } else {
        
        pendingBal = balPts;
      }
    } catch (e) {
      ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') +
        errText(e) + '</span>');
    } finally { swBusy = false; }
  }

"""
s = s[:i0] + new_func + s[i1:]

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK runSwapBal rewritten, old len=%d new len=%d" % (len(old_func), len(new_func)))
