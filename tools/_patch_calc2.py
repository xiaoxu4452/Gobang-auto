# -*- coding: utf-8 -*-
# Patch calc.js phase-2: bindings, i18n apply, clear-marks host off,
# link window Points button + hidden __gb_balpoint + observer sync.
import io, sys

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
with io.open(p, "r", encoding="utf-8-sig") as f:
    s = f.read()

edits = []

# P16: i18n apply
edits.append((
"""    els.btn_an_bal1.textContent = d.anBal1;
    els.btn_an_bal2.textContent = d.anBal2;""",
"""    els.btn_an_bal.textContent = d.anBal;
    if (els.btn_an_baln) { els.btn_an_baln.textContent = '\u00d7' + balPN(); els.btn_an_baln.title = d.anBalnHint; }""", False))

# P17: bindings
edits.append((
"""  els.btn_an_bal1.onclick = function () { anaBal1(); };
  els.btn_an_bal2.onclick = function () { anaBal2(); };""",
"""  els.btn_an_bal.onclick = function () { anaBalPoints(); };
  els.btn_an_baln.onclick = function () {
    var n = balPN(); n = (n % 6) + 1;
    try { localStorage.setItem('gb_bal_point_n', String(n)); } catch (e) {}
    els.btn_an_baln.textContent = '\u00d7' + n;
    toast(T('anBalnSet').replace('{n}', String(n)));
  };""", False))

# P18: linkBalance kind replay -> new button
edits.append((
"""      if (m.kind === 'bal2') { if (els.btn_an_bal2) els.btn_an_bal2.click(); }
      else { if (els.btn_an_bal1) els.btn_an_bal1.click(); }""",
"""      if (m.kind === 'bal' || m.kind === 'bal1' || m.kind === 'bal2') { if (els.btn_an_bal) els.btn_an_bal.click(); }""", False))

# P19: link window Points button between bal and eval
edits.append((
"""          '<button id="lk_bal" class="btn">' + lkL('\u4ea4\u6362\u5e73\u8861\u70b9', 'Swap Balance') + '</button>' +
          '<button id="lk_eval" class="btn">' + lkL('\u4ea4\u6362\u8bc4\u4f30', 'Swap Eval') + '</button>' +""",
"""          '<button id="lk_bal" class="btn">' + lkL('\u4ea4\u6362\u5e73\u8861\u70b9', 'Swap Balance') + '</button>' +
          '<button id="lk_baln" class="btn" title="' + lkL('\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09', 'Balance point count (1-6, 3 fixed on empty board)') + '">\u00d72</button>' +
          '<button id="lk_eval" class="btn">' + lkL('\u4ea4\u6362\u8bc4\u4f30', 'Swap Eval') + '</button>' +""", False))

# P20: hidden __gb_balpoint button
edits.append((
"""      '<button id="__gb_swbal"></button><button id="__gb_sweval"></button>' +""",
"""      '<button id="__gb_swbal"></button><button id="__gb_balpoint"></button><button id="__gb_sweval"></button>' +""", False))

# P21: observer sync for the Points button
edits.append((
"""        var srcAC = document.getElementById('__gb_adcount'), dstAC = document.getElementById('lk_adcount');
        if (srcAC && dstAC) {
          dstAC.textContent = srcAC.textContent;
          new MutationObserver(function () { dstAC.textContent = srcAC.textContent; })
            .observe(srcAC, { childList: true, characterData: true, subtree: true });
          dstAC.onclick = function () { srcAC.click(); };
        }""",
"""        var srcAC = document.getElementById('__gb_adcount'), dstAC = document.getElementById('lk_adcount');
        if (srcAC && dstAC) {
          dstAC.textContent = srcAC.textContent;
          new MutationObserver(function () { dstAC.textContent = srcAC.textContent; })
            .observe(srcAC, { childList: true, characterData: true, subtree: true });
          dstAC.onclick = function () { srcAC.click(); };
        }
        var srcBP = document.getElementById('__gb_balpoint'), dstBP = document.getElementById('lk_baln');
        if (srcBP && dstBP) {
          dstBP.textContent = srcBP.textContent;
          new MutationObserver(function () { dstBP.textContent = srcBP.textContent; })
            .observe(srcBP, { childList: true, characterData: true, subtree: true });
          dstBP.onclick = function () { srcBP.click(); };
        }""", False))

# P22: clearAllMarks -> also turn host balance overlay off
edits.append((
"""function clearAllMarks() {
  fwdClearMarks();                          
  anaReset();                               
  G.ana.defCells = null;                    
  G.ana.autoDefend = false;                 
  paint();
  toast(T('markCleared'));
}""",
"""function clearAllMarks() {
  fwdClearMarks();                          
  anaReset();                               
  G.ana.defCells = null;                    
  G.ana.autoDefend = false;                 
  try { tellHost({ type: 'balance', on: false }); } catch (e) {}
  paint();
  toast(T('markCleared'));
}""", False))

ok = True
for i, (old, new, repl_all) in enumerate(edits):
    if old not in s:
        print("MISS #%d" % (i + 1)); ok = False; continue
    c = s.count(old)
    if c != 1 and not repl_all:
        print("AMB #%d count=%d" % (i + 1, c)); ok = False; continue
    s = s.replace(old, new) if repl_all else s.replace(old, new, 1)

if not ok:
    sys.exit(1)

with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    f.write(s)
print("calc.js phase-2 patched OK")
