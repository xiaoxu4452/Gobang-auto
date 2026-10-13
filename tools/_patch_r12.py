# -*- coding: utf-8 -*-
# Patch round 12:
# - Opening balance follows the official gomocalc logic: black 1 is FIXED at
#   the tengen, then the engine evaluates exactly two balance points - white 2
#   and black 3 (one white, one black), each really placed. Marks: 1 = black
#   tengen, 2 = white, 3 = black - never a forced-win opening.
# - Balance marks show ONLY the sequence number (no eval score); the hint
#   text states Blue = White, Purple = Black.
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

# 1) empty-board branch: tengen black + two official balance points (white, black)
start = js.index("    if (empty) {")
end = js.index("      return;\n    }", start) + len("      return;\n    }")
new_block = """    if (empty) {
      // Official opening balance (gomocalc logic): black 1 is FIXED at the
      // tengen, then the engine evaluates exactly two balance points -
      // white 2 and black 3 (one white, one black), each really placed, so
      // the three marks are black-tengen / white / black and never a
      // forced-win opening. Rule-bound (renju / freestyle).
      if (typeof window.GB_BAL_POINTS === 'function') {
        var tgB = G.board.map(function (r) { return r.slice(); });
        var cyB = (N - 1) >> 1;
        if (!tgB[cyB][cyB]) {
          tgB[cyB][cyB] = 1;
          var marksE0 = [], namesE0 = [];
          try {
            await window.GB_BAL_POINTS({
              board: tgB, moves: 1, need: 2, rule: engineRule(),
              turnMs: Math.max(2000, S.turnMs || 2000),
              onMarks: function (ms) { marksE0 = ms || []; },
            });
          } catch (eE0) { marksE0 = []; }
          if (gen !== G.ana.gen) return;
          if (marksE0 && marksE0.length) {
            var fullE = [{ x: cyB, y: cyB, color: 'b', ev: '', seq: '1' }];
            marksE0.forEach(function (m) {
              fullE.push({ x: m.x, y: m.y, color: m.color, ev: '', seq: String(fullE.length + 1) });
            });
            fullE.forEach(function (m) { namesE0.push(coordName(m.x, m.y)); });
            renderBalMarks(fullE, T('anBalDone').replace('{n}', String(fullE.length)).replace('{list}', namesE0.join(', ')));
            return;
          }
        }
      }
      // Fallback (engine unavailable): tengen black + the official balanced
      // opening's white-2 and black-3, winning lines excluded.
      var BOOKS = (engineRule() === 2) ? BAL_RJ : BAL_FR;
      var fb = BOOKS[Math.floor(Math.random() * BOOKS.length)];
      var cyB2 = (N - 1) >> 1;
      var fbMarks = [
        { x: cyB2, y: cyB2, color: 'b', ev: '', seq: '1' },
        { x: fb[1][0], y: fb[1][1], color: 'w', ev: '', seq: '2' },
        { x: fb[2][0], y: fb[2][1], color: 'b', ev: '', seq: '3' },
      ];
      renderBalMarks(fbMarks, T('anBalDone').replace('{n}', '3').replace('{list}', fbMarks.map(function (m) { return coordName(m.x, m.y); }).join(', ')));
      return;
    }"""
js = js[:start] + new_block + js[end:]

# 2) marks: no eval score, sequence number only; hint states Blue=White, Purple=Black
old_rm = """function renderBalMarks(arr, msg) {
  G.ana.balLeft = arr.length;
  G.ana.marks = arr.map(function (m, i) {
    return { x: m.x, y: m.y, badge: m.seq, label: m.ev ? fmtEval(m.ev) : '', tier: -1, inline: true,
             col: m.color === 'b' ? null : 'rgba(70,190,255,.55)' };
  });
  G.ana.rows = arr.map(function (m, i) {
    return { i: i, badge: m.seq, coord: coordName(m.x, m.y), eval: m.ev ? fmtEval(m.ev) : '', pv: '', tier: -1 };
  });
  renderAna(msg);"""
new_rm = """function renderBalMarks(arr, msg) {
  G.ana.balLeft = arr.length;
  G.ana.marks = arr.map(function (m, i) {
    // Sequence number only - no eval score on balance marks
    return { x: m.x, y: m.y, badge: m.seq, label: '', tier: -1, inline: true,
             col: m.color === 'b' ? null : 'rgba(70,190,255,.55)' };
  });
  G.ana.rows = arr.map(function (m, i) {
    return { i: i, badge: m.seq, coord: coordName(m.x, m.y), eval: '', pv: '', tier: -1 };
  });
  renderAna(msg + T('anBalColor'));"""
if old_rm not in js:
    print("MISS renderBalMarks"); sys.exit(1)
js = js.replace(old_rm, new_rm, 1)

# 3) paint(): sequence number in the hollow upper half, no eval text
old_pt = """      if (mk.inline) {
        var mt = anaInlineMetrics(ctx, mk, mr);
        ctx.fillStyle = '#ffffff';
        if (mk.label) {
          ctx.font = '700 ' + Math.max(9, mr * 0.6) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mr * 0.48);
          ctx.font = '600 ' + Math.max(8, mr * 0.4) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mr * 0.48);
        } else {
          
          ctx.font = '700 ' + Math.max(9, mr * 0.9) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py + 0.5);
        }
        return;
      }"""
new_pt = """      if (mk.inline) {
        ctx.fillStyle = '#ffffff';
        // Sequence number only, in the hollow upper half (no eval score)
        ctx.font = '700 ' + Math.max(9, mr * 0.6) + 'px "Segoe UI",system-ui,sans-serif';
        ctx.fillText(mk.badge, px, py - mr * 0.48);
        return;
      }"""
if old_pt not in js:
    print("MISS paint inline"); sys.exit(1)
js = js.replace(old_pt, new_pt, 1)

# 4) i18n keys
old_cn = "    anBalLabel: '\u70b9\u6570',"
new_cn = "    anBalLabel: '\u70b9\u6570',\n    anBalColor: '\uff08\u84dd\u8272 = \u767d\u5b50\uff0c\u7d2b\u8272 = \u9ed1\u5b50\uff09',"
if old_cn not in js:
    print("MISS i18n cn"); sys.exit(1)
js = js.replace(old_cn, new_cn, 1)
old_en = "    anBalLabel: 'Points',"
new_en = "    anBalLabel: 'Points',\n    anBalColor: ' (Blue = White, Purple = Black)',"
if old_en not in js:
    print("MISS i18n en"); sys.exit(1)
js = js.replace(old_en, new_en, 1)

save(jp, js)
print("calc.js patched OK")
sys.exit(0)
