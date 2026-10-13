# -*- coding: utf-8 -*-
# Patch round 5:
# - Prev/Next buttons use solid triangle arrows (like review mode)
# - Balance mark: no inner arc (remove ring-in-ring); seq larger at radius
#   midpoint in the hollow upper half; eval in the filled lower half
# - Main-panel balance picks go through the official engine balance search
#   (GB_BAL_POINTS, same channel as Link), rule-aware (freestyle /
#   freestyle-long / renju-forbidden); local iteration stays as fallback
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
    (('          <button id="btn_prev" class="btn ico" title="\u4e0a\u4e00\u6b65">\u2039</button>\n'
      '          <button id="btn_next" class="btn ico" title="\u4e0b\u4e00\u6b65">\u203a</button>'),
     ('          <button id="btn_prev" class="btn ico" title="\u4e0a\u4e00\u6b65">\u25c0</button>\n'
      '          <button id="btn_next" class="btn ico" title="\u4e0b\u4e00\u6b65">\u25b6</button>'), False),
]
hs, ok1 = apply(hs, hed, "HTML")
if ok1:
    save(hp, hs); print("calc.html patched OK")

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

# 1) mark shape: remove inner arc (no ring-in-ring), full-circle outline only
jed.append((("""      if (mk.inline && mk.label) {
        // Balance mark: hollow upper half (sequence) + filled lower half (eval)
        var rr2 = mr * 0.6;
        ctx.arc(px, py, mr, Math.PI, Math.PI * 2);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.4, gap * 0.06);
        ctx.strokeStyle = pal.ring;
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, rr2, 0, Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI * 2); ctx.stroke();
      } else if (multi) {"""),
("""      if (mk.inline && mk.label) {
        // Balance mark: hollow upper half (sequence) + filled lower half (eval)
        ctx.arc(px, py, mr, Math.PI, Math.PI * 2);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.4, gap * 0.06);
        ctx.strokeStyle = pal.ring;
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI * 2); ctx.stroke();
      } else if (multi) {"""), False))

# 2) seq larger, centered on the radius midpoint of the hollow upper half
jed.append((("""        if (mk.label) {
          ctx.font = '700 ' + mt.rf + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mt.ph * 0.34);
          ctx.font = '600 ' + mt.ef + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mt.ph * 0.34);
        } else {"""),
("""        if (mk.label) {
          ctx.font = '700 ' + Math.max(9, mr * 0.6) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mr * 0.48);
          ctx.font = '600 ' + Math.max(8, mr * 0.4) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mr * 0.48);
        } else {"""), False))

# 3) non-empty balance: prefer the official engine balance search channel
jed.append((("""    if (!empty) {
      // Local engine (hard bridge): one balanced pick per side, alternating"""),
("""    if (!empty) {
      if (typeof window.GB_BAL_POINTS === 'function') {
        var marksArr = [], namesB = [];
        try {
          await window.GB_BAL_POINTS({
            board: G.board, moves: G.moves.length, need: need, rule: engineRule(),
            turnMs: Math.max(2000, S.turnMs || 2000),
            onMarks: function (ms) { marksArr = ms || []; },
          });
        } catch (eB) { marksArr = []; }
        if (gen !== G.ana.gen) return;
        if (marksArr && marksArr.length) {
          marksArr.forEach(function (m) { namesB.push(coordName(m.x, m.y)); });
          renderBalMarks(marksArr, T('anBalDone').replace('{n}', String(marksArr.length)).replace('{list}', namesB.join(', ')));
          return;
        }
      }
      // Fallback: local engine (hard bridge), one balanced pick per side, alternating"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

# ---------------- bridge.js ----------------
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
bs = load(bp)
GBBP = """  window.GB_BAL_POINTS = async function (req) {
    // Official engine balance search for the main panel: req = {
    //   board: 0/1/2 matrix, moves: ply count, need: 1..6, rule: 0/1/2/5,
    //   turnMs, onMarks(marks), onStatus(text) }.
    // One near-zero-advantage point per side, really placed so colours
    // alternate like real moves; every point is then scored across lanes.
    if (swBusy || balBusy) { try { req.onMarks([]); } catch (e) {} return; }
    balBusy = true;
    var bmN = (req.board || []).map(function (r) { return r.slice(); });
    var plyBase = req.moves || 0;
    var needN = Math.max(1, Math.min(6, req.need || 2));
    var ruleN = (req.rule === 0 || req.rule === 1 || req.rule === 2 || req.rule === 5) ? req.rule : 0;
    var tmsN = Math.max(600, Math.min(1500, (req.turnMs || 2000) * 0.6));
    var marksN = [];
    try {
      await onMainLane(function () { return engCmd('main', 'INFO RULE ' + ruleN); });
      for (var qi2 = 0; qi2 < needN; qi2++) {
        var curB2 = ((plyBase + qi2) % 2 === 0);
        var colN = curB2 ? 'b' : 'w';
        var qb = { board: bmN, moveList: [], n: 1, mode: 'one', bias: 0,
                   rule: ruleN, turnMs: tmsN, lane: 'main',
                   cid: 'gb-balpts-' + plyBase + '-' + qi2,
                   side: curB2 ? 1 : 2 };
        var jn = null;
        try { jn = await onMainLane(function () { return wsCall('balance', qb, tmsN + 6000); }); }
        catch (eN) { jn = null; }
        if (!jn || jn.error || jn.swap || !jn.moves || !jn.moves.length) break;
        var ptn2 = jn.moves[0];
        marksN.push({ p: ptn2, color: colN });
        bmN[ptn2[1]][ptn2[0]] = colN === 'b' ? 1 : 2;
      }
      var evsN = [];
      if (marksN.length) {
        var lanes3 = ['main', 'sub', 'fwd'];
        var evMs = Math.max(250, Math.min(400, Math.round(tmsN * 0.3)));
        var evTasks = marksN.map(function (m, mi) {
          var scB = (req.board || []).map(function (r) { return r.slice(); });
          for (var si = 0; si <= mi; si++) scB[marksN[si].p[1]][marksN[si].p[0]] = marksN[si].color === 'b' ? 1 : 2;
          return wsCall('analyze', {
            board: scB, moveList: [], matchMs: 600000, turnMs: evMs,
            timeUsedMs: 0, topN: 1, rule: ruleN, lane: lanes3[mi % 3],
            cid: 'gb-balpts-ev-' + plyBase + '-' + mi,
          }, evMs + 6000).then(function (jv) {
            if (jv && !jv.error && jv.candidates && jv.candidates.length) return jv.candidates[0].eval || '';
            return '';
          }).catch(function () { return ''; });
        });
        evsN = await Promise.all(evTasks);
      }
      var out = marksN.map(function (m, mi) {
        return { x: m.p[0], y: m.p[1], color: m.color, ev: evsN[mi] || '', seq: String(mi + 1) };
      });
      try { req.onMarks(out); } catch (e) {}
    } finally {
      balBusy = false;
    }
  };
"""
bed = [
    ("""  window.GB_LINK_SWAPBAL = runSwapBal;""",
     GBBP + """  window.GB_LINK_SWAPBAL = runSwapBal;""", False),
]
bs, ok3 = apply(bs, bed, "BRIDGE")
if ok3:
    save(bp, bs); print("bridge.js patched OK")

sys.exit(0 if (ok1 and ok2 and ok3) else 1)
