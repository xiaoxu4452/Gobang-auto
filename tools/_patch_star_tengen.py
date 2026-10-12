# -*- coding: utf-8 -*-
# Extend fixed-point marker immunity to include the tengen (7,7): the app draws
# a small cross marker on 4 star points + tengen; on some (older) machines the
# screenshot makes these read as stones. Clear low-confidence dark blobs there
# (a real stone on a star/tengen keeps high confidence and survives).
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

old = """    if (n == 15) {
        static const int starPts[4][2] = {{3,3},{3,11},{11,3},{11,11}};
        for (const auto& sp : starPts) {
            int c = sp[0], r = sp[1];
            if (board.at<int8_t>(r, c) != BLACK) continue;
            if (conf.at<float>(r, c) >= 0.55f) continue;
            board.at<int8_t>(r, c) = EMPTY;
            conf.at<float>(r, c) = 0.f;
        }
    }"""
new = """    if (n == 15) {
        // Star points + tengen: a low-confidence dark blob there is the app's
        // cross marker (some machines render it stone-like), not a stone.
        static const int starPts[5][2] = {{3,3},{3,11},{11,3},{11,11},{7,7}};
        for (const auto& sp : starPts) {
            int c = sp[0], r = sp[1];
            if (board.at<int8_t>(r, c) != BLACK) continue;
            if (conf.at<float>(r, c) >= 0.55f) continue;
            board.at<int8_t>(r, c) = EMPTY;
            conf.at<float>(r, c) = 0.f;
        }
    }"""
if old not in s:
    print("MISSING: starPts block"); raise SystemExit(1)
s = s.replace(old, new, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("starPts extended with tengen (7,7)")
