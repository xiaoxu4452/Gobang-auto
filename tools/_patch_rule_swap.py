# -*- coding: utf-8 -*-
# Patch runSwapBal: set engine rule before SWAP2BOARD so the opening book
# follows the active rule (renju 2 = forbidden moves).
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
src = io.open(p, encoding='utf-8').read()

old = """        var libSource = 'none';
        try {
          var s2 = await onMainLane(function () { return wsCall('swap2board', {}, 8000); });
          if (s2 && s2.pts && s2.pts.length === 3 && !isLibFallback(s2.pts) && takeLib(s2.pts))
            libSource = 'engine';
        } catch (eS2) {  }"""

new = """        var libSource = 'none';
        try {
          // The opening book follows the ACTIVE rule: the engine's SWAP2BOARD
          // must run under INFO RULE <rule> (renju 2 = forbidden moves) or it
          // falls back to the freestyle book and the opening becomes wrong.
          await onMainLane(function () {
            return engCmd('main', 'INFO RULE ' + rule).then(function () {
              return engCmd('main', 'INFO THREAD_NUM ' + (S.threads || 4));
            });
          });
          var s2 = await onMainLane(function () { return wsCall('swap2board', {}, 8000); });
          if (s2 && s2.pts && s2.pts.length === 3 && !isLibFallback(s2.pts) && takeLib(s2.pts))
            libSource = 'engine';
        } catch (eS2) {  }"""

assert old in src, "OLD BLOCK NOT FOUND"
src = src.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(src)
print("REPLACED OK")
