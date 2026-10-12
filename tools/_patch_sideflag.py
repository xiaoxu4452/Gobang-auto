# -*- coding: utf-8 -*-
"""Fix YXBOARD side-flag mapping in bridge.js and engine-ai.js.

rapfi YXBOARD color field is SELF(1)/OPPO(2) relative to the engine's self
color (= side to move). The old code passed the raw stone color (1=black,
2=white), which flips the perspective whenever the engine plays White.
"""
import io, re

def patch(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        s = f.read()

    # 1) toEngineMoveList: map stone color -> side flag
    old_tail = """          if (!pos) continue;
          out.push([pos[0], SIZE - 1 - pos[1], color]);
        }
        return applySideToMove(out, side);
      }"""
    new_tail = """          if (!pos) continue;
          // rapfi YXBOARD: color field = SELF(1)/OPPO(2) relative to the
          // engine's self color (= the side to move / AI color). Map stone
          // color to the side flag so the engine never flips perspective.
          out.push([pos[0], SIZE - 1 - pos[1], flagOf(color)]);
        }
        return out;
      }"""
    assert s.count(old_tail) == 1, (path, "toEngineMoveList tail")
    s = s.replace(old_tail, new_tail)

    # 2) insert selfColor/flagOf before the out-building loop
    old_anchor = "        var bs = black.slice(), ws = white.slice();"
    new_anchor = """        // The engine's self color = side to move (AI color). SELF flag = 1,
        // OPPO flag = 2. When AI plays White, White stones become SELF(1).
        var selfColor = (side === 1 || side === 2) ? side : 1;
        var flagOf = function (stone) { return stone === selfColor ? 1 : 2; };
        var bs = black.slice(), ws = white.slice();"""
    assert s.count(old_anchor) == 1, (path, "anchor")
    s = s.replace(old_anchor, new_anchor)

    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    print("OK", path)

patch(r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js")
patch(r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js")
