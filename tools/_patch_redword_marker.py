# -*- coding: utf-8 -*-
# Fix: red/colored mark on a stone (e.g. red move number printed on a white
# stone) must not discard the stone. Red cross arms / colored corner logos
# extend outside the stone disc, so require outer-annulus color too.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    src = f.read()

old = """    // Colored decorations (e.g. lion corner logo over a star point) must
    // not be read as stones.
    auto coloredMarked = [&](int ax, int ay) -> bool {
        return rawColoredFrac(ax, ay, 0.44) >= 0.18;
    };
    const double RED_MARKER_MIN = 0.10;
    const int redDiscR = iRound(spacing * 0.44);
    auto redMarked = [&](int ax, int ay) -> bool {
        return redMarkerFrac(ax, ay, redDiscR) >= RED_MARKER_MIN;
    };"""

new = """    // Colored decorations (e.g. lion corner logo over a star point) and red
    // crosses / red last-move markers must not be read as stones. Their color
    // extends OUTSIDE the stone disc (cross arms, logo edge), so we require an
    // outer annulus hit as well: a colored move number printed on a stone
    // stays inside the disc and the stone is still recognized.
    auto annulusRedFrac = [&](int ax, int ay, double r0r, double r1r) -> double {
        int r0 = iRound(spacing * r0r), r1 = iRound(spacing * r1r);
        if (r1 < r0) r1 = r0 + 1;
        long tot = 0, hit = 0;
        for (int dy = -r1; dy <= r1; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const cv::Vec3b* sp = rgb.ptr<cv::Vec3b>(gy);
            int dxlim = (int)std::sqrt((double)r1 * r1 - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                double rad = std::sqrt((double)dx * dx + (double)dy * dy);
                if (rad < (double)r0 || rad > (double)r1) continue;
                ++tot;
                int R = (int)sp[gx][0], G = (int)sp[gx][1], B = (int)sp[gx][2];
                if (R > 140 && G < 110 && B < 110) ++hit;
            }
        }
        return tot > 0 ? (double)hit / (double)tot : 0.0;
    };
    auto annulusColoredFrac = [&](int ax, int ay, double r0r, double r1r) -> double {
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
    auto coloredMarked = [&](int ax, int ay) -> bool {
        return rawColoredFrac(ax, ay, 0.44) >= 0.18 &&
               annulusColoredFrac(ax, ay, 0.44, 0.62) >= 0.06;
    };
    const double RED_MARKER_MIN = 0.10;
    const int redDiscR = iRound(spacing * 0.44);
    auto redMarked = [&](int ax, int ay) -> bool {
        return redMarkerFrac(ax, ay, redDiscR) >= RED_MARKER_MIN &&
               annulusRedFrac(ax, ay, 0.44, 0.62) >= 0.04;
    };"""

if old not in src:
    print('MISSING: anchor block not found'); raise SystemExit(1)
src = src.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print('patched: annulus-gated red/colored marker check')
