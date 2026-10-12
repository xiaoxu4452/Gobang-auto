# -*- coding: utf-8 -*-
import os, tempfile
try:
    import pymupdf
except ImportError:
    import fitz as pymupdf
OUT = r"C:\Users\harve\Desktop\Gobang auto\Meter Gomoku"
T = tempfile.gettempdir()
jobs = [(os.path.join(OUT,'米特五子棋连线 使用说明.pdf'),'mz'),
        (os.path.join(OUT,'Meter Gomoku Link User Guide.pdf'),'me')]
for pdf,pre in jobs:
    d=pymupdf.open(pdf)
    print(pre,'pages',d.page_count)
    for i,page in enumerate(d):
        pix=page.get_pixmap(matrix=pymupdf.Matrix(2,2), alpha=False)
        p=os.path.join(T, f'{pre}_{i}.png'); pix.save(p); print(p)
    d.close()
print('RENDERED')
