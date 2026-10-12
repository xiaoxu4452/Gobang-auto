# -*- coding: utf-8 -*-
"""Remove the duplicated applySideToMove (keep the original one at L519)."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(p, 'r', encoding='utf-8').read()

dup = """      function applySideToMove(out, side) {
        // The engine always sees the FIRST stone as BLACK (its self color).
        // Stone colors are passed verbatim (1=black, 2=white). To make the
        // engine's side-to-move equal OUR side, ensure the LAST stone of the
        // sequence is the OPPONENT's color (the one we just played).
        if (side !== 1 && side !== 2) return out;
        if (!out.length) return out;
        var wantLast = 3 - side;
        if (out[out.length - 1][2] === wantLast) return out;
        var idx = -1;
        for (var i = out.length - 1; i >= 1; i--) { if (out[i][2] === wantLast) { idx = i; break; } }
        if (idx < 0) return out;
        var m = out.splice(idx, 1)[0];
        out.push(m);
        return out;
      }
      function toEngineMoveList(board, moveList, side) {"""

assert s.count(dup) == 1, "dup block"
s = s.replace(dup, "      function toEngineMoveList(board, moveList, side) {")
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("OK dup removed")
