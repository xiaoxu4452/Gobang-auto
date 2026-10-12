# -*- coding: utf-8 -*-
# Adjust: coloredMarked keeps its original center-disc check (corner logo
# covers the disc; no outer annulus requirement), only redMarked gains the
# outer-annulus test (cross arms extend outside the disc, red move numbers
# printed on a stone stay inside).
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    src = f.read()

old = """    auto coloredMarked = [&](int ax, int ay) -> bool {
        return rawColoredFrac(ax, ay, 0.44) >= 0.18 &&
               annulusColoredFrac(ax, ay, 0.44, 0.62) >= 0.06;
    };"""

new = """    auto coloredMarked = [&](int ax, int ay) -> bool {
        return rawColoredFrac(ax, ay, 0.44) >= 0.18;
    };"""

if old not in src:
    print('MISSING: coloredMarked block not found'); raise SystemExit(1)
src = src.replace(old, new, 1)

# annulusColoredFrac is now unused; remove it to keep the build clean
old2 = """    auto annulusColoredFrac = [&](int ax, int ay, double r0r, double r1r) -> double {
        int r0 = iRound(spacing * r0r), r1 = iRound(spacing * r1r);
        if (r1 < r0) r1 = r0 + 1;
        long tot = 0, hit = 0;
        for (int dy = -r1; dy <= r1; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* sp = sat.ptr<uint8_t>(gy);
            int dxlim = (int)std::sqrt((double)r1 * r1 - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                double rad = std::sqrt((double)dx * dx + (double)dy * dy);
                if (rad < (double)r0 || rad > (double)r1) continue;
                ++tot;
                if (sp[gx] > satGate) ++hit;
            }
        }
        return tot > 0 ? (double)hit / (double)tot : 0.0;
    };
"""
if old2 in src:
    src = src.replace(old2, "", 1)
    print('removed unused annulusColoredFrac')
else:
    print('annulusColoredFrac not found (may already be removed)')

with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print('patched: coloredMarked restored, redMarked keeps annulus gate')
