# -*- coding: utf-8 -*-
# Patch round 10:
# - Main analysis panel: put a "点数 / Points" label right before the
#   balance-point count dropdown
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
hed = [(('          <button id="btn_an_bal" class="btn">\u5e73\u8861\u70b9</button>\n'
          '          <select id="btn_an_baln"'),
        ('          <button id="btn_an_bal" class="btn">\u5e73\u8861\u70b9</button>\n'
          '          <span class="hint" data-i18n="anBalLabel">\u70b9\u6570</span>\n'
          '          <select id="btn_an_baln"'), False)]
hs, ok1 = apply(hs, hed, "HTML")
if ok1:
    save(hp, hs); print("calc.html patched OK")

# ---------------- calc.js ----------------
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
js = load(jp)
jed = [(("    anBalnHint: '\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09',"),
        ("    anBalnHint: '\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09',\n"
         "    anBalLabel: '\u70b9\u6570',"), False),
       (("    anBalnHint: 'Balance point count (1-6, 3 fixed on empty board)',"),
        ("    anBalnHint: 'Balance point count (1-6, 3 fixed on empty board)',\n"
         "    anBalLabel: 'Points',"), False)]
js, ok2 = apply(js, jed, "JS")
if ok2:
    save(jp, js); print("calc.js patched OK")

sys.exit(0 if (ok1 and ok2) else 1)
