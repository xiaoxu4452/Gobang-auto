# -*- coding: utf-8 -*-
# Add official Renju (rule 2) 26-opening library + rule-based selection in runSwapBal.
import io

P = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(P, 'r', encoding='utf-8', newline='').read()

# 1) Insert RENJU_OPENINGS after OFFICIAL_SWAP2 block (right after its closing "];")
anchor = "          [[3, 7], [1, 8], [0, 4]],\n        ];\n"
if anchor not in s:
    print('ANCHOR1 not found'); raise SystemExit(1)

renju = (
"        // Official 26 Renju openings (RIF three-move exchange, rule 2 = forbidden\n"
"        // moves): black1 on tengen (7,7), white2 on I9 (8,8, diagonal) or H9\n"
"        // (7,8, direct), black3 per the official opening table. Two black + one\n"
"        // white; the 8-symmetry expansion below covers all board orientations.\n"
"        var RENJU_OPENINGS = [\n"
"          // diagonal (indirect): white2 = I9 (8,8)\n"
"          [[7, 7], [8, 8], [9, 9]],   // 1. Chosei  long star  (J10)\n"
"          [[7, 7], [8, 8], [9, 8]],   // 2. Kyogetsu  gorge moon  (J9)\n"
"          [[7, 7], [8, 8], [9, 7]],   // 3. Kosei  fixed star  (J8)\n"
"          [[7, 7], [8, 8], [9, 6]],   // 4. Suigetsu  water moon  (J7)\n"
"          [[7, 7], [8, 8], [9, 5]],   // 5. Ryusei  meteor  (J6)\n"
"          [[7, 7], [8, 8], [8, 7]],   // 6. Ungetsu  cloud moon  (I8)\n"
"          [[7, 7], [8, 8], [8, 6]],   // 7. Pugetsu  shore moon  (I7)\n"
"          [[7, 7], [8, 8], [8, 5]],   // 8. Rangetsu  storm moon  (I6)\n"
"          [[7, 7], [8, 8], [7, 6]],   // 9. Gingetsu  silver moon  (H7)\n"
"          [[7, 7], [8, 8], [7, 5]],   // 10. Meisei  bright star  (H6)\n"
"          [[7, 7], [8, 8], [6, 6]],   // 11. Shagetsu  slant moon  (G7)\n"
"          [[7, 7], [8, 8], [6, 5]],   // 12. Meigetsu  famous moon  (G6)\n"
"          [[7, 7], [8, 8], [5, 5]],   // 13. Suisei  comet  (F6)\n"
"          // direct: white2 = H9 (7,8)\n"
"          [[7, 7], [7, 8], [7, 9]],   // 14. Kansai  cold star  (H10)\n"
"          [[7, 7], [7, 8], [9, 9]],   // 15. Sosei  sparse star  (J10)\n"
"          [[7, 7], [7, 8], [8, 8]],   // 16. Kagetsu  flower moon  (I9)\n"
"          [[7, 7], [7, 8], [9, 8]],   // 17. Zangetsu  waning moon  (J9)\n"
"          [[7, 7], [7, 8], [9, 7]],   // 18. Kinsei  gold star  (J8)\n"
"          [[7, 7], [7, 8], [7, 6]],   // 19. Shogetsu  pine moon  (H7)\n"
"          [[7, 7], [7, 8], [9, 6]],   // 20. Shingetsu  new moon  (J7)\n"
"          [[7, 7], [7, 8], [7, 5]],   // 21. Zuisei  lucky star  (H6)\n"
"          [[7, 7], [7, 8], [8, 5]],   // 22. Sangetsu  mountain moon  (I6)\n"
"          [[7, 7], [7, 8], [8, 9]],   // 23. Keigetsu  brook moon  (I10)\n"
"          [[7, 7], [7, 8], [8, 7]],   // 24. Ugetsu  rain moon  (I8)\n"
"          [[7, 7], [7, 8], [8, 6]],   // 25. Kyugetsu  hill moon  (I7)\n"
"          [[7, 7], [7, 8], [9, 5]],   // 26. Yusei  wander star  (J6)\n"
"        ];\n"
)
s = s.replace(anchor, anchor + renju, 1)
print('RENJU_OPENINGS inserted')

# 2) Make SYM_EXPAND operate on the rule-selected pool and define OPENINGS.
old_sym = "        var SYM_EXPAND = (function () {\n          var out = [], seen = {};\n          for (var oi = 0; oi < OFFICIAL_SWAP2.length; oi++) {"
if old_sym not in s:
    print('ANCHOR2 not found'); raise SystemExit(1)
new_sym = (
"        var OPENINGS = (rule === 2) ? RENJU_OPENINGS : OFFICIAL_SWAP2;\n"
"        var SYM_EXPAND = (function () {\n          var out = [], seen = {};\n          for (var oi = 0; oi < OPENINGS.length; oi++) {"
)
s = s.replace(old_sym, new_sym, 1)

# 3) Fix inner references to OFFICIAL_SWAP2 inside SYM_EXPAND loop.
s = s.replace("var p = SWAP2_SYM[tt](OFFICIAL_SWAP2[oi][pi][0], OFFICIAL_SWAP2[oi][pi][1]);",
              "var p = SWAP2_SYM[tt](OPENINGS[oi][pi][0], OPENINGS[oi][pi][1]);", 1)

# 4) Replace the N===15 line: expand the selected pool.
old_n = "        if (N === 15 && SYM_EXPAND.length > OFFICIAL_SWAP2.length) OFFICIAL_SWAP2 = SYM_EXPAND;"
if old_n not in s:
    print('ANCHOR3 not found'); raise SystemExit(1)
new_n = "        if (N === 15 && SYM_EXPAND.length > OPENINGS.length) OPENINGS = SYM_EXPAND;"
s = s.replace(old_n, new_n, 1)

# 5) Fallback pick uses OPENINGS instead of OFFICIAL_SWAP2.
old_fb = "          if (takeLib(OFFICIAL_SWAP2[Math.floor(Math.random() * OFFICIAL_SWAP2.length)]))"
if old_fb not in s:
    print('ANCHOR4 not found'); raise SystemExit(1)
new_fb = "          if (takeLib(OPENINGS[Math.floor(Math.random() * OPENINGS.length)]))"
s = s.replace(old_fb, new_fb, 1)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('rule-based opening selection done')
