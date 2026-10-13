# -*- coding: utf-8 -*-
# 1) calc.html: keep only rules 0/1/2 in the rule select.
# 2) calc.js: sync ruleName/ruleHint and help copy to the 3-rule set.
import io

H = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.html"
J = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"

h = io.open(H, 'r', encoding='utf-8', newline='').read()
old_opts = """            <option value="0">无禁手</option>
            <option value="1">无禁手 · 长连不赢</option>
            <option value="2">连珠（有禁手）</option>
            <option value="6">山口规则（Yamaguchi）</option>
            <option value="7">塔拉山口规则（Taraguchi）</option>
            <option value="8">塔拉尼科夫规则（Tarannikov）</option>
            <option value="5">一手交换</option>"""
new_opts = """            <option value="0">无禁手</option>
            <option value="1">无禁手 · 长连不赢</option>
            <option value="2">连珠（有禁手）</option>"""
if old_opts not in h:
    print('HTML OPTS ANCHOR MISSING'); raise SystemExit(1)
h = h.replace(old_opts, new_opts, 1)
io.open(H, 'w', encoding='utf-8', newline='').write(h)
print('calc.html rule options trimmed (0/1/2 only)')

j = io.open(J, 'r', encoding='utf-8', newline='').read()

# ruleName map: keep 0/1/2, drop 5/6/7/8.
old_rn = """    ruleName: {
      0: '无禁手', 1: '无禁手 · 长连不赢', 2: '连珠（有禁手）',
      5: '一手交换', 6: '山口规则（Yamaguchi）', 7: '塔拉山口规则（Taraguchi）',
      8: '塔拉尼科夫规则（Tarannikov）',
    },"""
new_rn = """    ruleName: {
      0: '无禁手', 1: '无禁手 · 长连不赢', 2: '连珠（有禁手）',
    },"""
if old_rn not in j:
    print('RULE_NAME ANCHOR MISSING'); raise SystemExit(1)
j = j.replace(old_rn, new_rn, 1)

# ruleHint map: keep 0/1/2.
old_rh = """    ruleHint: {
      0: '无禁手：连成五子（含长连）即胜。最自由。',
      1: '标准：长连不算赢，必须正好五子。',
      2: '连珠：黑方有禁手（三三/四四/长连），白方无禁手。',
      5: '一手交换：黑下第 1 手后，白可选择是否与黑交换颜色。',
      6: '山口规则：黑摆3子（黑1天元、白2 3×3、黑3 5×5）并声明第5手打点数；对方选色后白4任意位置，黑按声明数叫点（对称点不可重复），白挑一个落第5手。',
      7: '塔拉山口10：黑1天元、白2限3×3、黑3限5×5、白4限7×7；第5手直接下（9×9）或十打叫10点由对方挑，随后对方选色。',
      8: '塔拉尼科夫规则（Tarannikov）：三手交换加五手两打，黑1天元、白2限3×3、黑3限5×5；白4限7×7。',
    },"""
new_rh = """    ruleHint: {
      0: '无禁手：连成五子（含长连）即胜。最自由。',
      1: '标准：长连不算赢，必须正好五子。',
      2: '连珠：黑方有禁手（三三/四四/长连），白方无禁手。',
    },"""
if old_rh not in j:
    print('RULE_HINT ANCHOR MISSING'); raise SystemExit(1)
j = j.replace(old_rh, new_rh, 1)

# Help copy updates (zh).
old_h1 = "'规则：自由局（无禁手）/ 长连不赢 / 连珠（三三、四四、长连禁手）/ 一手交换 / 山口 / 塔拉山口10；前瞻与算杀都跟随所选规则。交换类规则开局会弹小窗让你选先手或后手。'"
new_h1 = "'规则：无禁手 / 无禁手 · 长连不赢 / 连珠（有禁手，黑方三三、四四、长连禁手）；前瞻与算杀都跟随所选规则。'"
if old_h1 in j:
    j = j.replace(old_h1, new_h1, 1)
    print('help zh updated')
else:
    print('help zh anchor not found (skip)')

old_h2 = "'六种规则：自由局 / 长连不赢 / 连珠禁手 / 一手交换 / 山口 / 塔拉山口10',"
new_h2 = "'三种规则：无禁手 / 无禁手 · 长连不赢 / 连珠（有禁手）',"
if old_h2 in j:
    j = j.replace(old_h2, new_h2, 1)
    print('about zh updated')
else:
    print('about zh anchor not found (skip)')

old_e1 = "'Six rules: free-style / overline-loses / Renju forbidden / Swap-1 / Yamaguchi / Taraguchi-10',"
new_e1 = "'Three rules: freestyle / overline-loses / Renju (forbidden moves)',"
if old_e1 in j:
    j = j.replace(old_e1, new_e1, 1)
    print('about en updated')
else:
    print('about en anchor not found (skip)')

io.open(J, 'w', encoding='utf-8', newline='').write(j)
print('calc.js rule maps + help copy trimmed')
