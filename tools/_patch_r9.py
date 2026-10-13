# -*- coding: utf-8 -*-
# Patch round 9:
# - Link window: remove the balance-point count dropdown; the swap-rule
#   balance reverts to yesterday's fixed logic - empty board = 3 points
#   (2 black + 1 white), second exchange = exactly 2 points (1 black +
#   1 white) offered only while the position is at 3 stones; at most the
#   5-move (3+2) opening. The Link balance path (bridge runSwapBal) stays
#   fully independent from the main board's balance picks.
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

# ---------------- bridge.js ----------------
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
bs = load(bp)
bed = []

# 1) i18n keys: swap balance limited to the 5-move opening
bed.append((("""    swBalEmpty: '空盘交换平衡计算中（1 白 + 2 黑三点组）…', swBalPair: '交换平衡计算中（1 白 + 1 黑）…',"""),
("""    swBalEmpty: '空盘交换平衡计算中（1 白 + 2 黑三点组）…', swBalPair: '交换平衡计算中（1 白 + 1 黑）…',
    swBalMax: '交换平衡点仅限开局五手（3 手 + 2 手），当前盘面已超出交换阶段',"""), False))
bed.append((("""    swBalEmpty: 'Balancing 3-point swap set (1 white + 2 black)…', swBalPair: 'Balancing swap pair (1 white + 1 black)…',"""),
("""    swBalEmpty: 'Balancing 3-point swap set (1 white + 2 black)…', swBalPair: 'Balancing swap pair (1 white + 1 black)…',
    swBalMax: 'Swap balance applies only to the 5-move opening (3 + 2); this position is past the exchange phase',"""), False))

# 2) non-empty branch: fixed 2 points, only at exactly 3 stones (5-move cap)
bed.append((("""      } else {
        
        // Any stone count: evaluate the user-selected number of balanced
        // candidate points (1..6, default 2). Each round asks the engine's
        // official balance search (YXBALANCEONE) for one point that gives
        // neither side a visible advantage, then really places it, so the
        // next round searches the updated position and point colors
        // alternate exactly like real moves.
        var need = balPointN; if (need < 1 || need > 6) need = 2;
        var bmN = boardMatrix(lastBl, lastWh);
        var plyBase = lastBl.length + lastWh.length;
        for (var qi = 0; qi < need && leftMs() > 500; qi++) {"""),
("""      } else {
        
        // Second exchange: the swap rule allows at most 5 moves (3 opening
        // stones + 2 second-exchange points, one black + one white). Points
        // are offered only while the position is exactly at 3 stones; any
        // other count is past the exchange phase.
        var bmN = boardMatrix(lastBl, lastWh);
        var plyBase = lastBl.length + lastWh.length;
        if (plyBase !== 3) {
          ui('setStatus', '<span style="color:#e67e22;">' + LT('swBalMax') + '</span>');
          return;
        }
        var need = 2;
        for (var qi = 0; qi < need && leftMs() > 500; qi++) {"""), False))

bs, ok1 = apply(bs, bed, "BRIDGE")
if ok1:
    save(bp, bs); print("bridge.js patched OK")

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

# 3) remove the balance-point count dropdown from the Link window
jed.append((("""          '<button id="lk_bal" class="btn">' + lkL('交换平衡点', 'Swap Balance') + '</button>' +
          '<select id="lk_baln" class="sel" title="' + lkL('平衡点数（1~6，空盘固定 3）', 'Balance point count (1-6, 3 fixed on empty board)') + '"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option></select>' +
"""),
("""          '<button id="lk_bal" class="btn">' + lkL('交换平衡点', 'Swap Balance') + '</button>' +
"""), False))

# 4) remove the Link <-> main dropdown sync block (dropdown deleted)
jed.append((("""        var srcBP = document.getElementById('__gb_balpoint'), dstBP = document.getElementById('lk_baln');
        if (srcBP && dstBP) {
          dstBP.value = srcBP.value || '2';
          dstBP.onchange = function () {
            srcBP.value = dstBP.value;
            try { srcBP.dispatchEvent(new Event('change')); }
            catch (e) { if (srcBP.onchange) srcBP.onchange(); }
          };
        }
"""),
(""""""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

sys.exit(0 if (ok1 and ok2) else 1)
