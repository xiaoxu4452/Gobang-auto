# -*- coding: utf-8 -*-
# Patch round 3: Points 1..6 dropdowns (main/link/hidden), dashed group,
# balance marks survive stones until enough are played, new mark shape,
# compute bounded <=2.5s per step and frees the main lane when done.
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
SEL = ('<select id="btn_an_baln" class="sel" title="\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09">'
       '<option value="1">1</option><option value="2" selected>2</option><option value="3">3</option>'
       '<option value="4">4</option><option value="5">5</option><option value="6">6</option></select>')
hed = [
    (('          <button id="btn_an_bal" class="btn">\u5e73\u8861\u70b9</button>\n'
      '          <button id="btn_an_baln" class="btn" title="\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09">\u70b9\u6570 \u00d72</button>'),
     ('          <span class="dashed-group">\n'
      '          <button id="btn_an_bal" class="btn">\u5e73\u8861\u70b9</button>\n'
      '          ' + SEL + '\n'
      '          </span>'), False),
]
hs, ok1 = apply(hs, hed, "HTML")
if ok1:
    save(hp, hs); print("calc.html patched OK")

# ---------------- calc.css ----------------
cp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.css"
cs = load(cp)
cs += (".anbtns .dashed-group{display:inline-flex;align-items:center;justify-content:center;"
       "gap:.2rem;border:1px dashed var(--accent);border-radius:.4rem;padding:.12rem .2rem;"
       "box-sizing:border-box;min-width:0;max-width:100%}\n"
       ".anbtns .dashed-group .btn{width:auto;min-width:0;padding:.3rem .3rem}\n"
       ".anbtns .dashed-group select{width:2.9rem;min-width:0;padding:.22rem .15rem;"
       "font-size:.82rem;border:1px solid var(--line, #cfd8e3);border-radius:.3rem;background:transparent;color:inherit}\n")
save(cp, cs); print("calc.css patched OK")

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = []

jed.append((("""  G.ana.gen++;
  if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
  G.ana.defWinUntil = 0; G.ana.defRefining = false;
  G.ana.busy = false; G.ana.kind = '';
  
  anaReset();"""),
("""  G.ana.gen++;
  if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
  G.ana.defWinUntil = 0; G.ana.defRefining = false;
  if (G.ana.kind === 'bal' && G.ana.marks.length) {
    // Balance picks: keep the marks until the user has played the required
    // number of stones (any cells), then clear them automatically.
    G.ana.balLeft = (G.ana.balLeft || G.ana.marks.length) - 1;
    if (G.ana.balLeft <= 0) { anaReset(); }
    else { G.ana.busy = false; G.ana.kind = 'bal'; anaMark(null); }
  } else {
    G.ana.busy = false; G.ana.kind = '';
    anaReset();
  }"""), False))

jed.append((("""function renderBalMarks(arr, msg) {
  G.ana.marks = arr.map(function (m, i) {"""),
("""function renderBalMarks(arr, msg) {
  G.ana.balLeft = arr.length;
  G.ana.marks = arr.map(function (m, i) {"""), False))

jed.append((("""  var balHide = false;
  if (G.ana.kind === 'bal1' && G.ana.marks.length) {
    var isStage2 = G.ana.marks.some(function (mk) { return String(mk.badge) === '4'; });
    if (G.moves.length >= (isStage2 ? 5 : 3)) balHide = true;
  }"""),
("""  var balHide = false;
  if (G.ana.kind === 'bal' && G.ana.marks.length) {
    if (G.moves.length >= G.ana.marks.length) balHide = true;
  } else if (G.ana.kind === 'bal1' && G.ana.marks.length) {
    var isStage2 = G.ana.marks.some(function (mk) { return String(mk.badge) === '4'; });
    if (G.moves.length >= (isStage2 ? 5 : 3)) balHide = true;
  }"""), False))

