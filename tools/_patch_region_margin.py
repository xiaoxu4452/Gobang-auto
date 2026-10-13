# -*- coding: utf-8 -*-
# Widen the locked-read region margin in tick(): 1.0 cell pad per side
# (2.0 on w/h) so the vision service never clips edge stones/grid lines.
import io

P = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
s = io.open(P, 'r', encoding='utf-8', newline='').read()

old = """        var sp = boardGeo.spacing > 0 ? boardGeo.spacing : 12;
        body.geometry = { x_lines: xs, y_lines: ys, spacing: sp };
        body.region = [Math.round(x0 - sp * 0.6), Math.round(y0 - sp * 0.6),
                       Math.round(x1 - x0 + sp * 1.2), Math.round(y1 - y0 + sp * 1.2)];"""
new = """        var sp = boardGeo.spacing > 0 ? boardGeo.spacing : 12;
        body.geometry = { x_lines: xs, y_lines: ys, spacing: sp };
        // Keep at least a full cell of margin around the outer lines so the
        // vision service never clips edge stones/grid lines: 1.0 cell pad on
        // each side (2.0 on w/h).
        body.region = [Math.round(x0 - sp), Math.round(y0 - sp),
                       Math.round(x1 - x0 + 2 * sp), Math.round(y1 - y0 + 2 * sp)];"""
if old not in s:
    print('ANCHOR MISSING'); raise SystemExit(1)
s = s.replace(old, new, 1)
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('tick region margin widened to 1.0/2.0 cells')
