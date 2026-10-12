# -*- coding: utf-8 -*-
import io
p = r'C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js'
s = io.open(p, 'r', encoding='utf-8').read()
print('Path A0 renju:', 'Path A0: renju dedicated balanced opening' in s)
print('renPts loops:', s.count('desktop-swbal-r'))
print('renju rule gate:', 'if (rule === 2) {' in s)
print('len:', len(s))
