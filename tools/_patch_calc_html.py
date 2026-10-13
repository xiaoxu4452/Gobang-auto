# -*- coding: utf-8 -*-
# Patch calc.html: replace balance buttons with Balance picks + Points.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.html"
s = io.open(p, "r", encoding="utf-8-sig").read()
old = ('          <button id="btn_an_bal1" class="btn">\u5e73\u8861\u4e00</button>\n'
       '          <button id="btn_an_bal2" class="btn">\u5e73\u8861\u4e8c</button>')
new = ('          <button id="btn_an_bal" class="btn">\u5e73\u8861\u70b9</button>\n'
       '          <button id="btn_an_baln" class="btn" title="\u5e73\u8861\u70b9\u6570\uff081~6\uff0c\u7a7a\u76d8\u56fa\u5b9a 3\uff09">\u70b9\u6570 \u00d72</button>')
assert s.count(old) == 1, 'anchor not unique: %d' % s.count(old)
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8-sig", newline="").write(s)
print("calc.html patched OK")
