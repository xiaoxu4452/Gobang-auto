# -*- coding: utf-8 -*-
"""Patch bridge.js: unified rule mapping (lkRule) + side-to-move passing."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

old = """  function myIsToMove(bl, wh) {
    var toMoveIsBlack = bl.length <= wh.length;
    var iAmBlack = S.side === 0;
    return iAmBlack === toMoveIsBlack;
  }

  function evalForMe(rawEval, mine) {"""

new = """  function myIsToMove(bl, wh) {
    var toMoveIsBlack = bl.length <= wh.length;
    var iAmBlack = S.side === 0;
    return iAmBlack === toMoveIsBlack;
  }

  // Map UI rule ids to engine RULE ids (rapfi only accepts 0/1/2/5; yamaguchi
  // /taraguchi variants 6/7/8 collapse to renju=2, mirroring the main window).
  function lkRule() {
    var r = +S.rule;
    if (r === 6 || r === 7 || r === 8) return 2;
    return (r === 0 || r === 1 || r === 2 || r === 5) ? r : 0;
  }

  // Side to move (1=black, 2=white) inferred from stone counts, black first.
  function lkSide(bl, wh) { return (bl.length <= wh.length) ? 1 : 2; }

  function evalForMe(rawEval, mine) {"""

assert s.count(old) == 1, "lkRule pattern count=%d" % s.count(old)
s = s.replace(old, new)

# analyze: rule + side
old2 = """          matchMs: S.matchMs || 600000, turnMs: turnMsNow,
          timeUsedMs: 0, topN: 1, rule: S.rule, cid: 'desktop-' + ply,
          
          exclusive: true,"""
new2 = """          matchMs: S.matchMs || 600000, turnMs: turnMsNow,
          timeUsedMs: 0, topN: 1, rule: lkRule(), side: lkSide(bl, wh),
          cid: 'desktop-' + ply,
          
          exclusive: true,"""
assert s.count(old2) == 1, "analyze pattern count=%d" % s.count(old2)
s = s.replace(old2, new2)

# heatmap: rule + side
old3 = """          matchMs: S.matchMs || 600000, turnMs: ms, timeUsedMs: 0,
          topN: 8, rule: S.rule, cid: 'desktop-heat', lane: 'sub',"""
new3 = """          matchMs: S.matchMs || 600000, turnMs: ms, timeUsedMs: 0,
          topN: 8, rule: lkRule(), side: lkSide(bl, wh), cid: 'desktop-heat', lane: 'sub',"""
assert s.count(old3) == 1, "heatmap pattern count=%d" % s.count(old3)
s = s.replace(old3, new3)

# runSwapBal rule mapping
old4 = "    var rule = (S.rule === 0 || S.rule === 1 || S.rule === 2 || S.rule === 5) ? S.rule : 0;"
new4 = "    var rule = lkRule();"
assert s.count(old4) == 1, "swapbal pattern count=%d" % s.count(old4)
s = s.replace(old4, new4)

# runSwapEval rule
old5 = """        matchMs: 600000, turnMs: 2000, timeUsedMs: 0, topN: 1,
        rule: S.rule, lane: 'sub',
        cid: 'desktop-sweval-' + ply,"""
new5 = """        matchMs: 600000, turnMs: 2000, timeUsedMs: 0, topN: 1,
        rule: lkRule(), lane: 'sub',
        cid: 'desktop-sweval-' + ply,"""
assert s.count(old5) == 1, "sweval pattern count=%d" % s.count(old5)
s = s.replace(old5, new5)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK bridge.js patched")
