# -*- coding: utf-8 -*-
"""Extract 4.381 balance caller + local book array."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

# all occurrences of swap2board
idxs = [m.start() for m in re.finditer("swap2board", s)]
print("swap2board occurrences:", idxs)

# context before first caller occurrence (idx 31278 is the impl; callers elsewhere)
# find the caller: search 'we("swap2board"'
for kw in ['we("swap2board"', 'call("swap2board"', "swap2board\""]:
    i = s.find(kw)
    print(kw, i)

# locate the main balance function by searching 'swBal' or 'balance' callers
for kw in ['balFail', "balance", "YXBALANCEONE", "YXBALANCETWO"]:
    i = s.find(kw)
    print(kw, i)

# dump the function that calls swap2board: search around first 'swBal' markers
idx = s.find('balFail')
print("\n--- around balFail (before 300 / after 800) ---")
print(s[max(0, idx-300):idx+800])

# local book array at 46015
print("\n--- around 'm=[' (46015) ---")
print(s[45800:47200])
