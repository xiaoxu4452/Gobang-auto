# -*- coding: utf-8 -*-
import io, os
p = os.path.join(os.environ['TEMP'], 'GomokuTrainer.log')
sz = os.path.getsize(p)
with io.open(p, 'rb') as f:
    f.seek(max(0, sz - 6000))
    data = f.read()
txt = data.decode('utf-8', 'replace')
print('SIZE', sz)
print(txt[-5000:])
