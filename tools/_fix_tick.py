# -*- coding: utf-8 -*-
# Repair corrupted tick() block: [regex]::Escape-style backslash pollution.
import io

BS = chr(92)  # backslash
P = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(P, 'r', encoding='utf-8', newline='').read()
lines = s.split('\n')

fixed = False
for idx, ln in enumerate(lines):
    if 'Locked' in ln and (BS + ' ') in ln[:14]:
        out = []
        i = 0
        n = len(ln)
        while i < n:
            ch = ln[i]
            if ch == BS and i + 1 < n:
                nxt = ln[i + 1]
                out.append('\n' if nxt == 'n' else nxt)
                i += 2
            else:
                out.append(ch)
                i += 1
        good = ''.join(out)
        lines[idx] = good
        fixed = True
        print('FIXED line', idx + 1, 'len', len(ln), '->', len(good))
        break

if not fixed:
    print('corrupt line not found')
    raise SystemExit(1)

io.open(P, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
print('written OK')
