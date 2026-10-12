# -*- coding: utf-8 -*-
# Inspect trainer log: find main-window (non-link) scan records to confirm the
# main UI recognition path (host push vs 900ms tick polling).
import io, os, re
p = os.path.join(os.environ['TEMP'], 'GomokuTrainer.log')
sz = os.path.getsize(p)
with io.open(p, 'rb') as f:
    f.seek(max(0, sz - 300000))  # last 300KB
    data = f.read()
txt = data.decode('utf-8', 'replace')
lines = txt.split('\n')

keys = ['[scan]', '[main]', '[ui-scan]', '[bridge]', 'tick', 'recognize', 'code=200', '[link-scan]', '[engine]', 'startup', 'boot', 'webview', 'created', 'Window created']
# count prefix tags
from collections import Counter
tags = Counter()
for ln in lines:
    m = re.match(r'^\[?(\d\d:\d\d:\d\d\.\d\d\d)\]?\s+\[([a-z0-9\-_ ]+)\]', ln)
    if m:
        tags[m.group(2)] += 1
for k, v in sorted(tags.items(), key=lambda x: -x[1])[:25]:
    print('%-24s %d' % (k, v))
