# -*- coding: utf-8 -*-
import io, re
for p in [r'C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js',
          r'C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\engine-ai.js']:
    s = io.open(p, 'r', encoding='utf-8').read()
    print(p.split('\\')[-1])
    print('  flagOf def:', len(re.findall(r'var flagOf = function', s)))
    print('  flagOf use:', len(re.findall(r'flagOf\(color\)', s)))
    print('  applySideToMove call:', len(re.findall(r'return applySideToMove\(out, side\);', s)))
    print('  selfColor:', len(re.findall(r'var selfColor = \(side', s)))