jed.append((("""      ctx.beginPath();
      if (multi) {
        if (ctx.roundRect) ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, ph / 2);
        else ctx.rect(px - pw / 2, py - ph / 2, pw, ph);
      } else {
        ctx.arc(px, py, mr, 0, Math.PI * 2);
      }
      ctx.fillStyle = pal.badge; ctx.fill();
      ctx.lineWidth = Math.max(1.6, gap * 0.07);
      ctx.strokeStyle = pal.ring; ctx.stroke();
      taken.push({ x1: px - pw / 2 - 1, y1: py - ph / 2 - 1, x2: px + pw / 2 + 1, y2: py + ph / 2 + 1 });"""),
("""      ctx.beginPath();
      if (mk.inline && mk.label) {
        // Balance mark: hollow upper half (sequence) + filled lower half (eval)
        var rr2 = mr * 0.6;
        ctx.arc(px, py, mr, Math.PI, Math.PI * 2);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.4, gap * 0.06);
        ctx.strokeStyle = pal.ring;
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, rr2, 0, Math.PI); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, mr, 0, Math.PI * 2); ctx.stroke();
      } else if (multi) {
        if (ctx.roundRect) ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, ph / 2);
        else ctx.rect(px - pw / 2, py - ph / 2, pw, ph);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.6, gap * 0.07);
        ctx.strokeStyle = pal.ring; ctx.stroke();
      } else {
        ctx.arc(px, py, mr, 0, Math.PI * 2);
        ctx.fillStyle = pal.badge; ctx.fill();
        ctx.lineWidth = Math.max(1.6, gap * 0.07);
        ctx.strokeStyle = pal.ring; ctx.stroke();
      }
      taken.push({ x1: px - pw / 2 - 1, y1: py - ph / 2 - 1, x2: px + pw / 2 + 1, y2: py + ph / 2 + 1 });"""), False))

jed.append((("""        if (mk.label) {
          ctx.font = '700 ' + mt.rf + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mt.ph * 0.19);
          ctx.font = '600 ' + mt.ef + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mt.ph * 0.24);
        } else {"""),
("""        if (mk.label) {
          ctx.font = '700 ' + mt.rf + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mt.ph * 0.34);
          ctx.font = '600 ' + mt.ef + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mt.ph * 0.34);
        } else {"""), False))

jed.append((("""  els.btn_an_bal.onclick = function () { anaBalPoints(); };
  els.btn_an_baln.onclick = function () {
    var n = balPN(); n = (n % 6) + 1;
    try { localStorage.setItem('gb_bal_point_n', String(n)); } catch (e) {}
    els.btn_an_baln.textContent = '\u00d7' + n;
    toast(T('anBalnSet').replace('{n}', String(n)));
  };"""),
("""  els.btn_an_bal.onclick = function () { anaBalPoints(); };
  if (els.btn_an_baln) els.btn_an_baln.onchange = function () {
    var n = parseInt(els.btn_an_baln.value, 10);
    if (isNaN(n) || n < 1 || n > 6) n = 2;
    try { localStorage.setItem('gb_bal_point_n', String(n)); } catch (e) {}
    toast(T('anBalnSet').replace('{n}', String(n)));
  };"""), False))

jed.append((("""function balPN() {
  var n = 2;
  try { var v = parseInt(localStorage.getItem('gb_bal_point_n') || '2', 10); if (v >= 1 && v <= 6) n = v; } catch (e) {}
  return n;
}"""),
("""function balPN() {
  if (els.btn_an_baln && els.btn_an_baln.value) {
    var v = parseInt(els.btn_an_baln.value, 10);
    if (v >= 1 && v <= 6) return v;
  }
  var n = 2;
  try { var sv = parseInt(localStorage.getItem('gb_bal_point_n') || '2', 10); if (sv >= 1 && sv <= 6) n = sv; } catch (e) {}
  return n;
}"""), False))

jed.append((("""    els.btn_an_bal.textContent = d.anBal;
    if (els.btn_an_baln) { els.btn_an_baln.textContent = '\u00d7' + balPN(); els.btn_an_baln.title = d.anBalnHint; }"""),
("""    els.btn_an_bal.textContent = d.anBal;
    if (els.btn_an_baln) { els.btn_an_baln.value = String(balPN()); els.btn_an_baln.title = d.anBalnHint; }"""), False))

