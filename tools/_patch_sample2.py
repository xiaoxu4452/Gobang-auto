# -*- coding: utf-8 -*-
# Patch round 2: sample whiteByBody disc and rawRefine WHITE ring.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
src = io.open(p, encoding='utf-8').read()

# --- whiteByBody disc loop -> 40 angular samples ---
old_wb = """        int rr = iRound(spacing * 0.18);
        if (rr < 2) rr = 2;
        long tot = 0, bright = 0;
        for (int dy = -rr; dy <= rr; ++dy) {
            int gy = ay + dy; if (gy < 0 || gy >= h) continue;
            const uint8_t* gp = gray.ptr<uint8_t>(gy);
            int dxlim = (int)std::sqrt((double)rr * rr - (double)dy * dy);
            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                ++tot;
                if (gp[gx] > boardMed * 1.03) ++bright;
            }
        }
        if (tot <= 0 || (double)bright / (double)tot < 0.22) return EMPTY;
        return WHITE;"""
new_wb = """        int rr = iRound(spacing * 0.18);
        if (rr < 2) rr = 2;
        long tot = 0, bright = 0;
        const int NS = 40;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = rr * std::sqrt((double)((unsigned)(k * 2654435761u) % 997u) / 997.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            ++tot;
            if (gray.at<uint8_t>(py, px) > boardMed * 1.03) ++bright;
        }
        if (tot <= 0 || (double)bright / (double)tot < 0.22) return EMPTY;
        return WHITE;"""
assert old_wb in src
src = src.replace(old_wb, new_wb)

# --- rawRefine WHITE ring loop -> 48 angular samples ---
old_rr = """            int r0i = iRound(spacing * 0.34), r1i = iRound(spacing * 0.44);
            std::vector<uint8_t> vals;
            for (int dy = -r1i; dy <= r1i; ++dy) {
                int gy = ay + dy; if (gy < 0 || gy >= h) continue;
                const uint8_t* gp = gray.ptr<uint8_t>(gy);
                for (int dx = -r1i; dx <= r1i; ++dx) {
                    int gx = ax + dx; if (gx < 0 || gx >= w) continue;
                    double rad = std::hypot((double)dx, (double)dy);
                    if (rad < (double)r0i || rad > (double)r1i) continue;
                    vals.push_back(gp[gx]);
                }
            }
            if (vals.empty()) return EMPTY;"""
new_rr = """            int r0i = iRound(spacing * 0.34), r1i = iRound(spacing * 0.44);
            std::vector<uint8_t> vals; vals.reserve(48);
            const int NS = 48;
            for (int k = 0; k < NS; ++k) {
                double ang = 6.283185307179586 * (double)k / (double)NS;
                double r = r0i + (double)(r1i - r0i) * ((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
                int px = ax + (int)std::lround(std::cos(ang) * r);
                int py = ay + (int)std::lround(std::sin(ang) * r);
                if (px < 0 || px >= w || py < 0 || py >= h) continue;
                vals.push_back(gray.at<uint8_t>(py, px));
            }
            if (vals.empty()) return EMPTY;"""
assert old_rr in src
src = src.replace(old_rr, new_rr)

io.open(p, 'w', encoding='utf-8', newline='').write(src)
print("patch2 OK")
