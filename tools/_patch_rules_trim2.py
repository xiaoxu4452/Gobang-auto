# -*- coding: utf-8 -*-
# Line-level removal of swap-rule entries in calc.js (ruleName / ruleHint / helps).
import io, re

J = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
j = io.open(J, 'r', encoding='utf-8', newline='').read()

# ruleName: remove the 5/6/7/8 lines.
pat_rn = re.compile(r"[ ]*5: '[^']*',[ ]*6: '[^']*',[ ]*7: '[^']*',\r?\n[ ]*8: '[^']*',\r?\n")
j2, n_rn = pat_rn.subn('', j, count=1)
print('ruleName lines removed:', n_rn)

# ruleHint: remove the 5/6/7/8 entries (3 lines).
pat_rh = re.compile(r"[ ]*5: '[^']*',\r?\n[ ]*6: '[^']*',\r?\n[ ]*7: '[^']*',\r?\n[ ]*8: '[^']*',\r?\n")
j2, n_rh = pat_rh.subn('', j2, count=1)
print('ruleHint lines removed:', n_rh)

# Help copy (zh + en) for the about / feature list.
rep = [
  ("'规则：自由局（无禁手）/ 长连不赢 / 连珠（三三、四四、长连禁手）/ 一手交换 / 山口 / 塔拉山口10；前瞻与算杀都跟随所选规则。交换类规则开局会弹小窗让你选先手或后手。'",
   "'规则：无禁手 / 无禁手 · 长连不赢 / 连珠（有禁手，黑方三三、四四、长连禁手）；前瞻与算杀都跟随所选规则。'"),
  ("'六种规则：自由局 / 长连不赢 / 连珠禁手 / 一手交换 / 山口 / 塔拉山口10',",
   "'三种规则：无禁手 / 无禁手 · 长连不赢 / 连珠（有禁手）',"),
  ("'Six rules: free-style / overline-loses / Renju forbidden / Swap-1 / Yamaguchi / Taraguchi-10',",
   "'Three rules: freestyle / overline-loses / Renju (forbidden moves)',"),
]
for a, b in rep:
    if a in j2:
        j2 = j2.replace(a, b, 1)
        print('help updated:', b[:30])
    else:
        print('help anchor MISSING:', a[:30])

io.open(J, 'w', encoding='utf-8', newline='').write(j2)
print('done')