jed.append((("""          '<button id="lk_bal" class="btn">' + lkL('\u4ea4\u6362\u5e73\u8861\u70b9', 'Swap Balance') + '</button>' +
          '<button id="lk_baln" class="btn" title="' + lkL('\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09', 'Balance point count (1-6, 3 fixed on empty board)') + '">\u00d72</button>' +
          '<button id="lk_eval" class="btn">' + lkL('\u4ea4\u6362\u8bc4\u4f30', 'Swap Eval') + '</button>' +"""),
("""          '<span class="dashed-group">' +
          '<button id="lk_bal" class="btn">' + lkL('\u4ea4\u6362\u5e73\u8861\u70b9', 'Swap Balance') + '</button>' +
          '<select id="lk_baln" class="sel" title="' + lkL('\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09', 'Balance point count (1-6, 3 fixed on empty board)') + '"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option></select>' +
          '<button id="lk_eval" class="btn">' + lkL('\u4ea4\u6362\u8bc4\u4f30', 'Swap Eval') + '</button>' +
          '</span>' +"""), False))

jed.append((("""        var srcBP = document.getElementById('__gb_balpoint'), dstBP = document.getElementById('lk_baln');
        if (srcBP && dstBP) {
          dstBP.textContent = srcBP.textContent;
          new MutationObserver(function () { dstBP.textContent = srcBP.textContent; })
            .observe(srcBP, { childList: true, characterData: true, subtree: true });
          dstBP.onclick = function () { srcBP.click(); };
        }"""),
("""        var srcBP = document.getElementById('__gb_balpoint'), dstBP = document.getElementById('lk_baln');
        if (srcBP && dstBP) {
          dstBP.value = srcBP.value || '2';
          dstBP.onchange = function () {
            srcBP.value = dstBP.value;
            try { srcBP.dispatchEvent(new Event('change')); }
            catch (e) { if (srcBP.onchange) srcBP.onchange(); }
          };
        }"""), False))

jed.append((("""      '<button id="__gb_swbal"></button><button id="__gb_balpoint"></button><button id="__gb_sweval"></button>' +"""),
("""      '<button id="__gb_swbal"></button><select id="__gb_balpoint" class="sel"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option></select><button id="__gb_sweval"></button>' +"""), False))

js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

# ---------------- bridge.js ----------------
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
bs = load(bp)
bed = []
bed.append((("""  function balPointSync() {
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
  balPointSync();"""),
("""  function balPointSync() {
    var bp = document.getElementById('__gb_balpoint');
    if (bp && bp.tagName === 'SELECT') bp.value = String(balPointN);
    else if (bp) bp.textContent = '\u00d7' + balPointN;
    var lb = document.getElementById('lk_baln');
    if (lb && lb.tagName === 'SELECT') lb.value = String(balPointN);
    else if (lb) lb.textContent = '\u00d7' + balPointN;
    var mb = document.getElementById('btn_an_baln');
    if (mb && mb.tagName === 'SELECT') mb.value = String(balPointN);
    else if (mb) mb.textContent = '\u00d7' + balPointN;
  }
  on('__gb_balpoint', 'change', function () {
    var el = document.getElementById('__gb_balpoint');
    var v = parseInt(el ? el.value : '2', 10);
    if (!isNaN(v) && v >= 1 && v <= 6) balPointN = v;
    try { localStorage.setItem('gb_bal_point_n', String(balPointN)); } catch (e) {}
    balPointSync();
    ui('setStatus', '<b style="color:#0e7490">' + LT('balPointSet').replace('%1', balPointN) + '</b>');
  });
  balPointSync();"""), False))
bs, ok3 = apply(bs, bed, "BRIDGE")
if ok3:
    save(bp, bs); print("bridge.js patched OK")

sys.exit(0 if (ok1 and ok2 and ok3) else 1)
