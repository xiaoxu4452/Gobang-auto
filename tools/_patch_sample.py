# -*- coding: utf-8 -*-
# Patch: replace full-pixel ring/disc region scans with uniform angular sampling.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
src = io.open(p, encoding='utf-8').read()
start = src.index("    auto rawMedDisc = [&](int ax, int ay, double rfrac) -> double {")
end = src.index("    auto coloredMarked = [&](int ax, int ay) -> bool {")

new_block = '''    // Uniform angular sampling statistics: full ring/disc pixel loops are
    // replaced by ~48 angular samples. The median is robust to sampling and
    // color/red fractions become binomial estimates with n>=40, so the same
    // decision thresholds hold while per-cell cost drops ~5-8x.
    auto rawMedDisc = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        std::vector<uint8_t> vals; vals.reserve(48);
        const int NS = 48;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = rr * std::sqrt((double)((unsigned)(k * 2654435761u) % 997u) / 997.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            vals.push_back(gray.at<uint8_t>(py, px));
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    
    auto rawMedRing = [&](int ax, int ay, double r0frac, double r1frac) -> double {
        int r0 = iRound(spacing * r0frac), r1 = iRound(spacing * r1frac);
        if (r1 < 3) r1 = 3;
        if (r0 >= r1) r0 = r1 - 1;
        std::vector<uint8_t> vals; vals.reserve(48);
        const int NS = 48;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = r0 + (double)(r1 - r0) * ((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            vals.push_back(gray.at<uint8_t>(py, px));
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    
    auto rawSatDisc = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        std::vector<uint8_t> vals; vals.reserve(48);
        const int NS = 48;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = rr * std::sqrt((double)((unsigned)(k * 2654435761u) % 997u) / 997.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            vals.push_back(sat.at<uint8_t>(py, px));
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    
    auto rawSatRing = [&](int ax, int ay, double r0frac, double r1frac) -> double {
        int r0 = iRound(spacing * r0frac), r1 = iRound(spacing * r1frac);
        if (r1 < 3) r1 = 3;
        if (r0 >= r1) r0 = r1 - 1;
        std::vector<uint8_t> vals; vals.reserve(48);
        const int NS = 48;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = r0 + (double)(r1 - r0) * ((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            vals.push_back(sat.at<uint8_t>(py, px));
        }
        return vals.empty() ? 255.0 : (double)median(vals);
    };
    
    auto rawColoredFrac = [&](int ax, int ay, double rfrac) -> double {
        int rr = iRound(spacing * rfrac);
        if (rr < 2) rr = 2;
        long tot = 0, colored = 0;
        const int NS = 40;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = rr * std::sqrt((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            ++tot;
            if (sat.at<uint8_t>(py, px) > satGate) ++colored;
        }
        return tot > 0 ? (double)colored / (double)tot : 0.0;
    };
    

    // Red cross / red last-move marker: strong red pixels must never be read
    // as a black stone. Returns fraction of strong red inside the disc.
    auto redMarkerFrac = [&](int ax, int ay, int rr) -> double {
        if (rr < 2) rr = 2;
        long tot = 0, red = 0;
        const int NS = 40;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = rr * std::sqrt((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            ++tot;
            const cv::Vec3b& v = rgb.at<cv::Vec3b>(py, px);
            int R = (int)v[0], G = (int)v[1], B = (int)v[2];
            if (R > 140 && G < 110 && B < 110) ++red;
        }
        return tot > 0 ? (double)red / (double)tot : 0.0;
    };
    // Colored decorations (e.g. lion corner logo over a star point) and red
    // crosses / red last-move markers must not be read as stones. Their color
    // extends OUTSIDE the stone disc (cross arms, logo edge), so we require an
    // outer annulus hit as well: a colored move number printed on a stone
    // stays inside the disc and the stone is still recognized.
    auto annulusRedFrac = [&](int ax, int ay, double r0r, double r1r) -> double {
        int r0 = iRound(spacing * r0r), r1 = iRound(spacing * r1r);
        if (r1 < r0) r1 = r0 + 1;
        long tot = 0, hit = 0;
        const int NS = 48;
        for (int k = 0; k < NS; ++k) {
            double ang = 6.283185307179586 * (double)k / (double)NS;
            double r = r0 + (double)(r1 - r0) * ((double)((unsigned)(k * 2654435761u) % 1009u) / 1009.0);
            int px = ax + (int)std::lround(std::cos(ang) * r);
            int py = ay + (int)std::lround(std::sin(ang) * r);
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            ++tot;
            const cv::Vec3b& v = rgb.at<cv::Vec3b>(py, px);
            int R = (int)v[0], G = (int)v[1], B = (int)v[2];
            if (R > 140 && G < 110 && B < 110) ++hit;
        }
        return tot > 0 ? (double)hit / (double)tot : 0.0;
    };
'''

src = src[:start] + new_block + src[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(src)
print("replaced OK; new len:", len(src))
