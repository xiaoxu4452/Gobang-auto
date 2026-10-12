# -*- coding: utf-8 -*-
"""Close the balance engine right after one balance/sw-eval completes:
reset swap-quiet state, tighten timeouts so nothing keeps computing."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

repl = [
    # 1) runSwapBal finally: reset quiet side too
    ("    } finally { swBusy = false; }\n  }",
     "    } finally { swBusy = false; swQuietSide = false; }\n  }"),
    # 2) runSwapEval finally: reset quiet side too
    ("    } finally { swEvalBusy = false; }\n  }",
     "    } finally { swEvalBusy = false; swQuietSide = false; }\n  }"),
    # 3) doSwap2Board guard: opening replies instantly; 4s cap
    ("            guard = setTimeout(function () { finish(false, 'swap2board timeout'); }, 8000);",
     "            guard = setTimeout(function () { finish(false, 'swap2board timeout'); }, 4000);"),
    # 4) runSwapBal SWAP2BOARD call: 4s cap
    ("            return wsCall('swap2board', { rule: rule }, 8000);",
     "            return wsCall('swap2board', { rule: rule }, 4000);"),
    # 5) renju 3-round balance: 3.5s cap per round
    ("                return wsCall('balance', renBody, 7000);",
     "                return wsCall('balance', renBody, 3500);"),
    # 6) 3-stone pair balance: tighter wait
    ("            return wsCall('balance', pairBody, pairMs + 6000);",
     "            return wsCall('balance', pairBody, pairMs + 3000);"),
    # 7) swap-eval analyze: 8s cap instead of 15s
    ("      }, 2000 + 15000);",
     "      }, 2000 + 8000);"),
]
for old, new in repl:
    c = s.count(old)
    if c != 1:
        raise SystemExit("pattern count %d != 1: %r" % (c, old[:60]))
    s = s.replace(old, new)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK balance-close patches applied")
