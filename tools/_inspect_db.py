# -*- coding: utf-8 -*-
"""Inspect rapfi.db header/structure for rule-specific openings."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\rapfi-native\rapfi.db"
data = open(p, "rb").read()
print("size:", len(data))
print("hex head:", data[:64].hex())
# look for readable strings
import re
strings = re.findall(rb"[\x20-\x7e]{4,}", data)
print("readable strings:", [s.decode('ascii', 'replace') for s in strings[:60]])
