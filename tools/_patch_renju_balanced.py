# -*- coding: utf-8 -*-
# Trim RENJU_OPENINGS to balanced openings only.
# Officially 18 of the 26 RIF openings are black-win (Kagetsu/Pugetsu/Kyogetsu/
# Kosei/Suigetsu/Ungetsu/Rangetsu/Gingetsu/Meisei/Shagetsu/Meigetsu/Kansai/Keigetsu/
# Zangetsu/Kinsei/Shogetsu/Shingetsu/Sangetsu/Kyugetsu) and 2 are white-win
# (Yusei/Suisei). Keep only the 6 balanced ones: Kansai/Sosei/Zuisei (direct),
# Chosei/Ryusei/Ungetsu (diagonal).
import io, re

P = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(P, 'r', encoding='utf-8', newline='').read()

start = s.index('        // Official 26 Renju openings')
end = s.index('        var SWAP2_SYM', start)
new_block = (
"        // Official Renju (RIF) balanced openings only, rule 2 (forbidden moves).\n"
"        // 18 of the 26 RIF openings are black-forced wins and 2 (Yusei/Suisei)\n"
"        // are white wins, so they must never be offered as exchange points.\n"
"        // The 6 balanced openings (black1 tengen (7,7); white2 I9 (8,8) diagonal\n"
"        // or H9 (7,8) direct; black3 per the official table) give near-zero\n"
"        // advantage to both sides and are safe for the three-move exchange.\n"
"        var RENJU_OPENINGS = [\n"
"          // diagonal (indirect): white2 = I9 (8,8)\n"
"          [[7, 7], [8, 8], [9, 9]],   // 1. Chosei  long star  (J10, balanced)\n"
"          [[7, 7], [8, 8], [9, 5]],   // 2. Ryusei  meteor  (J6, balanced)\n"
"          [[7, 7], [8, 8], [8, 7]],   // 3. Ungetsu  cloud moon  (I8, balanced)\n"
"          // direct: white2 = H9 (7,8)\n"
"          [[7, 7], [7, 8], [7, 9]],   // 4. Kansai  cold star  (H10, balanced)\n"
"          [[7, 7], [7, 8], [9, 9]],   // 5. Sosei  sparse star  (J10, balanced)\n"
"          [[7, 7], [7, 8], [7, 5]],   // 6. Zuisei  lucky star  (H6, balanced)\n"
"        ];\n"
"        \n"
)
s = s[:start] + new_block + s[end:]
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('RENJU_OPENINGS trimmed to 6 balanced openings')
