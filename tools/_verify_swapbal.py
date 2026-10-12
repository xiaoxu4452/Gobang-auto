# -*- coding: utf-8 -*-
import io, re
p = r'C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js'
s = io.open(p, 'r', encoding='utf-8').read()
print('SW2_OPENINGS:', len(re.findall(r'  var SW2_OPENINGS = \[', s)))
print('runSwapBal:', len(re.findall(r'  async function runSwapBal\(\) \{', s)))
print('localPairFallback:', len(re.findall(r'function localPairFallback', s)))
print('doSwap2Board(lane,body):', len(re.findall(r'function doSwap2Board\(lane, body\)', s)))
print('wsCall swap2board:', len(re.findall(r"wsCall\('swap2board'", s)))
