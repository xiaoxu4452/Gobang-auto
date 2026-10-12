# -*- coding: utf-8 -*-
"""Deduplicate SW2 book definitions: keep one definition block + the LAST runSwapBal."""
import io, re

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

# locate all occurrences
rule_c = "  // Rule-aware balance (legacy method):"
sw2def = "  var SW2_OPENINGS = ["
bal_fn = "  async function runSwapBal() {"
swtip = "  function swTip(h) {"

rc_idxs = [m.start() for m in re.finditer(re.escape(rule_c), s)]
sw2_idxs = [m.start() for m in re.finditer(re.escape(sw2def), s)]
bal_idxs = [m.start() for m in re.finditer(re.escape(bal_fn), s)]
print("rule-aware comment:", rc_idxs)
print("SW2_OPENINGS defs:", sw2_idxs)
print("runSwapBal fns:", bal_idxs)

assert len(bal_idxs) >= 1
last_bal = bal_idxs[-1]
i1 = s.find(swtip, last_bal)
assert i1 > last_bal

# keep definition block: from FIRST rule-aware comment through its localPairFallback end
first_rc = rc_idxs[0]
def_end_anchor = "    var first = near(toBlack ? 1 : 2);"
# the first block ends right before the next rule-aware comment or runSwapBal
next_rc = rc_idxs[1] if len(rc_idxs) > 1 else None
if next_rc is None:
    # only one block; nothing to dedupe
    print("single block, nothing to dedupe")
else:
    keep = s[first_rc:next_rc]
    print("keep block len:", len(keep))
    # rebuild: keep block + last runSwapBal function (through swTip)
    bal_body = s[last_bal:i1]
    new_s = s[:first_rc] + keep + bal_body + s[i1:]
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(new_s)
    print("deduped OK, new len:", len(new_s))
