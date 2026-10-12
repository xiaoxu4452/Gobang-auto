# -*- coding: utf-8 -*-
"""Patch engine-ai.js: engine-side rule mapping 6/7/8 -> 2 (rapfi official)."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

def map_rule_expr(name):
    # replace the raw rule validation with a mapped version
    old = "var %s = [0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0;" % name
    new = ("var %s = (body.rule === 6 || body.rule === 7 || body.rule === 8) ? 2\n"
           "    : ([0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0);" % name)
    return old, new

for name in ("rule", "rule2"):
    old, new = map_rule_expr(name)
    if old in s:
        s = s.replace(old, new)
        print("patched", name)
    else:
        print("NOT FOUND", name)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK engine-ai.js")
