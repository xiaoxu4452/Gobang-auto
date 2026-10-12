# -*- coding: utf-8 -*-
"""Restore the mature view logic proven in desktop-overlay / 4.381:
stone color passed verbatim (1=black 2=white) + applySideToMove tail
adjustment so the engine's side-to-move equals our side. Remove the
SELF/OPPO remap that broke all rules."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

old_block = """      function toEngineMoveList(board, moveList, side) {
        var black = [], white = [];
        for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
          if (board[y][x] === 1) black.push([x, y]);
          else if (board[y][x] === 2) white.push([x, y]);
        }
        var usableList = Array.isArray(moveList) && moveList.length > 0;
        function mkPick() { return { used: {} }; }
        var pickState = usableList ? mkPick() : null;
        function pick(color) {
          if (!usableList) return null;
          for (var mi = 0; mi < moveList.length; mi++) {
            var m = moveList[mi];
            if (m && typeof m.x === 'number' && typeof m.y === 'number' &&
                board[m.y] && board[m.y][m.x] === color) {
              var key = m.x + ',' + m.y;
              if (!pickState.used[key]) { pickState.used[key] = 1; return [m.x, m.y]; }
            }
          }
          return null;
        }
        // The engine's self color = side to move (AI color). SELF flag = 1,
        // OPPO flag = 2. When AI plays White, White stones become SELF(1).
        var selfColor = (side === 1 || side === 2) ? side : 1;
        var flagOf = function (stone) { return stone === selfColor ? 1 : 2; };
        var bs = black.slice(), ws = white.slice();
        var seq = [];
        var maxLen = Math.max(bs.length, ws.length);
        for (var i2 = 0; i2 < maxLen; i2++) {
          if (i2 < bs.length) seq.push(1);
          if (i2 < ws.length) seq.push(2);
        }
        var out = [];
        for (var si = 0; si < seq.length; si++) {
          var color = seq[si];
          var pos = usableList ? pick(color) : null;
          if (!pos) pos = (color === 1 ? bs.shift() : ws.shift());
          else {
            var src = (color === 1 ? bs : ws);
            for (var k = 0; k < src.length; k++) if (src[k][0] === pos[0] && src[k][1] === pos[1]) { src.splice(k, 1); break; }
          }
          if (!pos) continue;
          // rapfi YXBOARD: color field = SELF(1)/OPPO(2) relative to the
          // engine's self color (= the side to move / AI color). Map stone
          // color to the side flag so the engine never flips perspective.
          out.push([pos[0], SIZE - 1 - pos[1], flagOf(color)]);
        }
        return out;
      }"""

new_block = """      function applySideToMove(out, side) {
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
      function toEngineMoveList(board, moveList, side) {
        var black = [], white = [];
        for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
          if (board[y][x] === 1) black.push([x, y]);
          else if (board[y][x] === 2) white.push([x, y]);
        }
        var usableList = Array.isArray(moveList) && moveList.length > 0;
        function mkPick() { return { used: {} }; }
        var pickState = usableList ? mkPick() : null;
        function pick(color) {
          if (!usableList) return null;
          for (var mi = 0; mi < moveList.length; mi++) {
            var m = moveList[mi];
            if (m && typeof m.x === 'number' && typeof m.y === 'number' &&
                board[m.y] && board[m.y][m.x] === color) {
              var key = m.x + ',' + m.y;
              if (!pickState.used[key]) { pickState.used[key] = 1; return [m.x, m.y]; }
            }
          }
          return null;
        }
        var bs = black.slice(), ws = white.slice();
        var seq = [];
        var maxLen = Math.max(bs.length, ws.length);
        for (var i2 = 0; i2 < maxLen; i2++) {
          if (i2 < bs.length) seq.push(1);
          if (i2 < ws.length) seq.push(2);
        }
        var out = [];
        for (var si = 0; si < seq.length; si++) {
          var color = seq[si];
          var pos = usableList ? pick(color) : null;
          if (!pos) pos = (color === 1 ? bs.shift() : ws.shift());
          else {
            var src = (color === 1 ? bs : ws);
            for (var k = 0; k < src.length; k++) if (src[k][0] === pos[0] && src[k][1] === pos[1]) { src.splice(k, 1); break; }
          }
          if (!pos) continue;
          out.push([pos[0], SIZE - 1 - pos[1], color]);
        }
        return applySideToMove(out, side);
      }"""

assert s.count(old_block) == 1, "toEngineMoveList block"
s = s.replace(old_block, new_block)

# also engine-ai.js may carry the same SELF/OPPO mapping
p2 = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js"
try:
    s2 = io.open(p2, 'r', encoding='utf-8').read()
    old2 = """          var selfColor = (side === 1 || side === 2) ? side : 1;
          var flagOf = function (stone) { return stone === selfColor ? 1 : 2; };"""
    if s2.count(old2) == 1:
        new2 = """          // Stone colors pass verbatim; tail-adjust side to move.
          var selfColor = (side === 1 || side === 2) ? side : 1;"""
        s2 = s2.replace(old2, new2)
    # fix flagOf usage in engine-ai: replace flagOf(x) with x (verbatim color)
    s2 = s2.replace('flagOf(color)', 'color')
    io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
    print("engine-ai.js patched")
except Exception as e:
    print("engine-ai skip:", e)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK verbatim view restored")
