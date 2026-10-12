# -*- coding: utf-8 -*-
# Final color guard in gbrecognize.cpp: after arbitration, any winning board
# (adaptive/legacy/otsu) gets stones cleared on cells whose disc is dominated
# by strong color (corner logo) or a red cross with arms outside the disc.
# A red move-number printed on a stone stays inside the disc and survives.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbrecognize.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    src = f.read()

anchor = """        std::string who = arbitrate(pa, pb, pickedOut);
        diagOut.set("picked", Json::makeStr(who));
        if (!pickedOut.valid) return false;
        Json invL = invariants(pickedOut.board);"""

guard = """        std::string who = arbitrate(pa, pb, pickedOut);
        diagOut.set("picked", Json::makeStr(who));
        if (!pickedOut.valid) return false;
        // Final color guard: a stone never stands on a cell whose disc is
        // dominated by strong color (corner logo / marker), nor on a red cross
        // whose arms extend outside the disc. A colored move-number printed on
        // a stone stays inside the disc, so that stone survives.
        {
            int guardR = std::max(2, iRound(stIn * 0.44));
            int annR = std::max(guardR + 1, iRound(stIn * 0.62));
            int n = size;
            for (int j = 0; j < n; ++j) {
                for (int i = 0; i < n; ++i) {
                    if (pickedOut.board.data[j * n + i] == 0) continue;
                    int ax = iRound(xsIn[i]), ay = iRound(ysIn[j]);
                    long tot = 0, colored = 0, red = 0;
                    for (int dy = -guardR; dy <= guardR; ++dy) {
                        int gy = ay + dy; if (gy < 0 || gy >= H) continue;
                        int dxlim = (int)std::sqrt((double)guardR * guardR - (double)dy * dy);
                        const cv::Vec3b* sp = img.ptr<cv::Vec3b>(gy);
                        for (int dx = -dxlim; dx <= dxlim; ++dx) {
                            int gx = ax + dx; if (gx < 0 || gx >= W) continue;
                            ++tot;
                            int R = sp[gx][0], G = sp[gx][1], B = sp[gx][2];
                            int mx = R > G ? R : G; if (B > mx) mx = B;
                            int mn = R < G ? R : G; if (B < mn) mn = B;
                            if (mx - mn > 60) ++colored;
                            if (R > 140 && G < 110 && B < 110) ++red;
                        }
                    }
                    if (tot > 0 && (double)colored / (double)tot >= 0.18) {
                        pickedOut.board.data[j * n + i] = 0;
                        continue;
                    }
                    if (tot > 0 && (double)red / (double)tot >= 0.10) {
                        long rt = 0, rh = 0;
                        for (int dy = -annR; dy <= annR; ++dy) {
                            int gy = ay + dy; if (gy < 0 || gy >= H) continue;
                            int dxlim = (int)std::sqrt((double)annR * annR - (double)dy * dy);
                            const cv::Vec3b* sp = img.ptr<cv::Vec3b>(gy);
                            for (int dx = -dxlim; dx <= dxlim; ++dx) {
                                int gx = ax + dx; if (gx < 0 || gx >= W) continue;
                                double rad = std::sqrt((double)dx * dx + (double)dy * dy);
                                if (rad < (double)guardR || rad > (double)annR) continue;
                                ++rt;
                                int R = sp[gx][0], G = sp[gx][1], B = sp[gx][2];
                                if (R > 140 && G < 110 && B < 110) ++rh;
                            }
                        }
                        if (rt > 0 && (double)rh / (double)rt >= 0.04)
                            pickedOut.board.data[j * n + i] = 0;
                    }
                }
            }
        }
        Json invL = invariants(pickedOut.board);"""

if anchor not in src:
    print('MISSING: anchor not found'); raise SystemExit(1)
src = src.replace(anchor, guard, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print('patched: final color guard added in readFull')
