# -*- coding: utf-8 -*-
# Find main-window (non-link) scan/recognize records in trainer log.
import io, os, re
p = os.path.join(os.environ['TEMP'], 'GomokuTrainer.log')
sz = os.path.getsize(p)
with io.open(p, 'rb') as f:
    f.seek(max(0, sz - 400000))
    data = f.read()
txt = data.decode('utf-8', 'replace')
lines = txt.split('\n')
hits = []
for i, ln in enumerate(lines):
    if '[link-scan]' in ln or '[link]' in ln or '[link-bridge]' in ln:
        continue
    if re.search(r'scan|recognize|/scan|8975|locked|geometry|region', ln, re.I):
        hits.append(ln[:160])
print('non-link scan/recognize lines:', len(hits))
for h in hits[-40:]:
    print(h)
