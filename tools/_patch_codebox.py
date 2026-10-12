# -*- coding: utf-8 -*-
# Position-code box: single-line input -> 5-row scrollable textarea.
import io

base = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui"

# html
p = base + r"\calc.html"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()
old = '<input id="inp_code" spellcheck="false" placeholder="h8h9g7…" data-tip="codeTip" title="局面代码：小写列字母 + 行号，逐手拼接（与 gomocalc.com 同格式）">'
new = '<textarea id="inp_code" rows="5" spellcheck="false" placeholder="h8h9g7…" data-tip="codeTip" title="局面代码：小写列字母 + 行号，逐手拼接（与 gomocalc.com 同格式）"></textarea>'
if old not in s:
    print("MISSING: inp_code input tag"); raise SystemExit(1)
s = s.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("calc.html -> textarea rows=5")

# css
p2 = base + r"\calc.css"
with io.open(p2, 'r', encoding='utf-8') as f:
    c = f.read()
old2 = """#inp_code{
  width:100%; font:inherit; font-size:.9rem;
  padding:.35rem .5rem; border-radius:8px; border:1px solid var(--border);
  background:var(--chip); color:var(--ink);
}"""
new2 = """#inp_code{
  width:100%; font:inherit; font-size:.9rem; line-height:1.5;
  padding:.35rem .5rem; border-radius:8px; border:1px solid var(--border);
  background:var(--chip); color:var(--ink);
  resize:vertical; min-height:5em; max-height:18em;
  overflow-y:auto; overflow-x:hidden; word-break:break-all;
}"""
if old2 not in c:
    print("MISSING: #inp_code css"); raise SystemExit(1)
c = c.replace(old2, new2, 1)
with io.open(p2, 'w', encoding='utf-8', newline='\n') as f:
    f.write(c)
print("calc.css -> 5-row scrollable textarea styles")
