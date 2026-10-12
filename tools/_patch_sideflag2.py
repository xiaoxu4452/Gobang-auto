# -*- coding: utf-8 -*-
"""Fix YXBOARD side-flag mapping in engine-ai.js (its own structure)."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

old_tail = """    if (!pos) continue;
    out.push([pos[0], SIZE - 1 - pos[1], color]);
  }
  return applySideToMove(out, side);
}"""
new_tail = """    if (!pos) continue;
    // rapfi YXBOARD: color field = SELF(1)/OPPO(2) relative to the engine's
    // self color (= the side to move / AI color). Map stone color to the side
    // flag so the engine never flips perspective.
    out.push([pos[0], SIZE - 1 - pos[1], flagOf(color)]);
  }
  return out;
}"""
assert s.count(old_tail) == 1, "engine-ai tail"
s = s.replace(old_tail, new_tail)

old_anchor = """  var bs = black.slice(), ws = white.slice();
  var seq = [];"""
new_anchor = """  // The engine's self color = side to move (AI color). SELF flag = 1,
  // OPPO flag = 2. When AI plays White, White stones become SELF(1).
  var selfColor = (side === 1 || side === 2) ? side : 1;
  var flagOf = function (stone) { return stone === selfColor ? 1 : 2; };
  var bs = black.slice(), ws = white.slice();
  var seq = [];"""
assert s.count(old_anchor) == 1, "engine-ai anchor"
s = s.replace(old_anchor, new_anchor)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK engine-ai.js")
