# -*- coding: utf-8 -*-
"""engine-ai.js: drop dead selfColor/flagOf, route return through applySideToMove."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js"
s = io.open(p, 'r', encoding='utf-8').read()

old1 = """  // The engine's self color = side to move (AI color). SELF flag = 1,
  // OPPO flag = 2. When AI plays White, White stones become SELF(1).
  var selfColor = (side === 1 || side === 2) ? side : 1;
  var flagOf = function (stone) { return stone === selfColor ? 1 : 2; };
  var bs = black.slice(), ws = white.slice();"""
new1 = """  // Stone colors pass verbatim (1=black, 2=white); applySideToMove tail-
  // adjusts so the engine's side-to-move equals our side.
  var bs = black.slice(), ws = white.slice();"""
assert s.count(old1) == 1, "engine-ai selfColor block"
s = s.replace(old1, new1)

old2 = """    // rapfi YXBOARD: color field = SELF(1)/OPPO(2) relative to the engine's
    // self color (= the side to move / AI color). Map stone color to the side
    // flag so the engine never flips perspective.
    out.push([pos[0], SIZE - 1 - pos[1], color]);
  }
  return out;
}"""
new2 = """    out.push([pos[0], SIZE - 1 - pos[1], color]);
  }
  return applySideToMove(out, side);
}"""
assert s.count(old2) == 1, "engine-ai return block"
s = s.replace(old2, new2)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("OK engine-ai verbatim+sideapply")
