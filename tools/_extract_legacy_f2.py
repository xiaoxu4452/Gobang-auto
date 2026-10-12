# -*- coding: utf-8 -*-
"""Locate legacy move-list builder any form."""
import io, re

p = r"C:\hestory\Meter Gomoku4.381\Meter Gomoku\calc\bridge.dec.js"
s = io.open(p, 'r', encoding='utf-8').read()

# any assignment of f / function with 3 args near board building
for m in re.finditer(r'(?:\bf\s*=\s*function|\bvar\s+f\s*=\s*function|\bfunction\s+f\b)', s):
    a = max(0, m.start()-40); b = min(len(s), m.start()+900)
    print("\n=== f @", m.start(), "===\n", s[a:b])

# search color emission like ,1 or ,2 after coordinates: pattern "push([a-b,[c-d],[1-2]]"
for m in re.finditer(r'push\(\[[^\]\[]{0,40},[12]\]\)', s):
    a = max(0, m.start()-150); b = min(len(s), m.end()+40)
    print("\n=== push-arr @", m.start(), "===\n", s[a:b])
    if m.start() > 60000:
        break
